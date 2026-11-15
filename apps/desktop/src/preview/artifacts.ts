/** Screenshots and recordings from a preview tab: written to a temp folder, revealed, copied. */
import { app, clipboard, nativeImage, shell, type WebContents } from "electron";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { nowIso, type PreviewArtifact } from "./types";

/** A timestamp that is safe in a file name. */
const fileStamp = (iso: string) => iso.replace(/[:.]/g, "-");

export class PreviewArtifacts {
  /** Created once the first artifact is asked for. */
  #directory: string | null = null;

  async captureScreenshot(tabId: string, contents: WebContents): Promise<PreviewArtifact> {
    const image = await contents.capturePage();
    const createdAt = nowIso();
    const path = join(await this.#ensureDirectory(), `screenshot-${fileStamp(createdAt)}.png`);
    const png = image.toPNG();
    await writeFile(path, png);
    return {
      id: `screenshot-${createdAt}`,
      tabId,
      path,
      mimeType: "image/png",
      sizeBytes: png.byteLength,
      createdAt,
    };
  }

  async saveRecording(tabId: string, mimeType: string, data: Uint8Array): Promise<PreviewArtifact> {
    const createdAt = nowIso();
    const extension = mimeType.includes("mp4") ? "mp4" : "webm";
    const path = join(
      await this.#ensureDirectory(),
      `recording-${fileStamp(createdAt)}.${extension}`,
    );
    await writeFile(path, data);
    const { size } = await stat(path);
    return { id: `recording-${createdAt}`, tabId, path, mimeType, sizeBytes: size, createdAt };
  }

  reveal(path: string): void {
    shell.showItemInFolder(path);
  }

  async copyToClipboard(path: string): Promise<void> {
    if (path.toLowerCase().endsWith(".png")) {
      const image = nativeImage.createFromPath(path);
      if (!image.isEmpty()) {
        clipboard.writeImage(image);
        return;
      }
    }
    // A video has no clipboard representation the OS will paste anywhere
    // useful; the path is the thing the user can actually do something with.
    clipboard.writeText(path);
  }

  async #ensureDirectory(): Promise<string> {
    if (this.#directory) return this.#directory;
    const directory = join(app.getPath("temp"), "loop-preview");
    await mkdir(directory, { recursive: true });
    this.#directory = directory;
    return directory;
  }
}
