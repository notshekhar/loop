import type { Component } from "../component";
import type { OverlayOptions, OverlayBounds } from "./types";

export type OverlayStackEntry = {
    component: Component;
    options?: OverlayOptions;
    preFocus: Component | null;
    hidden: boolean;
    focusOrder: number;
    bounds?: OverlayBounds;
};

type BlockedResume = { status: "restore-overlay" } | { status: "focus-target"; target: Component | null };
type EligibleState = { status: "eligible"; overlay: OverlayStackEntry };
export type BlockedState = {
    status: "blocked";
    overlay: OverlayStackEntry;
    blockedBy: Component;
    resume: BlockedResume;
};
export type FocusRestoreState = { status: "inactive" } | EligibleState | BlockedState;
export type OverlayFocusRestorePolicy = "clear" | "preserve";

/**
 * Remembers which overlay should get focus back after something outside it
 * (a non-overlay component) briefly takes focus.
 *
 * "eligible": the overlay had focus and should get it back on the next input.
 * "blocked": another component holds focus for now; when it lets go, focus
 * resumes to the overlay or to an explicit target.
 */
export class OverlayFocusRestore {
    state: FocusRestoreState = { status: "inactive" };

    clear(): void {
        this.state = { status: "inactive" };
    }

    clearFor(overlay: OverlayStackEntry): void {
        if (this.state.status !== "inactive" && this.state.overlay === overlay) {
            this.clear();
        }
    }

    isPendingFor(overlay: OverlayStackEntry): boolean {
        return this.state.status !== "inactive" && this.state.overlay === overlay;
    }

    markEligible(overlay: OverlayStackEntry): void {
        this.state = { status: "eligible", overlay };
    }

    block(overlay: OverlayStackEntry, blockedBy: Component, resume: BlockedResume): void {
        this.state = { status: "blocked", overlay, blockedBy, resume };
    }

    /** Where focus goes once the component blocking the overlay lets go. */
    resolveBlocked(blocked: BlockedState): Component | null {
        if (blocked.resume.status === "restore-overlay") return blocked.overlay.component;
        this.clear();
        return blocked.resume.target;
    }

    /** The current state, treated as inactive if its overlay is gone or hidden. */
    visibleState(isLive: (overlay: OverlayStackEntry) => boolean): FocusRestoreState {
        if (this.state.status === "inactive") return this.state;
        return isLive(this.state.overlay) ? this.state : { status: "inactive" };
    }
}
