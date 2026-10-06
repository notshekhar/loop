/**
 * The `ServerConfig` the UI connects against, built from loop.
 *
 * Upstream's server sent this down the socket. Here it is assembled from
 * loop's own `catalog.list` + `auth.status`, so **the provider and model list
 * in the picker is loop's**, not a UI-side default.
 *
 * Everything is produced by DECODING a minimal object rather than by writing
 * out a literal: the schema defaults every field it can, so a config built
 * this way cannot drift from the contract as upstream adds fields.
 */
import { ServerConfig, type ServerProvider } from "@loop/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { APP_VERSION } from "../../branding.ts";
import { resolveModelAttachmentSupport } from "../modelAttachments.ts";
import { providerPresentation, rememberCustomProviderShapes } from "../providers/index.ts";
import { detectEditors } from "./editors.ts";
import { toInstanceId } from "./ids.ts";
import { loopCall } from "../transport.ts";

/**
 * Shapes loop's RPC actually returns; measured against a live `loop serve`,
 * not guessed from the contract. Two of these are easy to get wrong:
 * `catalog.list` is a FLAT list of models (grouped here by `provider`), and
 * `auth.status` is arrays of provider ids, not objects.
 */
interface LoopCatalogModel {
  readonly id: string;
  readonly provider: string;
  readonly name?: string;
  readonly contextWindow?: number;
  readonly maxOutput?: number;
  readonly reasoning?: boolean;
  readonly available?: boolean;
  readonly modalities?: readonly string[];
}
export interface LoopServerInfo {
  readonly protocol?: string;
  readonly methods?: readonly string[];
  readonly events?: readonly string[];
  readonly defaults?: {
    /** loop's configured `defaultModel`, or null when unset. */
    readonly model?: string | null;
    /** The provider of `model` (loops older than this omit it). */
    readonly provider?: string | null;
    /** The folder the `loop rpc` process was started in. */
    readonly cwd?: string;
    /** loop's `thinkingLevel` setting — the level a turn runs at when
     * `session.send` omits `thinking`. Absent on an older loop. */
    readonly thinking?: string;
  };
}
interface LoopAuthStatus {
  /**
   * Every provider loop can RUN A TURN WITH right now — `listUsableProviders`.
   * Wider than `authorized` on purpose, and the difference is the whole
   * reason custom gateways are here: a `custom:` provider is authorized by
   * existing (its config carries its credential), so it never appears in the
   * `authorized` list, which is strictly "has an entry in the auth store".
   * Zero-login providers (ollama, bedrock) are in the same position.
   */
  readonly providers?: readonly string[];
  /** The subset holding a credential in loop's auth store. */
  readonly authorized?: readonly string[];
  /** The one currently selected. */
  readonly active?: string | null;
}

/** The slice of `auth.providers` the gateway marks need. */
interface LoopProviderDescriptor {
  readonly id: string;
  readonly kind?: "builtin" | "custom" | "extension";
  /** Custom gateways only: the vendor API shape the endpoint speaks. */
  readonly sdk?: string;
}

/**
 * The providers a turn can actually start on.
 *
 * MEASURED, and the bug it fixes: `auth.status` reports
 * `providers: [..., "custom:pronto-gpt"]` but
 * `authorized: [...builtins only]`, because a custom gateway keeps its
 * credential in its own config rather than in the auth store. Deriving
 * readiness from `authorized` therefore marked every custom gateway
 * `status: "disabled"`, and the composer's model picker drops a
 * non-`ready` instance's models outright (`isProviderInstancePickerReady`).
 * The gateway showed up in the provider rail with nothing under it — you
 * could see it and not pick it.
 */
function usableProviderIds(auth: LoopAuthStatus): ReadonlySet<string> {
  return new Set([...(auth.providers ?? []), ...(auth.authorized ?? [])]);
}

const decodeConfig = Schema.decodeUnknownEffect(ServerConfig);

// The server version is reported as the app's own — see APP_VERSION's import
// above. Anything else trips the client/server skew banner, which is
// meaningless when the UI and the agent ship as one artifact, and it must come
// from the same constant the client compares against or the banner nags about
// a version nobody can install.

function platformOs(): "darwin" | "linux" | "windows" | "unknown" {
  const ua = globalThis.navigator?.userAgent ?? "";
  if (/Windows/i.test(ua)) return "windows";
  if (/Mac OS X|Macintosh/i.test(ua)) return "darwin";
  if (/Linux|X11/i.test(ua)) return "linux";
  return "unknown";
}

function platformArch(): "arm64" | "x64" {
  const ua = globalThis.navigator?.userAgent ?? "";
  return /arm|aarch64/i.test(ua) ? "arm64" : "x64";
}

/**
 * loop's thinking levels, mirroring `packages/core/src/agent/thinking.ts`
 * (`THINKING_LEVELS` + `THINKING_LEVEL_DESCRIPTIONS`). Duplicated rather than
 * imported because this bundle is browser-only and cannot reach into core;
 * `dispatch.ts` `thinkingLevelOf` validates against the same list on the way
 * back out, so a drift here degrades to "loop uses its own setting" rather
 * than to a bad request.
 */
const THINKING_CHOICES = [
  { id: "off", label: "Off", description: "No reasoning" },
  { id: "minimal", label: "Minimal", description: "Very brief reasoning (~1k tokens)" },
  { id: "low", label: "Low", description: "Light reasoning (~2k tokens)" },
  { id: "medium", label: "Medium", description: "Moderate reasoning (~8k tokens)" },
  { id: "high", label: "High", description: "Deep reasoning (~16k tokens)" },
  { id: "xhigh", label: "Extra high", description: "Maximum reasoning (~32k tokens)" },
] as const;

/** loop's name for the built-in persona; the wire omits it (see agentOptionOf). */
export const DEFAULT_AGENT_NAME = "default";

/**
 * The agent control, as a real option descriptor.
 *
 * This has to be a DESCRIPTOR, not just a stored selection, and that is the
 * whole bug it fixes: `composerProviderState` computes the options a turn
 * dispatches with `buildProviderOptionSelectionsFromDescriptors`, which walks
 * the DESCRIPTORS and rebuilds the selection from them. An option the model
 * does not declare is therefore dropped on send — measured: picking the `plan`
 * agent showed `plan` in the composer, then `session.send` went out with only
 * `{sessionId, input, model}` and the picker fell back to `default`. Planning
 * silently ran as the normal persona, which is exactly what it looked like.
 *
 * Agents are a property of loop, not of a model, so every model carries the
 * same list. Offered only when there are at least two — with one there is
 * nothing to choose.
 */
export function agentDescriptors(agents: readonly string[]): readonly unknown[] {
  if (agents.length < 2) return [];
  return [
    {
      id: "agent",
      label: "Agent",
      description: "Run the next message under this agent's prompt and tools",
      type: "select",
      options: agents.map((name) => ({
        id: name,
        label: name === DEFAULT_AGENT_NAME ? "Default" : name,
        ...(name === DEFAULT_AGENT_NAME ? { isDefault: true } : {}),
      })),
    },
  ];
}

/**
 * The effort control for one model, or nothing.
 *
 * The composer's TraitsPicker renders entirely from
 * `capabilities.optionDescriptors` and hides itself when a model declares
 * none — which is why loop had no effort control at all until now. The
 * receiving end was already built: `dispatch.ts` maps a `reasoningEffort`
 * selection onto `session.send`'s `thinking`, which is `/thinking`.
 *
 * Only reasoning models get one, matching the terminal — `/thinking` on a
 * non-reasoning model answers "current model does not support thinking"
 * (model-handlers.ts) rather than offering levels that would be ignored.
 */
export function effortDescriptors(model: LoopCatalogModel, current: string): readonly unknown[] {
  if (model.reasoning !== true) return [];
  return [
    {
      id: "reasoningEffort",
      label: "Thinking",
      description: "How much the model reasons before answering",
      type: "select",
      options: THINKING_CHOICES,
      // loop's live `thinkingLevel`, so an untouched picker sends back
      // exactly what the turn would have run at anyway.
      currentValue: current,
    },
  ];
}

/**
 * loop's providers, in the contract's shape.
 *
 * `ProviderInstanceId` and `ProviderDriverKind` are open branded slugs whose
 * pattern allows `:`, so loop's ids — including custom ones like
 * `custom:pronto-gpt` — are legal as-is and need no mapping table.
 */
export function toProviders(
  catalog: readonly LoopCatalogModel[],
  auth: LoopAuthStatus,
  configured: string | null | undefined,
  checkedAt: string,
  thinking: string,
  agents: readonly string[],
): readonly unknown[] {
  const byProvider = new Map<string, LoopCatalogModel[]>();
  for (const model of catalog) {
    const bucket = byProvider.get(model.provider);
    if (bucket) bucket.push(model);
    else byProvider.set(model.provider, [model]);
  }
  // A provider loop has credentials for but no catalog entry still belongs in
  // the list — the user can authenticate it and pick a custom model.
  for (const id of auth.providers ?? []) if (!byProvider.has(id)) byProvider.set(id, []);

  const usable = usableProviderIds(auth);
  return [...byProvider].map(([id, models]) => ({
    instanceId: toInstanceId(id),
    driver: toInstanceId(id),
    // The brand name, not the routing id. Left as the raw id this read
    // "openai-chatgpt" and "custom:pronto-gpt" everywhere a provider is
    // named — the composer's model picker included — because the id is what
    // travels on the wire, and nothing downstream had anything better to
    // show. The catalog knows the label; an unknown id title-cases.
    displayName: providerPresentation(id).label,
    enabled: true,
    installed: true,
    version: null,
    status: usable.has(id) ? "ready" : "disabled",
    auth: { status: usable.has(id) ? "authenticated" : "unauthenticated" },
    checkedAt,
    models: models.map((model) => ({
      slug: model.id,
      name: model.name ?? model.id,
      isCustom: false,
      ...(model.id === configured ? { isDefault: true } : {}),
      capabilities: {
        ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
        ...(model.maxOutput === undefined ? {} : { maxOutputTokens: model.maxOutput }),
        reasoning: model.reasoning === true,
        // What the composer is allowed to offer as an attachment. Without
        // this the picker had no idea, so it offered images on every model
        // — including text-only ones, where core silently drops them and the
        // reply reads as the model ignoring the picture.
        attachments: resolveModelAttachmentSupport(model.modalities, model.provider),
        optionDescriptors: [...effortDescriptors(model, thinking), ...agentDescriptors(agents)],
      },
    })),
  })) as readonly unknown[];
}

/**
 * loop's default model, for the composer's picker.
 *
 * `ServerSettings.textGenerationModelSelection` defaults to upstream's own
 * choice (codex / gpt-5.6-luna) when left unset. Leaving it would put another
 * agent's model in loop's composer, so the selection is always pinned to
 * something loop actually offers: the first model of the first authenticated
 * provider, falling back to the first model in the catalog.
 */
function defaultModelSelection(
  catalog: readonly LoopCatalogModel[],
  auth: LoopAuthStatus,
  configured: string | null | undefined,
): { instanceId: string; model: string } | undefined {
  // loop's own `defaultModel` setting wins whenever the catalog can place it.
  const exact = configured ? catalog.find((model) => model.id === configured) : undefined;
  if (exact) return { instanceId: toInstanceId(exact.provider), model: exact.id };

  const usable = usableProviderIds(auth);
  const active = auth.active ?? undefined;
  const pick =
    (active ? catalog.find((m) => m.provider === active && m.available !== false) : undefined) ??
    catalog.find((m) => usable.has(m.provider) && m.available !== false) ??
    catalog[0];
  if (!pick) return undefined;
  return { instanceId: toInstanceId(pick.provider), model: pick.id };
}

export interface BuildServerConfigOptions {
  /** The folder this environment is anchored to. */
  readonly cwd: string;
  readonly environmentId: string;
  readonly label: string;
}

/**
 * What the environment would have to change for the UI to care.
 *
 * The config is re-read on a timer, and re-emitting an identical one would
 * churn every atom hanging off it. This is the part worth watching: which
 * providers loop has, which are authenticated, and what it would run.
 */
export function serverConfigFingerprint(config: unknown): string {
  const record = config as
    | {
        providers?: readonly {
          instanceId?: unknown;
          status?: unknown;
          models?: readonly {
            capabilities?: {
              optionDescriptors?: readonly {
                id?: unknown;
                currentValue?: unknown;
                options?: readonly { id?: unknown }[];
              }[];
            };
          }[];
        }[];
        settings?: { textGenerationModelSelection?: unknown };
      }
    | null;
  if (!record) return "";
  const providers = (record.providers ?? []).map(
    (provider) => `${String(provider.instanceId)}:${String(provider.status)}:${provider.models?.length ?? 0}`,
  );
  // The effort picker's starting value comes from loop's `thinkingLevel`, so
  // `/thinking` in the terminal has to move the fingerprint — the model list
  // is unchanged by it, and without this the app would keep the stale level
  // until relaunch.
  const descriptors = (record.providers ?? [])
    .flatMap((provider) => provider.models ?? [])
    .flatMap((model) => model.capabilities?.optionDescriptors ?? []);
  const thinking = descriptors.find((descriptor) => descriptor.id === "reasoningEffort")?.currentValue;
  // Creating an agent in the terminal changes no model and no provider, so
  // without this the composer's agent list would stay stale until relaunch.
  const agents = descriptors
    .find((descriptor) => descriptor.id === "agent")
    ?.options?.map((option) => option.id)
    .join(",");
  return JSON.stringify([
    providers,
    record.settings?.textGenerationModelSelection ?? null,
    thinking ?? null,
    agents ?? null,
  ]);
}

export const buildServerConfig = Effect.fnUntraced(function* (options: BuildServerConfigOptions) {
  const [catalog, auth, info, agentList, descriptors] = yield* Effect.promise(() =>
    Promise.all([
      loopCall<readonly LoopCatalogModel[]>("catalog.list", {}, options.cwd).catch(
        () => [] as readonly LoopCatalogModel[],
      ),
      loopCall<LoopAuthStatus>("auth.status", {}, options.cwd).catch(() => ({}) as LoopAuthStatus),
      loopCall<LoopServerInfo>("server.info", {}, options.cwd).catch(() => ({}) as LoopServerInfo),
      // Empty on an older loop, which collapses the agent control to nothing
      // rather than offering agents the backend cannot run.
      loopCall<readonly { name?: string }[]>("agent.list", {}, options.cwd).catch(
        () => [] as readonly { name?: string }[],
      ),
      // Only for the gateway marks below — a custom provider has no brand of
      // its own, so its icon is the icon of the API it speaks, and this is the
      // only call that reports that.
      loopCall<{ providers?: readonly LoopProviderDescriptor[] }>(
        "auth.providers",
        {},
        options.cwd,
      ).catch(() => ({}) as { providers?: readonly LoopProviderDescriptor[] }),
    ]),
  );
  rememberCustomProviderShapes(
    (descriptors.providers ?? []).flatMap((descriptor) =>
      descriptor.kind === "custom" && descriptor.sdk
        ? [[descriptor.id.replace(/^custom:/, ""), descriptor.sdk] as const]
        : [],
    ),
  );
  const agentNames = (Array.isArray(agentList) ? agentList : [])
    .map((agent) => agent?.name)
    .filter((name): name is string => typeof name === "string" && name !== "");

  const selection = defaultModelSelection(catalog, auth, info.defaults?.model);
  // The folder loop is actually running in beats whatever the shell guessed.
  const cwd = info.defaults?.cwd ?? options.cwd;
  // Cached behind a TTL, so the 30s poll does not re-probe PATH every time.
  const availableEditors = yield* detectEditors();

  return yield* decodeConfig({
    environment: {
      environmentId: options.environmentId,
      label: options.label,
      platform: { os: platformOs(), arch: platformArch() },
      serverVersion: APP_VERSION,
      capabilities: {
        repositoryIdentity: false,
        connectionProbe: true,
      },
    },
    auth: {
      // loop's serve token is checked at the socket, and the desktop shell
      // talks to a local process it spawned itself. By the time any RPC runs
      // the connection is already trusted.
      policy: "desktop-managed-local",
      bootstrapMethods: [],
      sessionMethods: [],
      sessionCookieName: "loop-session",
    },
    cwd,
    keybindingsConfigPath: `${cwd}/.loop/keybindings.json`,
    keybindings: [],
    issues: [],
    providers: toProviders(
      catalog,
      auth,
      info.defaults?.model,
      new Date().toISOString(),
      // An older loop does not report it; "off" is what runTurn falls back to.
      info.defaults?.thinking ?? "off",
      agentNames,
    ),
    availableEditors,
    observability: {
      logsDirectoryPath: `${cwd}/.loop/logs`,
      localTracingEnabled: false,
      otlpTracesEnabled: false,
      otlpMetricsEnabled: false,
    },
    settings: {
      // loop streams every turn; upstream's default of `false` would make the
      // assistant appear only once a turn had finished.
      enableAssistantStreaming: true,
      // loop owns its own update story, so the UI must not poll for provider
      // binary updates it cannot install.
      enableProviderUpdateChecks: false,
      ...(selection === undefined ? {} : { textGenerationModelSelection: selection }),
    },
  });
});

export type { ServerProvider };
