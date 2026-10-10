# Draft: Remote control — one host, many clients

**Status: in progress** (2026-10-08). Done: pairing (`serve-pairing.ts`), the
phone and desktop as clients, the TUI as a client (`/hosts`), `/rc`, and the
core of step 1:

- **One stream per session under `/rc`.** The server takes a
  `LiveSessionProvider` (the TUI's open slots). A client's `session.send` to
  one is typed into the TUI (`chatOnly`, queued if busy) and runs there, on
  screen; the TUI's turns publish every event into the session's seq ring
  (`publishLive` / `setLiveRunning`), so the TUI, the phone and a paired
  desktop render the same stream. `session.cancel` is Esc in the TUI.
- **`session.status`** (additive): every client hears when any session starts
  or ends a turn, appears, is renamed, archived or deleted — not only its
  subscribers. Lists stay true; no more stuck "Working".
- The `/rc` server no longer takes the process-global ask bridge, so the
  TUI's own questions stay on its screen.

Not done: questions/approvals answered from a client for a TUI-run turn,
the `hello` handshake (§4), and two processes on one machine sharing a host
(a desktop's own `loop rpc` and a TUI only share a stream when the desktop
pairs with the TUI's `/rc`). Picked up after the `loop serve`
web app reaches desktop parity — the browser is the first client, and it should
be the desktop UI, not the old single-file page.

Builds on v0.21.0: several live sessions in one interactive loop (slots,
`core/src/host/`, the Ctrl+S switcher, live badges in `/resume`).

---

## 1. What it is

Any loop process can become a **host**. Every other surface — a browser, the
desktop app, a phone, another loop TUI on this or another machine — can
connect to it as a **client** and work in the host's sessions as if they were
local: same session list, same live status, same stream.

```
        ┌────────── host: loop TUI with /rc (or headless `loop serve`) ───────────┐
        │  sessions + turns live HERE · one seq-numbered event stream per session │
        │  endpoint:  ws://<host>:5667/ws?token=…   JSON-RPC session.* + events   │
        └────────────▲──────────────▲──────────────▲──────────────▲───────────────┘
                     │              │              │              │
               browser (web)   loop desktop    mobile (later)  another loop TUI
              served by host  "Connect to host"                 `loop attach <url>`
```

**Nothing changes by default.** Every surface keeps running its own engine as
it does today. Only when a client is *connected* to a host do its sessions,
turns, status and stream belong to that host; disconnecting returns it to
local. A client never silently falls back to running something locally while
it believes it is connected.

Why one host and not a shared daemon: the TUI *is* where the sessions are.
Making the running TUI the server (`/rc`) means the browser sees exactly what
the TUI holds — no second process to keep in sync, no second copy of a session.
Desktop's own local sessions stay separate; it joins a host only when told to.

---

## 2. One host implementation, two ways to start it

- **`/rc`** inside a running TUI — remote-controls *that* loop. Lives as long
  as the TUI; closing the terminal ends it.
- **`loop serve`** — the same host with no screen attached, for headless use.

Both run the same host code (`core/src/host/`). The host's RPC methods act on
the live session slots, NOT on a private session map:

| client does | host side |
|---|---|
| `session.list` | live slots first (with `LiveStatus`), then DB rows |
| `session.history` | the slot's session branch + current `seq` |
| `session.attach {afterSeq}` | replay the slot's event ring after `afterSeq`, or `resync` |
| `session.send` | the slot's own turn runner — queues if busy, exactly like typing in the TUI |
| `session.create` | a new slot opened in the background (the TUI screen does not jump) |
| `session.cancel` | aborts that slot's turn |
| `session.answer` | resolves a parked ask/approval; **first answer wins** (TUI or any client) |

Today's `RpcServer` keeps its own `ActiveSession` map, separate from the TUI's
slots. That is the part that changes: the RpcServer's session methods move onto
the host, and the TUI's slots become the host's sessions.

---

## 3. Stream consistency

Every turn event (the full `TURN_EVENT_NAMES` set, plus `session-running` and a
new `session-status`) is stamped with a per-session `seq` and kept in a ring —
the mechanism `RpcServer` already uses for `session.attach {afterSeq}`.

- The TUI's own transcript and every client render **the same events**, so they
  cannot diverge.
- A reconnecting client sends the last `seq` it saw and receives the gap, or
  `resync: true` (render `session.history` again) if the gap fell out of the
  ring.
- A host restart resets `seq`; a client ahead of the host resyncs.

In the TUI this means tee-ing the per-turn emitter (`turn-runner.ts` →
`wireTurnEmitter`) into the slot's ring, and emitting `session-status` from
`SlotManager.setStatus` so every client shows `● working` / `◆ needs you` /
`✓ done` from one source.

---

## 4. Handshake and versions

Version the **protocol**, not loop's release. Releases ship every few days and
most do not touch the protocol; matching release versions would lock clients
out for nothing.

```jsonc
// client → (first message on the socket)
{ "method": "hello", "params": { "protocol": [1, 3], "client": "loop-tui", "version": "0.21.0" } }

// host →
{ "protocol": [1, 2], "host": "loop-tui", "version": "0.20.18",
  "minClientProtocol": [1, 0],
  "capabilities": ["sessions", "asks", "approvals", "status", "files"] }
```

Rules:

- **Major must match.** Otherwise the host refuses with a message that says
  which side to update (`this host speaks protocol 2; your loop speaks 1 —
  loop update`). A major bump is the only breaking change, and should be rare.
- **Minor is negotiated.** Minor bumps are additive only; both sides use the
  lower of the two.
- **`capabilities` gate features**, not version comparisons. A host without
  `files` makes the client hide its file panel instead of erroring.
- **`minClientProtocol`** lets a host refuse clients that are too old inside a
  major.
- **Nothing but `hello` before the handshake.** Any other method → error
  "send hello first".
- **No `hello` = protocol 1.0.** Today's desktop and web clients never send one;
  they are grandfathered as 1.0 rather than refused.

Kept honest by a `PROTOCOL_VERSION` constant in core and a test that snapshots
the method names + event types: change the surface without bumping and the
test fails (the same pattern as the build-checked `TURN_EVENT_NAMES`).

---

## 5. Clients

| client | work |
|---|---|
| **Browser** | served by the host: the `apps/web` build (its WebSocket transport, `apps/web/src/loop/transport.ts`, already speaks `/ws?token=`). Prerequisite: the serve web-app overhaul. |
| **Another TUI** | `loop attach <url>` — a slot whose events arrive over the socket instead of from a local turn. The transcript is already built from turn events (`wireTurnEmitter`), so this is the same renderer fed from a different source. Header chip `rc · <host>`; the Ctrl+S switcher and `/resume` list the host's sessions; detaching restores local. |
| **Desktop** | "Connect to host": swap the transport from the `loop rpc` child to the socket. The sidebar can show *This Mac* and *shekhar-mbp (rc)* side by side. |
| **Mobile** | later — the browser covers it until then; a native app speaks the same protocol. |

Host goes away → clients show *disconnected*, retry with backoff, and resume
from their last `seq`. Sessions are on disk, so restarting the host brings them
back.

---

## 6. Security

- Token required on the page load AND the WS upgrade (existing serve model,
  `serve-token-store.ts`).
- `/rc` binds **localhost** by default; `/rc --lan` opts into the LAN.
  Cross-machine reach is Tailscale or `ssh -L`, which also provides TLS — loop
  does not do its own.
- `/rc` prints the URL + token, a QR code and a six-digit pairing code (typed
  into the app with the host address instead of the token; one use, five
  minutes, cancelled after five wrong guesses; `/rc` again shows a new one);
  `/rc off` stops it; the status
  line shows `rc on` while it runs.
- Files, git and the terminal are host-machine capabilities. Paired devices get
  the terminal by default (they can already run the agent, which runs shell
  commands); `loop serve --no-terminal`, "Turn on, without the terminal" at the
  `/rc` prompt, or "terminal for other devices: off" in `/settings` keeps it to
  this machine.
- Slash commands from a remote client act on whatever the TUI shows, so remote
  clients get chat, new session, cancel, answers and an explicit allow-list —
  not the whole command set.

---

## 7. Order of work

0. **Prerequisite — the serve web app at desktop parity.** In progress first.
1. **Host core**: host RPC over slots, per-session seq ring + `session-status`,
   `hello` + `PROTOCOL_VERSION` + the surface snapshot test. Headless
   `loop serve` moves onto it.
2. **`/rc`** in the TUI: start/stop, URL + QR, `rc on` chip.
3. **Browser** served by the `/rc` host.
4. **`loop attach <url>`** — the TUI as a client.
5. **Desktop "Connect to host"**.

Every step lands with an e2e test: a message sent from client A streams live on
client B (and on the TUI screen), and both end with identical event sequences.

---

## 8. Open questions

- One `/rc` endpoint per TUI, or should a second TUI on the same machine be
  able to *join* an existing host automatically (discovery via a socket in the
  config dir)?
- Per-client revocable tokens, or one host token rotated with `/rc --rotate`?
- Should a remote client be able to switch what the host TUI *shows*, or only
  operate in the background (current lean: background only — never move
  someone's screen).
