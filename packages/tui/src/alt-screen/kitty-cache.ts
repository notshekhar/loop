import { deleteKittyImage, getKittyImagePlacement } from "../terminal-image";

// How much image data may stay uploaded to the terminal while off screen, so
// scrolling back to an image doesn't re-send it.
const MAX_CACHED_OFFSCREEN_KITTY_IMAGES = 16;
const MAX_CACHED_OFFSCREEN_KITTY_TRANSMISSION_BYTES = 32 * 1024 * 1024;
const MAX_CACHED_OFFSCREEN_KITTY_DECODED_BYTES = 64 * 1024 * 1024;

interface CachedKittyImage {
    transmissionGeneration: number;
    transmissionBytes: number;
    estimatedDecodedBytes: number;
}

/**
 * Kitty images already uploaded to the terminal. An image it still has is
 * placed again without re-sending its data; off-screen images beyond the
 * budget are deleted, least recently shown first.
 */
export class KittyImageCache {
    private readonly uploaded = new Map<number, CachedKittyImage>();

    get size(): number {
        return this.uploaded.size;
    }

    clear(): void {
        this.uploaded.clear();
    }

    /** Swap re-sends for placements where possible; returns the lines and deletions for evicted images. */
    prepare(screen: string[]): { lines: string[]; evictedImageDeletion: string } {
        const visibleImageIds = new Set<number>();
        const lines = screen.map((line) => {
            const placement = getKittyImagePlacement(line);
            if (!placement) return line;
            visibleImageIds.add(placement.imageId);
            const cached = this.uploaded.get(placement.imageId);
            // Re-insert so the map stays in least-recently-shown order.
            if (cached) this.uploaded.delete(placement.imageId);
            this.uploaded.set(placement.imageId, {
                transmissionGeneration: placement.transmissionGeneration,
                transmissionBytes: placement.transmissionBytes,
                estimatedDecodedBytes: placement.estimatedDecodedBytes,
            });
            return cached?.transmissionGeneration === placement.transmissionGeneration
                ? placement.replacementLine
                : line;
        });
        return { lines, evictedImageDeletion: this.evictOffscreen(visibleImageIds) };
    }

    private evictOffscreen(visibleImageIds: Set<number>): string {
        const offscreen = { count: 0, transmissionBytes: 0, decodedBytes: 0 };
        for (const [imageId, image] of this.uploaded) {
            if (visibleImageIds.has(imageId)) continue;
            offscreen.count += 1;
            offscreen.transmissionBytes += image.transmissionBytes;
            offscreen.decodedBytes += image.estimatedDecodedBytes;
        }
        let deletion = "";
        for (const [imageId, image] of this.uploaded) {
            if (
                offscreen.count <= MAX_CACHED_OFFSCREEN_KITTY_IMAGES &&
                offscreen.transmissionBytes <= MAX_CACHED_OFFSCREEN_KITTY_TRANSMISSION_BYTES &&
                offscreen.decodedBytes <= MAX_CACHED_OFFSCREEN_KITTY_DECODED_BYTES
            ) {
                break;
            }
            if (visibleImageIds.has(imageId)) continue;
            deletion += deleteKittyImage(imageId);
            this.uploaded.delete(imageId);
            offscreen.count -= 1;
            offscreen.transmissionBytes -= image.transmissionBytes;
            offscreen.decodedBytes -= image.estimatedDecodedBytes;
        }
        return deletion;
    }
}
