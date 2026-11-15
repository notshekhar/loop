import type { CommandRegistry } from "../../commands";
import { parseModelId } from "../../providers";
import type { RpcRequest } from "../protocol";
import type { Transport } from "./active-session";
import type { AskRelay } from "./asks";
import type { Announce } from "./clients";
import type { SessionContexts } from "./session-contexts";
import type { TurnRunner } from "./turns";

/**
 * One RPC method's implementation. Every handler takes the same three
 * arguments so the groups compose into one table; a handler names only the
 * ones it uses.
 */
export type RpcMethodHandler = (params: Record<string, unknown>, transport: Transport, req: RpcRequest) => unknown;

/** A group of methods, keyed by wire name. */
export type HandlerTable = Record<string, RpcMethodHandler>;

/**
 * What the method handlers reach the server through. Each group takes only
 * the slice it uses (`Pick<RpcHost, …>`), so it can be driven by a fake.
 */
export interface RpcHost {
    readonly contexts: SessionContexts;
    readonly turns: TurnRunner;
    readonly asks: AskRelay;
    readonly announce: Announce;
    /** Rebuilt wholesale by `config.reload`, hence writable. */
    commands: CommandRegistry;
    /**
     * True when this server is reachable over the network (`loop serve`) rather
     * than only over the local unix socket / stdio.
     *
     * Only artifacts care so far, and deliberately: an artifact is a page the
     * agent wrote out of the contents of your repo, and `serve` binds 0.0.0.0
     * by default. Refusing the whole `artifact.*` family here means those bytes
     * never cross the network at all, which is a stronger guarantee than a UI
     * that merely declines to render them.
     */
    readonly remote: boolean;
    /** loop's release, reported by `hello`. */
    readonly version: string;
}

/** The working directory a request names, or this process's own. */
export function cwdParam(params: Record<string, unknown>): string {
    return String(params.cwd ?? process.cwd());
}

/**
 * The provider half of a `provider/model` id, or null when it has no provider.
 *
 * `parseModelId` THROWS on an id without a `/`, and sessions in the wild carry
 * bare or empty model ids — so a client asking "what is this session running?"
 * would get a dispatch error instead of an answer. Here the caller falls back
 * to the session's recorded provider instead.
 */
export function providerOfModel(modelId: string): string | null {
    try {
        return parseModelId(modelId).provider;
    } catch {
        return null;
    }
}
