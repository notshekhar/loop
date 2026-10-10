/**
 * Every RPC the vendored UI can make, answered from loop.
 *
 * `WsRpcGroup.toLayer` demands a handler for all 79 RPCs, so a method that has
 * not been ported is a **compile error, not a runtime mystery** — this file is
 * the checklist for the port.
 *
 * Three shapes of answer, and the difference matters:
 *
 *   - implemented — resolves against loop's own JSON-RPC.
 *   - `idle` — a `subscribe*` stream the UI opens as soon as the environment
 *     connects. Failing one tears the connection down before anything renders,
 *     so an unported subscription must idle rather than fail.
 *   - `fail`/`failStream` — a request the user had to trigger. Failing loudly
 *     is right: the feature is visibly unavailable instead of silently dead.
 *
 * `EnvironmentAuthorizationError` is in every RPC's error union, which makes it
 * the one failure shape usable from any handler without widening a contract.
 */
import {
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
  OrchestrationDispatchCommandError,
  WsRpcGroup,
} from "@loop/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { onConfigReloaded } from "../reload.ts";
import type { LoopHost } from "../transport.ts";
import { createAssetUrl } from "./assets.ts";
import { dispatchCommand } from "./dispatch.ts";
import { registerEnvironmentHost } from "./sessionPaging.ts";
import { formatError } from "./formatError.ts";
import { browse, listEntries, readFile, searchEntries, writeFile } from "./files.ts";
import { openInEditor } from "./editors.ts";
import { cloneRepository, lookupRepository, publishRepository } from "./sourceControl.ts";
import {
  diffPreview,
  discoverSourceControl,
  initRepo,
  listRefs,
  refreshStatus,
  runStackedAction,
  statusStream,
} from "./git.ts";
import {
  buildServerConfig,
  serverConfigFingerprint,
  type BuildServerConfigOptions,
} from "./serverConfig.ts";
import {
  closePreview,
  listPreviews,
  navigatePreview,
  openPreview,
  previewEventStream,
  reportPreviewStatus,
  resizePreview,
} from "./preview.ts";
import { searchThreads } from "./search.ts";
import { buildShellSnapshot, shellStream } from "./shell.ts";
import {
  attachTerminal,
  clearTerminal,
  closeTerminal,
  openTerminal,
  resizeTerminal,
  terminalEventStream,
  writeTerminal,
} from "./terminal.ts";
import { threadStream } from "./thread.ts";
import { readSessionInsights } from "./insights.ts";
import { subscribeLiveTurns } from "./liveTurn.ts";

const notPorted = (method: string) =>
  new EnvironmentAuthorizationError({
    message: `${method} is not supported by loop's desktop app`,
    requiredScope: AuthOrchestrationReadScope,
  });

const fail = (method: string) => Effect.fail(notPorted(method));
const failStream = (method: string) => Stream.fail(notPorted(method));

/**
 * How often the environment is re-read.
 *
 * Two `catalog.list` + `auth.status` + `server.info` round trips a minute over
 * a local pipe is nothing, and it is the only way a provider authenticated in
 * the terminal shows up here without a relaunch.
 */
const SERVER_CONFIG_POLL = "30 seconds";
/** A subscription that stays open and never emits. */
const idle = () => Stream.never;

export interface HandlerOptions extends BuildServerConfigOptions {
  /** The machine these handlers answer for. Required here, unlike the config
   * options, so a new shell cannot quietly fall back to the page's own host. */
  readonly host: LoopHost;
}

export const makeHandlers = (options: HandlerOptions) => {
  const { host } = options;
  // Turn events from this host feed the live turns before any thread asks.
  subscribeLiveTurns(host);
  // The UI asks for more sessions by environment; the shell pages by host.
  registerEnvironmentHost(options.environmentId, host.id);
  return WsRpcGroup.toLayer({
    "server.probe": () => Effect.succeed({}),

    "server.getConfig": () =>
      buildServerConfig(options).pipe(
        Effect.mapError(
          () =>
            new EnvironmentAuthorizationError({
              message: "loop could not describe this environment",
              requiredScope: AuthOrchestrationReadScope,
            }),
        ),
      ),

    // A snapshot, then a fresh one whenever loop's own answer changes.
    //
    // This used to emit once and hold the stream open forever, which froze the
    // provider list at connect time: authenticating a provider in loop, or a
    // catalog change, never reached the app until it was relaunched — the
    // "providers are the old ones" report. loop has no notification for auth
    // or catalog changes, so it is polled, and only a real difference is
    // emitted (see serverConfigFingerprint) to keep every atom hanging off the
    // config from churning every few seconds.
    subscribeServerConfig: () => {
      const snapshot = buildServerConfig(options).pipe(
        Effect.map((config) => ({ version: 1 as const, type: "snapshot" as const, config })),
        Effect.mapError(
          () =>
            new EnvironmentAuthorizationError({
              message: "loop could not describe this environment",
              requiredScope: AuthOrchestrationReadScope,
            }),
        ),
      );
      let lastFingerprint: string | null = null;
      // `/reload` re-reads loop out of band, so it also has to be able to make
      // this subscription re-read NOW. Merged into the tick rather than given
      // its own stream so both paths land on the same fingerprint comparison:
      // a reload that changed nothing must not churn every atom hanging off
      // the config.
      const reloads = Stream.callback<void>((queue) =>
        Effect.acquireRelease(
          Effect.sync(() => onConfigReloaded(() => Queue.offerUnsafe(queue, undefined))),
          (unsubscribe) => Effect.sync(unsubscribe),
        ).pipe(Effect.asVoid),
      );
      const updates = Stream.merge(Stream.tick(SERVER_CONFIG_POLL), reloads).pipe(
        // Drop the failure: a poll that cannot reach loop must not tear down a
        // subscription the whole UI hangs off.
        Stream.mapEffect(() => buildServerConfig(options).pipe(Effect.option)),
        Stream.flatMap((config) =>
          Option.match(config, {
            onNone: () => Stream.empty,
            onSome: (value) => {
              const fingerprint = serverConfigFingerprint(value);
              if (fingerprint === lastFingerprint) return Stream.empty;
              lastFingerprint = fingerprint;
              return Stream.succeed({
                version: 1 as const,
                type: "snapshot" as const,
                config: value,
              });
            },
          }),
        ),
      );
      return Stream.fromEffect(
        snapshot.pipe(
          Effect.tap((item) =>
            Effect.sync(() => {
              lastFingerprint = serverConfigFingerprint(item.config);
            }),
          ),
        ),
      ).pipe(Stream.concat(updates));
    },

  "server.upsertKeybinding": () => fail("server.upsertKeybinding"),
  "server.removeKeybinding": () => fail("server.removeKeybinding"),
    // Re-read loop rather than probe anything. Upstream's version of this
    // shelled out to each agent CLI to check it was installed; loop's
    // providers are HTTP endpoints it either has credentials for or does not,
    // so the honest refresh is to ask loop again — which the subscription
    // above then picks up on its next fingerprint comparison.
    "server.refreshProviders": () =>
      buildServerConfig(options).pipe(
        Effect.map((config) => ({ providers: config.providers })),
        Effect.mapError(
          () =>
            new EnvironmentAuthorizationError({
              message: "loop could not list its providers",
              requiredScope: AuthOrchestrationReadScope,
            }),
        ),
      ),
  // Updating a provider means updating its CLI binary, which loop has none of
  // — its providers are endpoints, and loop updates itself.
  "server.updateProvider": () => fail("server.updateProvider"),
  "server.updateServer": () => fail("server.updateServer"),
  "server.updateServerWithProgress": () => failStream("server.updateServerWithProgress"),
  "server.getSettings": () => fail("server.getSettings"),
  "server.updateSettings": () => fail("server.updateSettings"),
  "server.discoverSourceControl": () => discoverSourceControl(host),
  "server.getTraceDiagnostics": () => fail("server.getTraceDiagnostics"),
  "server.getProcessDiagnostics": () => fail("server.getProcessDiagnostics"),
  "server.getProcessResourceHistory": () => fail("server.getProcessResourceHistory"),
  "server.getResourceTelemetryHistory": () => fail("server.getResourceTelemetryHistory"),
  "server.retryResourceTelemetry": () => fail("server.retryResourceTelemetry"),
  "server.signalProcess": () => fail("server.signalProcess"),
  "session.insights": (input) => readSessionInsights(input, host),
  "cloud.getRelayClientStatus": () => fail("cloud.getRelayClientStatus"),
  "cloud.installRelayClient": () => failStream("cloud.installRelayClient"),
  "server.reportClientActivity": () => fail("server.reportClientActivity"),
  "server.reportHostPowerState": () => fail("server.reportHostPowerState"),
  "server.getBackgroundPolicy": () => fail("server.getBackgroundPolicy"),
  "sourceControl.lookupRepository": (input) => lookupRepository(input, host),
  "sourceControl.cloneRepository": (input) => cloneRepository(input, host),
  "sourceControl.publishRepository": (input) => publishRepository(input, host),
    "projects.searchEntries": (input) => searchEntries(input, host),
  "projects.searchContents": () => fail("projects.searchContents"),
    "projects.listEntries": (input) => listEntries(input.cwd, host),
    "projects.readFile": (input) => readFile(input, host),
    "projects.writeFile": (input) => writeFile(input, host),
  "shell.openInEditor": (input) => openInEditor(input, host),
    "filesystem.browse": (input) => browse(input, host),
    "assets.createUrl": (input) => createAssetUrl(input, host),
    "subscribeVcsStatus": (input) => statusStream(input.cwd, host),
  "vcs.pull": () => fail("vcs.pull"),
    "vcs.refreshStatus": (input) => refreshStatus(input, host),
  "git.runStackedAction": (input) => runStackedAction(input, host),
  "git.resolvePullRequest": () => fail("git.resolvePullRequest"),
  "git.preparePullRequestThread": () => fail("git.preparePullRequestThread"),
    "vcs.listRefs": (input) => listRefs(input, host),
  "vcs.createWorktree": () => fail("vcs.createWorktree"),
  "vcs.removeWorktree": () => fail("vcs.removeWorktree"),
  "vcs.createRef": () => fail("vcs.createRef"),
  "vcs.switchRef": () => fail("vcs.switchRef"),
    "vcs.init": (input) => initRepo(input, host),
    "review.getDiffPreview": (input) => diffPreview(input, host),
    "terminal.open": (input) => openTerminal(input, host),
    "terminal.attach": (input) => attachTerminal(input, host),
    "terminal.write": (input) => writeTerminal(input, host),
    "terminal.resize": (input) => resizeTerminal(input, host),
    "terminal.clear": (input) => clearTerminal(input, host),
  "terminal.restart": () => fail("terminal.restart"),
    "terminal.close": (input) => closeTerminal(input, host),
    // The browser panel's tabs. Pure per-window UI state — see preview.ts for
    // why this is served here rather than from loop.
    "preview.open": (input) => openPreview(input),
    "preview.navigate": (input) => navigatePreview(input),
    "preview.resize": (input) => resizePreview(input),
    // Refresh is the webview's own job; the tab state does not change, so
    // acknowledging is the honest answer rather than failing the call.
    "preview.refresh": () => Effect.succeed(undefined),
    "preview.close": (input) => closePreview(input),
    "preview.list": () => listPreviews(),
    "preview.reportStatus": (input) => reportPreviewStatus(input),
  "previewAutomation.connect": () => failStream("previewAutomation.connect"),
  "previewAutomation.respond": () => fail("previewAutomation.respond"),
  "previewAutomation.focusHost": () => fail("previewAutomation.focusHost"),
    "subscribePreviewEvents": () => previewEventStream(),
  "subscribeDiscoveredLocalServers": idle,
    // The reason travels in the message, not only in `cause`: the toast that
    // reports this shows the message alone, so a failed "add project" read
    // "loop could not run project.create" and the actual sentence — which
    // folder, and what was wrong with it — was thrown away.
    "orchestration.dispatchCommand": (command) =>
      dispatchCommand(command, host).pipe(
        Effect.catchCause((cause) =>
          Effect.fail(
            new OrchestrationDispatchCommandError({
              message: `loop could not run ${command.type}: ${formatError(Cause.squash(cause))}`,
              cause,
            }),
          ),
        ),
      ),
  "orchestration.getTurnDiff": () => fail("orchestration.getTurnDiff"),
  "orchestration.getFullThreadDiff": () => fail("orchestration.getFullThreadDiff"),
    // Titles and opening messages, out of the shell's own `session.list`.
    // loop has no search index, and reading every transcript to build one
    // would cost a round trip per session before the first result appeared.
    "orchestration.searchThreads": (input) => searchThreads(input, host),
    // The same snapshot, asked for the other side of the archive. The
    // Archive settings panel reads this; the sidebar reads the working set.
    "orchestration.getArchivedShellSnapshot": () =>
      buildShellSnapshot(true, host).pipe(
        Effect.mapError(
          () =>
            new EnvironmentAuthorizationError({
              message: "loop could not list its archived sessions",
              requiredScope: AuthOrchestrationReadScope,
            }),
        ),
      ),
    // Projects and threads, derived from loop's sessions: the snapshot, the
    // completion marker the client waits on, then a fresh snapshot whenever a
    // turn moves. That refresh is not cosmetic — a draft only becomes a real
    // thread once the shell reports it, so without it the composer would sit
    // on "Working" while the turn completed underneath.
    "orchestration.subscribeShell": () => shellStream(host),
    // A snapshot now, then a fresh one whenever the live turn moves. loop's
    // event vocabulary (text-delta, tool-call, reasoning) does not line up
    // one-for-one with the contract's command-echo events, so re-deriving the
    // whole thread is both simpler and impossible to get subtly out of sync.
    // The rebuild is coalesced, or a fast model would rebuild per token.
    "orchestration.subscribeThread": (input) => threadStream(input.threadId, host),
    "subscribeTerminalEvents": () => terminalEventStream(host),
  // Deliberately idle. Serving real summaries here looks like an improvement —
  // tab labels, an id allocator that can see which terminals exist — but the
  // panel derives `cwd` and `worktreePath` from the summary, and both are
  // dependencies of the effect that BUILDS THE TERMINAL SURFACE. Every poll
  // that changed a summary tore the surface down, rebuilt it and replayed the
  // scrollback, stacking a fresh copy of the prompt on screen each time.
  // Reinstating it means making the panel's identity independent of it first.
  "subscribeTerminalMetadata": idle,
  "subscribeServerLifecycle": idle,
  "subscribeAuthAccess": idle,
  "subscribeBackgroundPolicy": idle,
  "subscribeResourceTelemetry": idle,
  });
};
