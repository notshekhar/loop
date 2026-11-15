import type { ScrollView } from "../components/scroll-view";
import type { LayoutFrame } from "../layout";

/** What the alt screen's mouse and search helpers need from the screen that owns them. */
export interface ViewportHost {
    readonly terminal: { readonly columns: number; readonly rows: number };
    /** The layout drawn last frame, if any. */
    layout(): LayoutFrame | undefined;
    /** The scroll view that holds the transcript in a given layout (or the current one). */
    primaryScrollView(layout?: LayoutFrame): ScrollView;
    hasOverlay(): boolean;
    requestRender(): void;
}
