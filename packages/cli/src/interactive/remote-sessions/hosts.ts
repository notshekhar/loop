/**
 * `/hosts`: the machine picker, a host's session list, pairing and forgetting
 * hosts, and going back to this machine.
 */
import { basename } from "node:path";
import {
    listRemoteHosts,
    pairRemoteHost,
    parsePairingLink,
    probeRemoteHost,
    removeRemoteHost,
    type RemoteHostClient,
    type RemoteHostRecord,
} from "@notshekhar/loop-core";
import type { SelectItem } from "@notshekhar/loop-tui";
import { formatError } from "../format-error";
import { formatAge } from "../session-roster";
import { accent, dim, err, ok, warn } from "../ui/text";
import { clientFor, openRemote } from "./connection";
import { providerOf, say, type RemoteState } from "./state";

/** Sessions per page in a host's list. */
const HOST_PAGE = 50;

/** A row of a host's `session.list`. */
interface RemoteSessionRow {
    id: string;
    cwd: string;
    model?: string;
    lastModel?: string;
    name?: string;
    firstUserMessage?: string;
    mtime: number;
    running?: boolean;
}

/** A new session on `record`, in the folder and on the model it last used. */
async function newRemote(
    state: RemoteState,
    record: RemoteHostRecord,
    client: RemoteHostClient,
    rows: RemoteSessionRow[],
): Promise<void> {
    const { deps } = state.host;
    const latest = rows[0];
    let model = latest?.lastModel ?? latest?.model ?? "";
    if (!model) {
        model = (await deps.promptOnce(`Model to use on ${record.label} (provider/model)`)).trim();
        if (!model) return;
    }
    let cwd = latest?.cwd;
    const folder = (await deps.promptOnce(`Folder on ${record.label}`, cwd ?? "")).trim();
    if (folder) cwd = folder;
    try {
        const { sessionId } = await client.call<{ sessionId: string }>("session.create", {
            ...(cwd ? { cwd } : {}),
            provider: providerOf(model),
            model,
        });
        await openRemote(state, record, client, sessionId);
    } catch (e) {
        say(state, err(`${record.label}: ${formatError(e)}`));
    }
}

/** One of a host's sessions as a picker row. */
function sessionItem(state: RemoteState, record: RemoteHostRecord, r: RemoteSessionRow, now: number): SelectItem {
    const live = state.host.slots.all().find((s) => s.remote?.host.id === record.id && s.remote.sessionId === r.id);
    const glyph = r.running ? accent("●") : live ? dim("○") : " ";
    const title = r.name || r.firstUserMessage?.replace(/\s+/g, " ").slice(0, 80) || "(no messages)";
    return {
        value: r.id,
        label: `${glyph} ${title}`,
        description: `${live ? "open here · " : ""}${basename(r.cwd)} · ${r.lastModel ?? r.model ?? "?"} · ${formatAge(now - r.mtime)}`,
    };
}

async function showHostSessions(state: RemoteState, record: RemoteHostRecord): Promise<void> {
    const client = clientFor(state, record);
    // A page at a time, like /resume; the picker asks for more as you go.
    const page = (offset: number) => client.call<RemoteSessionRow[]>("session.list", { limit: HOST_PAGE, offset });
    let rows: RemoteSessionRow[];
    try {
        rows = await page(0);
    } catch (e) {
        say(state, err(`${record.label}: ${formatError(e)}`));
        return;
    }
    // A host older than paging ignores `limit` and sends everything.
    let more = rows.length === HOST_PAGE;
    rows.sort((a, b) => b.mtime - a.mtime);
    const NEW = "\x00new";
    const FORGET = "\x00forget";
    const now = Date.now();
    const row = (r: RemoteSessionRow) => sessionItem(state, record, r, now);
    // The fixed rows lead: the sessions below keep growing as you scroll.
    const items: SelectItem[] = [
        { value: NEW, label: "+ New session", description: `runs on ${record.label}` },
        { value: FORGET, label: dim("Forget this machine"), description: `remove ${record.label} from /hosts` },
        ...rows.map(row),
    ];
    const pick = await state.host.deps.searchOnce(
        items,
        `${record.label} · ${rows.length}${more ? "+" : ""} sessions`,
        {
            loadMore: async () => {
                if (!more) return [];
                const next = await page(rows.length).catch(() => [] as RemoteSessionRow[]);
                more = next.length === HOST_PAGE;
                rows.push(...next);
                return next.map(row);
            },
        },
    );
    if (!pick) return;
    if (pick.value === NEW) return newRemote(state, record, client, rows);
    if (pick.value === FORGET) return forget(state, record.id);
    await openRemote(state, record, client, pick.value);
}

function forget(state: RemoteState, idOrLabel: string): void {
    const removed = removeRemoteHost(idOrLabel);
    if (!removed) {
        say(state, warn(`no paired machine called ${idOrLabel}`));
        return;
    }
    state.clients.get(removed.id)?.close();
    state.clients.delete(removed.id);
    say(state, `forgot ${removed.label}` + dim(" — its open sessions here stay until you leave them"));
}

async function pair(state: RemoteState, input: string): Promise<void> {
    const [linkText, tokenText] = input.trim().split(/\s+/);
    let link = parsePairingLink(linkText ?? "", tokenText);
    if (!link && linkText) {
        const token = (await state.host.deps.promptOnce(`Token for ${linkText}`)).trim();
        link = parsePairingLink(linkText, token);
    }
    if (!link) {
        say(state, warn("that is not a pairing link — paste the URL `loop serve` or /rc prints, with its token"));
        return;
    }
    say(state, dim(`pairing ${link.url}…`));
    try {
        const record = await pairRemoteHost(link);
        say(state, ok(`paired ${record.label}`) + dim(` (${record.url}) — /hosts to open its sessions`));
    } catch (e) {
        say(state, err(`could not pair: ${formatError(e)}`));
    }
}

/** Back to a session on this machine: the latest local one, else a new one. */
async function goLocal(state: RemoteState): Promise<void> {
    const { slots, deps } = state.host;
    if (!slots.foreground.remote) {
        say(state, dim("already on this machine — /resume lists its sessions"));
        return;
    }
    const local = [...slots.all()].filter((s) => !s.remote).sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0];
    if (local) slots.switchTo(local);
    else await deps.sessions.openNew();
}

const LOCAL = "\x00local";
const PAIR = "\x00pair";

/**
 * Who is up, asked of every host at once and briefly: a list that
 * waits on the slowest machine is a list nobody opens twice.
 */
function probeAll(hosts: RemoteHostRecord[]): Promise<boolean[]> {
    return Promise.all(
        hosts.map((h) =>
            probeRemoteHost(h.url, { timeoutMs: 1500 }).then(
                () => true,
                () => false,
            ),
        ),
    );
}

/** The machine picker's rows: this machine, every paired host, and a pair row. */
function machineItems(state: RemoteState, hosts: RemoteHostRecord[], reach: boolean[]): SelectItem[] {
    const { slots } = state.host;
    const onScreen = slots.foreground.remote?.host.id;
    const localLive = slots.all().filter((s) => !s.remote).length;
    return [
        {
            value: LOCAL,
            label: `${onScreen ? " " : accent("●")} This machine`,
            description: `${onScreen ? "" : "here · "}${localLive} live session${localLive === 1 ? "" : "s"}${state.rc ? " · rc on" : ""}`,
        },
        ...hosts.map((h, i) => {
            const open = slots.all().filter((s) => s.remote?.host.id === h.id).length;
            return {
                value: h.id,
                label: `${onScreen === h.id ? accent("●") : reach[i] ? ok("○") : err("○")} ${h.label}`,
                description: `${onScreen === h.id ? "here · " : ""}${reach[i] ? "online" : "offline"} · ${h.url.replace(/^https?:\/\//, "")}${open ? ` · ${open} open here` : ""}`,
            };
        }),
        { value: PAIR, label: "+ Pair a machine", description: "paste the link `loop serve` or /rc prints there" },
    ];
}

/** `/hosts [add|remove|<link>]`. */
export async function manageHosts(state: RemoteState, args: string): Promise<void> {
    const { deps } = state.host;
    const [sub, ...rest] = args.trim().split(/\s+/);
    const arg = rest.join(" ");
    if (sub === "add" || sub === "pair") {
        const input = arg || (await deps.promptOnce("Pairing link (what `loop serve` or /rc prints there)"));
        if (input.trim()) await pair(state, input);
        return;
    }
    if (sub === "remove" || sub === "forget") {
        if (!arg) say(state, warn("/hosts remove <name>"));
        else forget(state, arg);
        return;
    }
    if (sub && /^(https?:\/\/|[\w.-]+:\d+)/.test(sub)) {
        await pair(state, args);
        return;
    }

    const hosts = listRemoteHosts();
    const reach = await probeAll(hosts);
    const pick = await deps.selectOnce(machineItems(state, hosts, reach), `Machines · ${hosts.length + 1}`);
    if (!pick) return;
    if (pick.value === LOCAL) return goLocal(state);
    if (pick.value === PAIR) return manageHosts(state, "add");
    const record = hosts.find((h) => h.id === pick.value);
    if (record) await showHostSessions(state, record);
}
