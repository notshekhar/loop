import type { Component } from "../component";

/**
 * Anchor position for overlays
 */
export type OverlayAnchor =
    | "center"
    | "top-left"
    | "top-right"
    | "bottom-left"
    | "bottom-right"
    | "top-center"
    | "bottom-center"
    | "left-center"
    | "right-center";

/**
 * Margin configuration for overlays
 */
export interface OverlayMargin {
    top?: number;
    right?: number;
    bottom?: number;
    left?: number;
}

/** Value that can be absolute (number) or percentage (string like "50%") */
export type SizeValue = number | `${number}%`;

/**
 * Options for overlay positioning and sizing.
 * Values can be absolute numbers or percentage strings (e.g., "50%").
 */
export interface OverlayOptions {
    // === Sizing ===
    /** Width in columns, or percentage of terminal width (e.g., "50%") */
    width?: SizeValue;
    /** Minimum width in columns */
    minWidth?: number;
    /** Maximum height in rows, or percentage of terminal height (e.g., "50%") */
    maxHeight?: SizeValue;

    // === Positioning - anchor-based ===
    /** Anchor point for positioning (default: 'center') */
    anchor?: OverlayAnchor;
    /** Horizontal offset from anchor position (positive = right) */
    offsetX?: number;
    /** Vertical offset from anchor position (positive = down) */
    offsetY?: number;

    // === Positioning - percentage or absolute ===
    /** Row position: absolute number, or percentage (e.g., "25%" = 25% from top) */
    row?: SizeValue;
    /** Column position: absolute number, or percentage (e.g., "50%" = centered horizontally) */
    col?: SizeValue;

    // === Margin from terminal edges ===
    /** Margin from terminal edges. Number applies to all sides. */
    /**
     * loop-local (keep across pi-mono syncs): a margin may be a FUNCTION, read
     * once per composite, so an overlay can stay anchored to something whose
     * place in the frame moves — a menu held above a prompt that grows with the
     * draft. A fixed margin computed at showOverlay() time comes adrift the
     * moment the thing it was measured against changes height.
     */
    margin?: OverlayMargin | number | (() => OverlayMargin | number);

    // === Visibility ===
    /**
     * Control overlay visibility based on terminal dimensions.
     * If provided, overlay is only rendered when this returns true.
     * Called each render cycle with current terminal dimensions.
     */
    visible?: (termWidth: number, termHeight: number) => boolean;
    /** If true, don't capture keyboard focus when shown */
    nonCapturing?: boolean;
}

/** Options for {@link OverlayHandle.unfocus}. */
export interface OverlayUnfocusOptions {
    /** Explicit target to focus after releasing this overlay. */
    target: Component | null;
}

/** Last rendered terminal-relative overlay rectangle. */
export interface OverlayBounds {
    row: number;
    col: number;
    width: number;
    height: number;
}

/**
 * Where an overlay was last painted, in screen coordinates (0-based, row 0 =
 * the top visible row). See {@link OverlayStack.hitTest}.
 */
export interface OverlayRect {
    row: number;
    col: number;
    width: number;
    height: number;
}

/**
 * Handle returned by showOverlay for controlling the overlay
 */
export interface OverlayHandle {
    /** Permanently remove the overlay (cannot be shown again) */
    hide(): void;
    /** Temporarily hide or show the overlay */
    setHidden(hidden: boolean): void;
    /** Check if overlay is temporarily hidden */
    isHidden(): boolean;
    /** Focus this overlay and bring it to the visual front */
    focus(): void;
    /** Release focus to the next visible capturing overlay or previous target, or to an explicit target when provided */
    unfocus(options?: OverlayUnfocusOptions): void;
    /** Check if this overlay currently has focus */
    isFocused(): boolean;
    /** Get the most recent rendered bounds for a visible overlay. */
    getBounds(): OverlayBounds | undefined;
}

export interface OverlayLayout {
    width: number;
    row: number;
    col: number;
    maxHeight: number | undefined;
}
