import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PromptPlan } from "./shared";

/**
 * The CLIs take images as files, not bytes: Codex through `-i <path>`, Cursor
 * and Antigravity only through their own file-reading tool. A turn's images
 * are written to a private temp folder that lives exactly as long as the turn.
 */
export interface TurnImages {
    paths: string[];
    /** Remove the folder. Safe to call more than once. */
    dispose(): void;
}

export function writeTurnImages(images: PromptPlan["images"]): TurnImages {
    if (images.length === 0) return { paths: [], dispose: () => {} };
    const dir = mkdtempSync(join(tmpdir(), "loop-images-"));
    const paths = images.map((img, i) => {
        const ext = img.mediaType.split("/")[1]?.replace("jpeg", "jpg") ?? "png";
        const path = join(dir, `image-${i + 1}.${ext}`);
        writeFileSync(path, Buffer.from(img.base64, "base64"));
        return path;
    });
    return { paths, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

/** For CLIs that can only see an image by opening it: where the attachments are. */
export function attachedImagesNote(paths: readonly string[]): string {
    if (paths.length === 0) return "";
    const list = paths.map((p) => `- ${p}`).join("\n");
    return `\n\nThe user attached ${paths.length === 1 ? "an image" : `${paths.length} images`}. Open ${paths.length === 1 ? "it" : "them"} with your file-reading tool before answering:\n${list}`;
}
