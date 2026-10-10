/**
 * The client↔host protocol this app speaks — a copy of core's
 * `PROTOCOL_VERSION` (packages/core/src/rpc/protocol.ts; see there for what
 * each version added). The app is a separate build from the host it talks to:
 * a phone left un-updated for months is exactly the client this exists for.
 * `packages/core/test/protocol.test.ts` keeps the two copies equal.
 */
export const CLIENT_PROTOCOL = [1, 2] as const;

export type ProtocolVersion = readonly [number, number];

/** What the host answered `hello` with, or why this app cannot use it. */
export type HandshakeResult =
  | { readonly ok: true; readonly host: ProtocolVersion; readonly capabilities: readonly string[] }
  | { readonly ok: false; readonly message: string };

/**
 * Say `hello` to a host. A host that does not know the method predates the
 * handshake: protocol 1.0, which this app still speaks. A protocol refusal is
 * the host saying it cannot serve this app — its message names the side to
 * update. Anything else throws, to be retried like any failed connect.
 */
export async function handshake(
  call: (method: string, params: Record<string, unknown>) => Promise<unknown>,
  client: string,
): Promise<HandshakeResult> {
  try {
    const answer = (await call("hello", { protocol: CLIENT_PROTOCOL, client })) as {
      protocol?: unknown;
      capabilities?: unknown;
    } | null;
    const host = parseProtocol(answer?.protocol) ?? [1, 0];
    if (host[0] !== CLIENT_PROTOCOL[0]) {
      return {
        ok: false,
        message:
          host[0] > CLIENT_PROTOCOL[0]
            ? `This loop host speaks protocol ${host.join(".")}; this app speaks ${CLIENT_PROTOCOL.join(".")}. Update the app.`
            : `This loop host speaks protocol ${host.join(".")}; this app speaks ${CLIENT_PROTOCOL.join(".")}. Update loop on the host (\`loop update\`).`,
      };
    }
    const capabilities = Array.isArray(answer?.capabilities)
      ? answer.capabilities.filter((c): c is string => typeof c === "string")
      : [];
    return { ok: true, host, capabilities };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/method not found/i.test(message)) return { ok: true, host: [1, 0], capabilities: [] };
    // The host refusing this app's protocol is final; anything else (a socket
    // that dropped mid-hello) is an ordinary failure, retried as one.
    if (/protocol/i.test(message)) return { ok: false, message };
    throw error;
  }
}

function parseProtocol(value: unknown): ProtocolVersion | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const [major, minor] = value;
  return Number.isInteger(major) && Number.isInteger(minor) ? [major as number, minor as number] : null;
}
