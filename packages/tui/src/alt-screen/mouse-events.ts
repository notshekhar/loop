/** An SGR mouse report. Coordinates are 0-based cells. */
export interface SgrMouseEvent {
    button: number;
    x: number;
    y: number;
    release: boolean;
}

export interface WheelEvent {
    direction: -1 | 1;
    button: number;
    x: number;
    y: number;
}

// SGR button-code bits.
const BUTTON_MASK = 3;
const MOTION_BIT = 32;
const WHEEL_BIT = 64;
/** Bit 3 is the Alt modifier. */
const ALT_BIT = 8;

const SGR_MOUSE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/;

export function parseSgrMouseEvent(data: string): SgrMouseEvent | undefined {
    const match = SGR_MOUSE.exec(data);
    if (!match) return undefined;
    return {
        button: Number.parseInt(match[1], 10),
        x: Number.parseInt(match[2], 10) - 1,
        y: Number.parseInt(match[3], 10) - 1,
        release: match[4] === "m",
    };
}

/** A wheel notch, from an SGR report or a legacy X10 one. */
export function parseWheelEvent(data: string): WheelEvent | undefined {
    const sgr = SGR_MOUSE.exec(data);
    if (sgr) {
        return wheelFrom(Number.parseInt(sgr[1], 10), Number.parseInt(sgr[2], 10) - 1, Number.parseInt(sgr[3], 10) - 1);
    }
    if (isLegacyMouse(data)) {
        return wheelFrom(data.charCodeAt(3) - 32, data.charCodeAt(4) - 33, data.charCodeAt(5) - 33);
    }
    return undefined;
}

function wheelFrom(button: number, x: number, y: number): WheelEvent | undefined {
    if ((button & WHEEL_BIT) === 0) return undefined;
    const direction = button & BUTTON_MASK;
    if (direction !== 0 && direction !== 1) return undefined;
    return { direction: direction === 0 ? -1 : 1, button, x, y };
}

function isLegacyMouse(data: string): boolean {
    return data.length === 6 && data.startsWith("\x1b[M");
}

/** Any mouse report at all, so a stray one is swallowed instead of typed. */
export function isMouseSequence(data: string): boolean {
    return /^\x1b\[<\d+;\d+;\d+[Mm]$/.test(data) || isLegacyMouse(data);
}

/** A primary-button press: not a release, not a drag, not another button. */
export function isPrimaryPress(event: SgrMouseEvent): boolean {
    return !event.release && !isMotion(event) && (event.button & BUTTON_MASK) === 0;
}

export function isMotion(event: SgrMouseEvent): boolean {
    return (event.button & MOTION_BIT) !== 0;
}

export function buttonOf(event: SgrMouseEvent): number {
    return event.button & BUTTON_MASK;
}

export function hasAlt(event: { button: number }): boolean {
    return (event.button & ALT_BIT) !== 0;
}
