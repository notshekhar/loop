/**
 * The half of MCP that isn't tools: resources, resource templates and prompts.
 *
 * loop only ever called `tools/list`, so a server's resources and prompts were
 * invisible no matter how prominently it advertised them — the connection was
 * live, the data was one request away, and nothing in loop could reach it.
 *
 * Everything here is gated on the capability the server declared in its
 * `initialize` result. That is not politeness: a server that doesn't implement
 * resources answers `resources/list` with a JSON-RPC "method not found", so
 * asking anyway turns every ordinary tools-only server into a connect that
 * logs errors. Ask only what the server said it can answer.
 */
import { debugLog } from "../debug";
import type { McpClient } from "./client";

export interface McpResourceEntry {
    server: string;
    uri: string;
    name: string;
    title?: string;
    description?: string;
    mimeType?: string;
    size?: number;
}

export interface McpResourceTemplateEntry {
    server: string;
    uriTemplate: string;
    name: string;
    title?: string;
    description?: string;
    mimeType?: string;
}

export interface McpPromptArgument {
    name: string;
    description?: string;
    required?: boolean;
}

export interface McpPromptEntry {
    server: string;
    name: string;
    title?: string;
    description?: string;
    arguments: McpPromptArgument[];
}

/** What one server told us it can do, read off the initialize result. */
export interface McpCapabilities {
    tools: boolean;
    resources: boolean;
    resourceSubscribe: boolean;
    prompts: boolean;
    completions: boolean;
    logging: boolean;
}

export interface McpFeatureCatalog {
    resources: McpResourceEntry[];
    resourceTemplates: McpResourceTemplateEntry[];
    prompts: McpPromptEntry[];
}

export const EMPTY_CATALOG: McpFeatureCatalog = Object.freeze({
    resources: [],
    resourceTemplates: [],
    prompts: [],
});

/**
 * Pagination guard. A paginated list hands back a cursor, and a server with a
 * buggy (or hostile) cursor that never advances would otherwise spin forever
 * holding the connection. Ten pages is far past any real catalog.
 */
const MAX_PAGES = 10;

/** Per-call ceiling, so one slow catalog can't stall a connect indefinitely. */
const LIST_TIMEOUT_MS = 15_000;

function capabilityRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

/**
 * Read a server's declared capabilities off the handshake.
 *
 * The SDK keeps the whole `initialize` result, so nothing extra goes over the
 * wire. A missing block means "not supported" — the spec makes presence, not
 * truthiness, the signal, so `{"resources":{}}` is a server that supports
 * resources and nothing optional on top.
 */
export function readCapabilities(client: McpClient): McpCapabilities {
    const caps = capabilityRecord((client as { initializeResult?: { capabilities?: unknown } }).initializeResult?.capabilities);
    const resources = capabilityRecord(caps?.resources);
    return {
        tools: Boolean(caps && "tools" in caps),
        resources: Boolean(resources),
        resourceSubscribe: Boolean(resources?.subscribe),
        prompts: Boolean(caps && "prompts" in caps),
        completions: Boolean(caps && "completions" in caps),
        logging: Boolean(caps && "logging" in caps),
    };
}

async function withTimeout<T>(what: string, run: () => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            run(),
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error(`${what} timed out after ${LIST_TIMEOUT_MS}ms`)), LIST_TIMEOUT_MS);
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/**
 * Walk every page of a paginated list.
 *
 * Stops on a cursor the server repeats, which is the shape a broken paginator
 * takes in practice — it echoes the cursor it was given and the caller loops
 * on the same page forever.
 */
async function paginate<T>(
    what: string,
    fetchPage: (cursor?: string) => Promise<{ items: T[]; nextCursor?: string }>,
): Promise<T[]> {
    const all: T[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
        const { items, nextCursor } = await withTimeout(what, () => fetchPage(cursor));
        all.push(...items);
        if (!nextCursor || seen.has(nextCursor)) break;
        seen.add(nextCursor);
        cursor = nextCursor;
    }
    return all;
}

/**
 * Everything one server offers besides tools, or as much of it as the server
 * will admit to.
 *
 * A failure in one section is contained: a server whose prompts throw still
 * contributes its resources. The alternative — one bad list poisoning the
 * catalog — is how a server ends up looking empty for a reason nobody can see.
 */
export async function fetchCatalog(
    server: string,
    client: McpClient,
    capabilities: McpCapabilities,
): Promise<McpFeatureCatalog> {
    const [resources, resourceTemplates, prompts] = await Promise.all([
        capabilities.resources ? fetchResources(server, client) : Promise.resolve([]),
        capabilities.resources ? fetchResourceTemplates(server, client) : Promise.resolve([]),
        capabilities.prompts ? fetchPrompts(server, client) : Promise.resolve([]),
    ]);
    return { resources, resourceTemplates, prompts };
}

export async function fetchResources(server: string, client: McpClient): Promise<McpResourceEntry[]> {
    try {
        return await paginate(`${server}: resources/list`, async (cursor) => {
            const result = await client.listResources(cursor ? { params: { cursor } } : undefined);
            const items = result.resources.map((r) => ({
                server,
                uri: r.uri,
                name: r.name,
                ...(r.title ? { title: r.title } : {}),
                ...(r.description ? { description: r.description } : {}),
                ...(r.mimeType ? { mimeType: r.mimeType } : {}),
                ...(typeof r.size === "number" ? { size: r.size } : {}),
            }));
            return { items, ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}) };
        });
    } catch (err) {
        debugLog("mcp", `${server}: resources/list failed:`, err);
        return [];
    }
}

export async function fetchResourceTemplates(server: string, client: McpClient): Promise<McpResourceTemplateEntry[]> {
    try {
        const result = await withTimeout(`${server}: resources/templates/list`, () => client.listResourceTemplates());
        return result.resourceTemplates.map((t) => ({
            server,
            uriTemplate: t.uriTemplate,
            name: t.name,
            ...(t.title ? { title: t.title } : {}),
            ...(t.description ? { description: t.description } : {}),
            ...(t.mimeType ? { mimeType: t.mimeType } : {}),
        }));
    } catch (err) {
        // Templates are optional even for a server that has resources, and a
        // server that doesn't implement them says so with a method-not-found.
        debugLog("mcp", `${server}: resources/templates/list failed:`, err);
        return [];
    }
}

export async function fetchPrompts(server: string, client: McpClient): Promise<McpPromptEntry[]> {
    try {
        return await paginate(`${server}: prompts/list`, async (cursor) => {
            const result = await client.experimental_listPrompts(cursor ? { params: { cursor } } : undefined);
            const items = result.prompts.map((p) => ({
                server,
                name: p.name,
                ...(p.title ? { title: p.title } : {}),
                ...(p.description ? { description: p.description } : {}),
                arguments: (p.arguments ?? []).map((a) => ({
                    name: a.name,
                    ...(a.description ? { description: a.description } : {}),
                    ...(a.required ? { required: true } : {}),
                })),
            }));
            return { items, ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}) };
        });
    } catch (err) {
        debugLog("mcp", `${server}: prompts/list failed:`, err);
        return [];
    }
}

/** One resource's contents, flattened to text loop can put in front of a model. */
export interface ReadResourcePart {
    uri: string;
    mimeType?: string;
    /** Text contents, or a description of a binary blob we will not inline. */
    text: string;
    /** True when the part was binary and `text` is a stand-in description. */
    binary: boolean;
}

/**
 * Binary resources are described, not inlined.
 *
 * A `blob` is base64, and a PDF or an image pasted into the transcript as
 * base64 is both unreadable and an enormous number of tokens — the kind of
 * thing that blows a context window in one tool result. The model gets the
 * uri, the type and the size, which is enough to decide what to do next.
 */
export function flattenResourceContents(contents: unknown[]): ReadResourcePart[] {
    const parts: ReadResourcePart[] = [];
    for (const entry of contents) {
        if (typeof entry !== "object" || entry === null) continue;
        const item = entry as { uri?: unknown; mimeType?: unknown; text?: unknown; blob?: unknown };
        const uri = typeof item.uri === "string" ? item.uri : "";
        const mimeType = typeof item.mimeType === "string" ? item.mimeType : undefined;
        if (typeof item.text === "string") {
            parts.push({ uri, ...(mimeType ? { mimeType } : {}), text: item.text, binary: false });
            continue;
        }
        if (typeof item.blob === "string") {
            const bytes = Math.floor((item.blob.length * 3) / 4);
            parts.push({
                uri,
                ...(mimeType ? { mimeType } : {}),
                text: `[binary ${mimeType ?? "content"}, ${bytes} bytes — not inlined]`,
                binary: true,
            });
        }
    }
    return parts;
}

/**
 * A prompt's messages as plain text.
 *
 * `prompts/get` returns chat messages, but loop's commands submit a single
 * user turn, so the messages are rendered into one block. Assistant turns are
 * labelled: a prompt that seeds an exchange reads as nonsense if both halves
 * are run together unattributed.
 */
export function renderPromptMessages(messages: unknown[]): string {
    const lines: string[] = [];
    for (const entry of messages) {
        if (typeof entry !== "object" || entry === null) continue;
        const message = entry as { role?: unknown; content?: unknown };
        const role = message.role === "assistant" ? "assistant" : "user";
        const content = message.content as { type?: unknown; text?: unknown; resource?: unknown } | undefined;
        let text: string | undefined;
        if (content?.type === "text" && typeof content.text === "string") {
            text = content.text;
        } else if (content?.type === "resource") {
            const [part] = flattenResourceContents([content.resource]);
            text = part ? `${part.uri}\n${part.text}` : undefined;
        } else if (content?.type === "resource_link" && typeof (content as { uri?: unknown }).uri === "string") {
            text = `[resource] ${(content as { uri: string }).uri}`;
        } else if (content?.type === "image") {
            text = "[image omitted]";
        }
        if (!text) continue;
        lines.push(role === "assistant" ? `[assistant]\n${text}` : text);
    }
    return lines.join("\n\n");
}
