import { pathToFileURL } from "node:url";
import { PRODUCT_NAME } from "../../brand";
import {
    artifactFilePath,
    deleteArtifact,
    exportArtifact,
    getArtifact,
    listArtifacts,
    readArtifact,
    type ArtifactMeta,
} from "../../artifacts";
import type { HandlerTable, RpcHost, RpcMethodHandler } from "./rpc-host";

type ArtifactHost = Pick<RpcHost, "remote">;

/**
 * One artifact, as the wire sees it: the stored metadata plus the two things a
 * client would otherwise have to reconstruct — where the file is, and the URL
 * that opens it. Artifacts are served from disk rather than over HTTP (see
 * artifacts/index.ts), so `url` is a file:// URL and `path` is what a desktop
 * shell hands to the OS.
 */
function artifactRow(meta: ArtifactMeta): Record<string, unknown> {
    const path = artifactFilePath(meta);
    return { ...meta, path, url: pathToFileURL(path).href };
}

function requireArtifact(id: unknown): ArtifactMeta {
    const meta = getArtifact(String(id));
    if (!meta) throw new Error(`no such artifact: ${id}`);
    return meta;
}

/** A handler that refuses to run unless this server is the local one. See RpcHost.remote. */
function localOnly(host: ArtifactHost, handler: RpcMethodHandler): RpcMethodHandler {
    return (params, transport, req) => {
        if (host.remote) {
            throw new Error(
                `${req.method} is not available over ${PRODUCT_NAME} serve — artifacts stay on the local machine`,
            );
        }
        return handler(params, transport, req);
    };
}

/**
 * Artifacts: pages the agent wrote under ~/<config>/artifacts. The rows carry
 * `path` and `url` so a client can open one without a second round trip —
 * there is no HTTP route serving artifacts, by design, so the file itself is
 * what gets opened.
 */
export function artifactHandlers(host: ArtifactHost): HandlerTable {
    const table: HandlerTable = {
        "artifact.list": () => listArtifacts().map(artifactRow),
        "artifact.get": (params) => artifactRow(requireArtifact(params.id)),
        "artifact.read": (params) => {
            // The bytes, for a client that renders an artifact itself rather
            // than pointing a browser at the file — the desktop app's viewer
            // reads markdown/json/csv/text this way, since a renderer in the
            // page cannot open a file:// URL.
            const meta = requireArtifact(params.id);
            if (!meta.written) throw new Error(`artifact ${meta.id} has no content yet`);
            return { ...artifactRow(meta), content: readArtifact(meta.id) };
        },
        "artifact.export": (params) => {
            // Copies the artifact into a real folder (~/Downloads unless
            // asked otherwise) and reports where — the client has no
            // filesystem of its own, so the path is the whole answer.
            const dest = typeof params.dest === "string" ? params.dest : undefined;
            return { path: exportArtifact(String(params.id), dest) };
        },
        "artifact.delete": (params) => ({ deleted: deleteArtifact(String(params.id)) }),
    };
    return Object.fromEntries(Object.entries(table).map(([name, handler]) => [name, localOnly(host, handler)]));
}
