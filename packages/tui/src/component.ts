/**
 * Component interface - all components must implement this
 */
export interface Component {
    /**
     * Render the component to lines for the given viewport width
     * @param width - Current viewport width
     * @returns Array of strings, each representing a line
     */
    render(width: number): string[];

    /**
     * Optional handler for keyboard input when component has focus
     */
    handleInput?(data: string): void;

    /**
     * If true, component receives key release events (Kitty protocol).
     * Default is false - release events are filtered out.
     */
    wantsKeyRelease?: boolean;

    /**
     * Invalidate any cached rendering state.
     * Called when theme changes or when component needs to re-render from scratch.
     */
    invalidate(): void;
}

/**
 * Interface for components that can receive focus and display a hardware cursor.
 * When focused, the component should emit CURSOR_MARKER at the cursor position
 * in its render output. TUI will find this marker and position the hardware
 * cursor there for proper IME candidate window positioning.
 */
export interface Focusable {
    /** Set by TUI when focus changes. Component should emit CURSOR_MARKER when true. */
    focused: boolean;
}

/** Type guard to check if a component implements Focusable */
export function isFocusable(component: Component | null): component is Component & Focusable {
    return component !== null && "focused" in component;
}

/**
 * Cursor position marker - APC (Application Program Command) sequence.
 * This is a zero-width escape sequence that terminals ignore.
 * Components emit this at the cursor position when focused.
 * TUI finds and strips this marker, then positions the hardware cursor there.
 */
export const CURSOR_MARKER = "\x1b_pi:c\x07";

export type TuiInputListenerResult = { consume?: boolean; data?: string } | undefined;
export type TuiInputListener = (data: string) => TuiInputListenerResult;

/**
 * Container - a component that contains other components
 */
export class Container implements Component {
    children: Component[] = [];

    addChild(component: Component): void {
        this.children.push(component);
    }

    removeChild(component: Component): void {
        const index = this.children.indexOf(component);
        if (index !== -1) {
            this.children.splice(index, 1);
        }
    }

    clear(): void {
        this.children = [];
    }

    invalidate(): void {
        for (const child of this.children) {
            child.invalidate?.();
        }
    }

    render(width: number): string[] {
        const lines: string[] = [];
        for (const child of this.children) {
            const childLines = child.render(width);
            for (const line of childLines) {
                lines.push(line);
            }
        }
        return lines;
    }
}

/** True when `target` is `root` or sits anywhere inside it. */
export function containsComponent(root: Component, target: Component): boolean {
    if (root === target) return true;
    if (!(root instanceof Container)) return false;
    return root.children.some((child) => containsComponent(child, target));
}
