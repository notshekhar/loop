/**
 * loop's providers, as the UI sees them — the data half: names, taglines,
 * login copy and gateway shapes, with no React in it. The handlers that answer
 * loop on the phone read this; the brand marks live in `index.ts`, which only
 * the web UI imports.
 *
 * See `index.ts` for why presentation is kept out of loop.
 */
import catalog from "./catalog.json";

/** How a provider is signed in to. Mirrors core's `AuthMethod`. */
export type LoopAuthMethod = "oauth" | "apikey" | "detect";

export interface LoopLoginMethod {
  readonly method: LoopAuthMethod;
  readonly label: string;
  readonly hint?: string;
  readonly placeholder?: string;
}

export interface LoopProviderPresentation {
  readonly id: string;
  readonly label: string;
  readonly tagline?: string;
  /** The catalog's name for this provider's brand mark; `index.ts` draws it. */
  readonly iconKey?: string;
  readonly keysUrl?: string;
  readonly login: readonly LoopLoginMethod[];
}

interface CatalogEntry {
  readonly id: string;
  readonly label: string;
  readonly tagline?: string;
  readonly icon?: string;
  readonly keysUrl?: string;
  readonly login?: ReadonlyArray<{
    readonly method: string;
    readonly label: string;
    readonly hint?: string;
    readonly placeholder?: string;
  }>;
}

function isAuthMethod(value: string): value is LoopAuthMethod {
  return value === "oauth" || value === "apikey" || value === "detect";
}

const ENTRIES: ReadonlyMap<string, LoopProviderPresentation> = new Map(
  (catalog.providers as ReadonlyArray<CatalogEntry>).map((entry) => {
    return [
      entry.id,
      {
        id: entry.id,
        label: entry.label,
        ...(entry.tagline === undefined ? {} : { tagline: entry.tagline }),
        ...(entry.icon === undefined ? {} : { iconKey: entry.icon }),
        ...(entry.keysUrl === undefined ? {} : { keysUrl: entry.keysUrl }),
        login: (entry.login ?? [])
          .filter((method) => isAuthMethod(method.method))
          .map((method) => ({
            method: method.method as LoopAuthMethod,
            label: method.label,
            ...(method.hint === undefined ? {} : { hint: method.hint }),
            ...(method.placeholder === undefined ? {} : { placeholder: method.placeholder }),
          })),
      },
    ] as const;
  }),
);

/** The name of a custom gateway (`custom:bifrost` → `bifrost`), or null. */
export function customProviderName(loopProviderId: string): string | null {
  return loopProviderId.startsWith("custom:") ? loopProviderId.slice("custom:".length) : null;
}

/** The vendor API shapes a gateway may declare. Mirrors core's `CustomProviderSdk`. */
export type CustomProviderShape = "anthropic" | "openai" | "google" | "openai-compatible";

const CUSTOM_PROVIDER_SHAPES: ReadonlySet<string> = new Set<CustomProviderShape>([
  "anthropic",
  "openai",
  "google",
  "openai-compatible",
]);

/**
 * Which API shape each configured gateway speaks, as last reported by loop.
 *
 * Presentation is synchronous — `providerIconFor` is called from render — but
 * the shape is runtime data only loop knows, so it is learned once and cached
 * rather than fetched at draw time. `buildServerConfig` refreshes it on the
 * same poll that refreshes the provider list, so a gateway added in the
 * terminal picks up its mark without a relaunch.
 */
let CUSTOM_SHAPES: ReadonlyMap<string, CustomProviderShape> = new Map();

/** Record what loop says each gateway is compatible with. */
export function rememberCustomProviderShapes(
  shapes: Iterable<readonly [name: string, shape: string]>,
): void {
  const next = new Map<string, CustomProviderShape>();
  for (const [name, shape] of shapes) {
    if (CUSTOM_PROVIDER_SHAPES.has(shape)) next.set(name, shape as CustomProviderShape);
  }
  CUSTOM_SHAPES = next;
}

/** The API shape a configured gateway speaks, once loop has said. */
export function customProviderShape(name: string): CustomProviderShape | undefined {
  return CUSTOM_SHAPES.get(name);
}

/**
 * Presentation for one loop provider id. Never returns undefined — an unknown
 * id gets a title-cased label and an API-key form, which is the right guess
 * for an extension-registered provider and harmless for anything else.
 */
export function providerPresentation(loopProviderId: string): LoopProviderPresentation {
  const known = ENTRIES.get(loopProviderId);
  if (known) return known;
  const custom = customProviderName(loopProviderId);
  if (custom !== null) {
    const shape = CUSTOM_SHAPES.get(custom);
    return {
      id: loopProviderId,
      label: custom,
      tagline: shape ? `Custom gateway · ${shape}-compatible.` : "Custom gateway.",
      login: [],
    };
  }
  return {
    id: loopProviderId,
    label: titleCase(loopProviderId),
    login: [{ method: "apikey", label: "API key" }],
  };
}

function titleCase(id: string): string {
  return id
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/** Two-letter fallback mark for a provider with no brand icon. */
export function providerInitials(label: string): string {
  const words = label.replace(/[_:-]+/g, " ").split(/\s+/u).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return words
    .slice(0, 2)
    .map((word) => word[0]!.toUpperCase())
    .join("");
}

/**
 * The login methods to offer for a provider, intersected with what loop says
 * it actually supports.
 *
 * loop is authoritative — it knows a Copilot key is meaningless and that
 * Bedrock has nothing to type — so a method loop does not report is dropped
 * even when the catalog describes it. The catalog only supplies the wording.
 * When loop reports a method the catalog has no copy for, a plain row is
 * synthesized rather than hiding a login the user could have used.
 */
export function loginMethodsFor(
  loopProviderId: string,
  supported: readonly LoopAuthMethod[],
): readonly LoopLoginMethod[] {
  const described = providerPresentation(loopProviderId).login;
  const offered = described.filter((method) => supported.includes(method.method));
  const missing = supported.filter(
    (method) => !offered.some((candidate) => candidate.method === method),
  );
  return [...offered, ...missing.map(fallbackLoginMethod)];
}

function fallbackLoginMethod(method: LoopAuthMethod): LoopLoginMethod {
  switch (method) {
    case "oauth":
      return { method, label: "Sign in with a browser" };
    case "detect":
      return { method, label: "Detect credentials" };
    default:
      return { method, label: "API key" };
  }
}
