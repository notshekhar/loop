/** The in-page element picker: arm it, wait for a pick or a cancel, crop a screenshot. */
import type { WebContents } from "electron";

import {
  buildAnnotationPayload,
  CANCEL_PICKER_SCRIPT,
  PICKER_SCRIPT,
  screenshotCropRect,
  type PickedGuestElement,
  type PreviewAnnotationPayload,
} from "../previewPicker";
import { alive } from "./types";

/**
 * Arms the in-page element picker and resolves with the annotation the user
 * picked, or null if they pressed Escape, navigated away, or armed it again.
 *
 * The script's promise is the whole protocol — `executeJavaScript` resolves
 * with whatever it resolves with — so a navigation mid-pick would otherwise
 * leave this hanging forever with the button stuck lit.
 */
export async function pickElement(
  contents: WebContents,
  zoomFactor: () => number,
): Promise<PreviewAnnotationPayload | null> {
  const abandoned = whenAbandoned(contents);

  // Escape is handled by a listener inside the guest, so the guest has to own
  // the keyboard for it to arrive. `PreviewView` puts focus back where the
  // user left it once the pick settles.
  contents.focus();

  let picked: PickedGuestElement | null = null;
  try {
    picked = (await Promise.race([
      contents.executeJavaScript(PICKER_SCRIPT, true) as Promise<PickedGuestElement | null>,
      abandoned,
    ])) as PickedGuestElement | null;
  } catch {
    // Frame torn down under the pick; treat as a cancel.
    picked = null;
  }
  if (!picked || !alive(contents)) return null;

  const screenshot = await captureAnnotationCrop(contents, picked, zoomFactor());
  return buildAnnotationPayload({ picked, screenshot, now: new Date() });
}

export function cancelPickElement(contents: WebContents): void {
  void contents.executeJavaScript(CANCEL_PICKER_SCRIPT, true).catch(() => undefined);
}

/** Resolves null once the guest navigates away or is destroyed. */
function whenAbandoned(contents: WebContents): Promise<null> {
  return new Promise<null>((resolve) => {
    const done = () => {
      contents.off("did-start-navigation", done);
      contents.off("destroyed", done);
      resolve(null);
    };
    contents.once("did-start-navigation", done);
    contents.once("destroyed", done);
  });
}

async function captureAnnotationCrop(
  contents: WebContents,
  picked: PickedGuestElement,
  zoomFactor: number,
): Promise<PreviewAnnotationPayload["screenshot"]> {
  try {
    const crop = screenshotCropRect(picked.rect, zoomFactor, picked.viewport);
    // A rect that clamps to nothing (element scrolled out of view) still
    // deserves a screenshot — the whole viewport says more than none at all.
    const image = crop ? await contents.capturePage(crop) : await contents.capturePage();
    const imageSize = image.getSize();
    return {
      dataUrl: image.toDataURL(),
      width: imageSize.width,
      height: imageSize.height,
      cropRect: crop ?? { x: 0, y: 0, width: imageSize.width, height: imageSize.height },
    };
  } catch {
    return null;
  }
}
