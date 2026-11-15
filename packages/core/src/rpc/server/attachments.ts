import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PRODUCT_NAME } from "../../brand";

/**
 * What a remote client may attach, and the extension each is written as.
 *
 * PDFs belong here for the same reason the images do: `extractImagesFromInput`
 * and its `[image:…]` sentinel have always accepted `.pdf` — a PDF dropped on
 * the TUI is an attachment like any other — and `runTurn` already decides
 * whether the chosen model may actually receive it
 * (`filterAttachmentsByModalities`: modality "pdf" AND a provider that takes
 * inline PDF bytes). Leaving pdf out here was the only thing stopping a GUI
 * client from attaching one; it was not a policy, and the policy that does
 * exist lives one layer down where it can see the model.
 */
const ATTACHMENT_EXT_BY_TYPE: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/bmp": "bmp",
    "application/pdf": "pdf",
};
const MAX_ATTACHMENTS = 8;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/** Persist base64 attachment payloads (images, PDFs) to temp files; returns
 * "[image:…]" sentinels to append to the input (empty string when there is
 * nothing valid). Exported for tests. */
export function writeAttachmentPayloads(raw: unknown): string {
    if (!Array.isArray(raw) || raw.length === 0) return "";
    let out = "";
    for (const item of raw.slice(0, MAX_ATTACHMENTS)) {
        const attachment = item as { data?: unknown; mediaType?: unknown };
        const ext = ATTACHMENT_EXT_BY_TYPE[String(attachment.mediaType ?? "")];
        if (!ext || typeof attachment.data !== "string") continue;
        const bytes = Buffer.from(attachment.data, "base64");
        if (bytes.length === 0 || bytes.length > MAX_ATTACHMENT_BYTES) continue;
        const path = join(tmpdir(), `${PRODUCT_NAME}-attach-${randomBytes(8).toString("hex")}.${ext}`);
        writeFileSync(path, bytes);
        out += `\n[image:${path}]`;
    }
    return out;
}
