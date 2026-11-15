import type { PairedChat } from "./chat";
import type { RpcCaller } from "./rpc-peer";
import type { ChatSession } from "./session";

/** What a slash-command or menu-tap handler works with. */
export interface BridgeContext {
    chat: PairedChat;
    peer: RpcCaller;
    session: ChatSession;
}
