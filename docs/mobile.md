# Draft: loop mobile — a remote control in your pocket

**Status** (2026-10-07):

- [x] Phase 1: one transport per host (handlers take a `LoopHost`).
- [x] Pairing on the host: `loop serve` answers the client runtime's pairing
      endpoints (`packages/core/src/rpc/serve-pairing.ts`), proved end to end
      against the real client (`pairing.e2e.test.ts`).
- [x] `apps/mobile` brought in from upstream `94331c58e`, running on
      `apps/web`'s client code via `@loop/*` aliases (phase 2 skipped for
      now); typechecks and bundles for iOS. Runs in the iOS Simulator
      (`bun run ios:sim`), pairs with `loop serve`, and lists and opens its
      threads. Not yet run on a physical iPhone.
- [x] Rebranded what the app shows (wordmark, brand mark, copy, deep-link
      schemes, legal links). T3's cloud stack (Clerk, relay) stays in the tree
      but is dormant: every screen of it is gated on a cloud config loop never
      sets, so none of it renders. Remove it when the screens are reworked.
- [ ] Widget and share extensions — need App Groups, so a paid Apple team.
- [x] Mobile's 607 unit tests run under loop's runner (`bun run test`), and
      `apps/mobile` is in `bun run typecheck`.
- [x] `loop serve` prints a pairing QR code — the tailnet URL when Tailscale is
      running, else the LAN URL — which the app's scanner reads as-is.
- [x] Pairing by hand: `loop serve` and `/rc` also show a six-digit code; the
      app takes the host address and that code, and the host trades it for its
      token (one use, five minutes, cancelled after five wrong guesses).
- [x] Desktop: Settings → Connections pairs another loop (paste its URL);
      verified in the app. The sidebar keeps each machine's projects and
      threads apart, names the machine once more than one is paired ("This
      machine" / its hostname), defaults to this machine, and the project
      switcher lists each copy with its machine.
- [ ] Same-repo projects merged across machines into one project with a
      "Run on" picker — needs `repositoryIdentity` (git remote) in the shell
      snapshot; today each machine's copy is its own project.
- [x] TUI: `/hosts` pairs another machine (`/hosts add <link>`), lists This
      machine + every paired one with online/offline, opens a session there
      as a slot (Ctrl+S lists it with its machine), and streams its turns —
      including ones started from another device. `/rc` makes this loop
      pairable (QR + link), `/rc off` stops it. Paired machines are kept in
      auth.json (`remoteHosts`). e2e: `bun packages/cli/test/e2e/run.ts hosts rc`.
- [x] Sessions page in every client (infinite scroll). `session.list` takes
      `limit`/`offset`/`cwd`/`ids`; `session.projects` lists every folder so a
      paged list keeps the whole project list. Web/desktop/phone hold a window
      per host and per watched folder (`handlers/sessionPaging.ts`), pin open
      threads and search matches into it; the TUI's `/resume` and `/hosts`
      pickers load the next page as the cursor nears the end. Measured on
      858 sessions: the full list 169ms / 542KB, a page 2ms / 27KB.
- [x] Phone transcript matches the desktop: no "Worked for" folds, runs of
      finished tool calls fold to one row ("Read 2 files, Ran 1 command") via
      the desktop's `loopVerbGroup.ts`. Long threads open on their tail (40
      rows, older ones prepended on scroll) and identical thread snapshots no
      longer re-render the feed — opening a 285-entry session went from ~600ms
      to ~160ms of render work.
- [x] Phone sends no longer wedge in the queue: the outbox synced runtime and
      interaction modes before each send and loop refused both commands. The
      sync is gone, the handler accepts both as no-ops, and the Runtime /
      Interaction menus are removed (as on desktop).
- [ ] `/rc` serves its own RpcServer, so a phone sees this machine's sessions
      but not the turns typed into the TUI window live — the host core in
      remote-control.md (§2, step 1) is what joins the two.
- [ ] Phases 4–5 below.

---

## 1. What it is

`apps/mobile`: an Expo app (iOS + Android), forked from T3 Code's mobile app
the same way `apps/web` is forked from its web UI. Branded loop, driven by
loop.

**It is only a remote control.** No agent, no engine, no provider keys on the
phone. Every session, turn, file, terminal and git operation lives on a host.

**Many hosts.** The app keeps a list of hosts (your Mac, a dev box, a Linux
server over Tailscale), connects to several at once, and switches between them:

```
  ┌─ loop (phone) ───────────────────────────┐
  │  Hosts                                   │
  │   ● shekhar-mbp    3 sessions · 1 needs you
  │   ● devbox (ts)    1 working             │
  │   ○ studio         offline · retrying    │
  │  + Add host  (scan QR / paste URL)       │
  └──────────────────────────────────────────┘
```

Sessions from every connected host appear in one list grouped by host, each
with its live status (`needs-input` / `working` / `done` / `failed`). Opening
one attaches to it on its host. T3's mobile app already models this:
an environment catalog plus a supervisor that keeps one connection per
environment. Each loop host is one environment.

---

### Every surface is a switcher, not only the phone

The same host list belongs in the desktop app and the TUI. **This machine**
is always the first entry, and any number of others sit beside it:

- **Desktop**: the sidebar groups sessions by host (*This Mac*, *devbox
  (rc)*, …). Adding a host uses the same QR/URL pairing. Phase 1 below is what
  makes this possible: each environment gets its own `LoopHost`.
- **TUI**: `/hosts` lists them. The Ctrl+S switcher and `/resume` show
  sessions from every connected host, tagged by host, and switching to a
  remote one attaches to it (`loop attach` in remote-control.md §5, made
  routine).
- **Tailscale** is the expected network. `/rc` and `loop serve` detect it
  (`tailscale status --json`) and put the MagicDNS name in the QR code
  instead of a LAN IP, so a host added once keeps working from anywhere on the
  tailnet.

## 2. The seam we reuse

`apps/web` answers T3's 79 `WsRpcGroup` RPCs **in-process** through
`src/loop/handlers/` (`runtime/rpc/session.ts` → `makeHandlers`). The handlers
then speak loop's JSON-RPC to the host. T3's mobile app is built on the same
contracts and client runtime, so it can run the same handlers on the phone,
and the host needs no new protocol.

```
 phone:  T3 mobile UI → client-runtime atoms → in-process WsRpc handlers
                                                  │  loop JSON-RPC
                                                  ▼
 host:   loop serve  (later: /rc inside a TUI)   ws://host:5667/ws?token=…
```

## 3. Which upstream commit

Fork mobile at **`94331c58e`**: the commit `apps/web` vendored its
contracts/shared/client-runtime from (see `apps/web/NOTICE.md`).

- At that commit mobile has 433 files on Expo 56 and matches our vendored
  contracts exactly, so the handlers are reused unchanged.
- Upstream HEAD is 2,588 commits later (474 of them touching contracts or
  client-runtime). Mobile there has 887 files on Expo 58 and needs a contract
  we do not have. Porting it means re-vendoring and reworking the handlers.
  Instead, cherry-pick mobile improvements later, by hand.

## 4. Work

### Phase 1: one transport per host (no mobile code yet)

`transport.ts` is a module-level singleton: one `LoopSocket` whose URL comes
from `window.location`. About 25 modules import `loopCall`/`onLoopEvent`
directly. That cannot serve two hosts at once.

- `LoopSocket` takes its URL + token in the constructor. Add
  `createLoopTransport(prepared: PreparedConnection)`.
- `makeHandlers` receives the transport (it already receives `environmentId`
  per connection), and the handlers stop importing the global.
- The web/desktop shells keep a default transport, so `loopCall` stays as a
  thin wrapper for UI code that talks to the one host it is served by.
- Testable on web alone: two `loop serve` instances, two environments in one
  browser tab.

### Phase 2: shared client package

Move `src/loop/{contracts,shared,runtime,handlers}` + the transport out of
`apps/web` into `packages/client` (`@loop/client`), so web and mobile build the
same code. The `@loop/*` path aliases are repointed. No behavior change.

### Phase 3: bring in `apps/mobile`

- Copy `apps/mobile` from `94331c58e`; rewrite `@t3tools/*` imports to
  `@loop/*`; wire the Metro resolver.
- `runtime/rpc/session.ts` on mobile = the in-process handler client from
  phase 1, one per environment.
- Remove what has no loop counterpart: Clerk / T3 Connect / relay, the
  subscription widget, usage-limit cards, T3's EAS project and bundle ids.
- Rebrand: name, icon, `loop://` scheme, our own bundle ids (TBD).
- Native modules (`t3-terminal`, `t3-review-diff`, `t3-markdown-text`, …)
  are kept as-is and audited for server assumptions.

### Phase 4: pairing and multi-host

- `loop serve` (and later `/rc`) prints a QR code of
  `http(s)://host:port/#token=…`. T3's mobile pairing already parses exactly
  that shape (`features/connection/pairing.ts`).
- Hosts list with status per host; add, rename and remove hosts; reconnect
  with backoff; resume each session from its last `seq`.
- Tokens are stored in the platform keychain (`expo-secure-store`).
- Cross-network reach is Tailscale or a tunnel, as in remote-control.md §6.
  loop does not run a relay.

### Phase 5: polish the remote-control loop

- Answer asks/approvals from the phone (needs remote-control.md step 1b on
  the host: approvals and elicitation over RPC).
- Local notifications when a session goes `needs-input` / `done` while the
  app is open or backgrounded. Real push needs a cloud service, so it is out
  of scope for now.

Every phase lands with a test: phase 1 with two hosts in one web tab, and
phases 3–4 with the e2e "send from phone, see it stream on the TUI/web" check
from remote-control.md.

## 5. Open questions

- Should the protocol `hello` handshake from remote-control.md §4 come first?
  A phone left un-updated for months is exactly the client it exists for. The
  current lean is yes, before the first TestFlight.
- Should the phone discover hosts on the LAN (mDNS), or rely on QR/URL only
  at first?
- Which features are cut from v1: terminal, diff review, browser preview?
