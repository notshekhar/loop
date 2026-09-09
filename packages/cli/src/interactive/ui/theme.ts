/**
 * Own theme engine.
 * Built-in palettes are embedded TS
 * data (no JSON assets shipped next to the binary, no typebox validation, no
 * file watcher). Custom themes still load from ~/.loop/agent/themes/<name>.json
 * using a simple theme JSON shape (vars + colors).
 */
import { CONFIG_DIR_NAME, settingsStore } from "@notshekhar/loop-core";
import * as fs from "node:fs";
import * as path from "node:path";
import type { MarkdownTheme, SelectListTheme } from "@notshekhar/loop-tui";
import chalk from "chalk";
import { luminance, mix } from "./palette";
import { DARK_THEME, type ThemeColors, type ThemeJson } from "./themes";
import { activeUiMode, setActiveUiMode, setLiveVariant, setToolDetail } from "./ui-mode";

export type ThemeColor = keyof ThemeColors & string;
export type ThemeBg =
    | "selectedBg"
    | "userMessageBg"
    | "customMessageBg"
    | "toolPendingBg"
    | "toolSuccessBg"
    | "toolErrorBg"
    | "bgBase"
    | "bgRaised";

type ColorMode = "truecolor" | "256color";
type ColorValue = string | number;

// ---------------------------------------------------------------------------
// Color conversion
// ---------------------------------------------------------------------------

function hexToRgb(hex: string): { r: number; g: number; b: number } {
    const cleaned = hex.replace("#", "");
    if (cleaned.length !== 6) throw new Error(`Invalid hex color: ${hex}`);
    const r = parseInt(cleaned.substring(0, 2), 16);
    const g = parseInt(cleaned.substring(2, 4), 16);
    const b = parseInt(cleaned.substring(4, 6), 16);
    if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) {
        throw new Error(`Invalid hex color: ${hex}`);
    }
    return { r, g, b };
}

const CUBE_VALUES = [0, 95, 135, 175, 215, 255];
const GRAY_VALUES = Array.from({ length: 24 }, (_, i) => 8 + i * 10);

function findClosest(values: number[], target: number): number {
    let minDist = Infinity;
    let minIdx = 0;
    for (let i = 0; i < values.length; i++) {
        const dist = Math.abs(target - values[i]);
        if (dist < minDist) {
            minDist = dist;
            minIdx = i;
        }
    }
    return minIdx;
}

function colorDistance(r1: number, g1: number, b1: number, r2: number, g2: number, b2: number): number {
    const dr = r1 - r2;
    const dg = g1 - g2;
    const db = b1 - b2;
    return dr * dr * 0.299 + dg * dg * 0.587 + db * db * 0.114;
}

function rgbTo256(r: number, g: number, b: number): number {
    const rIdx = findClosest(CUBE_VALUES, r);
    const gIdx = findClosest(CUBE_VALUES, g);
    const bIdx = findClosest(CUBE_VALUES, b);
    const cubeIndex = 16 + 36 * rIdx + 6 * gIdx + bIdx;
    const cubeDist = colorDistance(r, g, b, CUBE_VALUES[rIdx], CUBE_VALUES[gIdx], CUBE_VALUES[bIdx]);

    const gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
    const grayIdx = findClosest(GRAY_VALUES, gray);
    const grayDist = colorDistance(r, g, b, GRAY_VALUES[grayIdx], GRAY_VALUES[grayIdx], GRAY_VALUES[grayIdx]);

    const spread = Math.max(r, g, b) - Math.min(r, g, b);
    if (spread < 10 && grayDist < cubeDist) return 232 + grayIdx;
    return cubeIndex;
}

function fgAnsi(color: ColorValue, mode: ColorMode): string {
    if (color === "") return "\x1b[39m";
    if (typeof color === "number") return `\x1b[38;5;${color}m`;
    const { r, g, b } = hexToRgb(color);
    if (mode === "truecolor") return `\x1b[38;2;${r};${g};${b}m`;
    return `\x1b[38;5;${rgbTo256(r, g, b)}m`;
}

function bgAnsi(color: ColorValue, mode: ColorMode): string {
    if (color === "") return "\x1b[49m";
    if (typeof color === "number") return `\x1b[48;5;${color}m`;
    const { r, g, b } = hexToRgb(color);
    if (mode === "truecolor") return `\x1b[48;2;${r};${g};${b}m`;
    return `\x1b[48;5;${rgbTo256(r, g, b)}m`;
}

function resolveVarRefs(value: ColorValue, vars: Record<string, ColorValue>, visited = new Set<string>()): ColorValue {
    if (typeof value === "number" || value === "" || value.startsWith("#")) return value;
    if (visited.has(value)) throw new Error(`Circular variable reference: ${value}`);
    if (!(value in vars)) throw new Error(`Variable reference not found: ${value}`);
    visited.add(value);
    return resolveVarRefs(vars[value], vars, visited);
}

function detectColorMode(): ColorMode {
    const ct = process.env.COLORTERM ?? "";
    return /truecolor|24bit/i.test(ct) ? "truecolor" : "256color";
}

// ---------------------------------------------------------------------------
// Theme class
// ---------------------------------------------------------------------------

const BG_KEYS: ReadonlySet<string> = new Set<ThemeBg>([
    "selectedBg",
    "userMessageBg",
    "customMessageBg",
    "toolPendingBg",
    "toolSuccessBg",
    "toolErrorBg",
    "bgBase",
    "bgRaised",
]);

/**
 * The slots `series` cycles through, in order: gold, blue, magenta, cyan,
 * green, red, orange. Seven hues that every built-in theme already keeps
 * distinct from one another, because each is doing a different job elsewhere.
 */
const SERIES_SLOTS: readonly ThemeColor[] = [
    "mdHeading",
    "mdLink",
    "syntaxType",
    "syntaxNumber",
    "success",
    "error",
    "syntaxVariable",
];

/** How far along success each activity level sits, from the canvas outward. */
const HEAT_STEPS = [0.3, 0.55, 0.78, 1] as const;

export class Theme {
    readonly name: string;
    private fgColors = new Map<string, string>();
    private bgColors = new Map<string, string>();
    private rawColors = new Map<string, ColorValue>();
    /** Escapes computed from the palette rather than read from a slot. */
    private derived = new Map<string, string>();
    private readonly mode: ColorMode;

    constructor(json: ThemeJson, mode: ColorMode = detectColorMode()) {
        this.name = json.name;
        this.mode = mode;
        const vars = json.vars ?? {};
        for (const [key, raw] of Object.entries(json.colors)) {
            const value = resolveVarRefs(raw, vars);
            this.rawColors.set(key, value);
            if (BG_KEYS.has(key)) this.bgColors.set(key, bgAnsi(value, mode));
            else this.fgColors.set(key, fgAnsi(value, mode));
        }
    }

    /** The slot's resolved raw value (hex / 256-index / "" for terminal
     * default), for uses beyond SGR text — e.g. the OSC 11 canvas wash. */
    raw(color: ThemeColor | ThemeBg): ColorValue | undefined {
        return this.rawColors.get(color);
    }

    fg(color: ThemeColor, text: string): string {
        const ansi = this.fgColors.get(color);
        if (!ansi) throw new Error(`Unknown theme color: ${color}`);
        return `${ansi}${text}\x1b[39m`;
    }

    bg(color: ThemeBg, text: string): string {
        const ansi = this.bgColors.get(color);
        if (!ansi) throw new Error(`Unknown theme background color: ${color}`);
        return `${ansi}${text}\x1b[49m`;
    }

    /**
     * The i-th categorical swatch, cycling. Chart colours are not their own
     * slots: they reuse hues the palette already carries and already keeps
     * distinct, so a theme that never heard of the context chart still paints
     * a legible one — and a custom theme gets a matching chart for free rather
     * than seven more slots to fill in.
     */
    series(i: number, text: string): string {
        return this.fg(SERIES_SLOTS[i % SERIES_SLOTS.length], text);
    }

    /** How many distinct swatches `series` can hand out before repeating. */
    get seriesLength(): number {
        return SERIES_SLOTS.length;
    }

    /**
     * A step on the activity ramp, 0 (nothing) through `HEAT_STEPS.length`
     * (busiest) — the usage wall's squares. Built by walking the success
     * colour out of the canvas, so it reads as one colour deepening rather
     * than the fixed GitHub greens sitting on whatever background it lands on.
     */
    heat(level: number, text: string): string {
        if (level <= 0) return this.fg("thinkingOff", text);
        const key = `heat${level}`;
        let ansi = this.derived.get(key);
        if (!ansi) {
            const success = this.rawColors.get("success");
            const floor = this.isLight ? "#ffffff" : "#000000";
            const step = HEAT_STEPS[Math.min(level, HEAT_STEPS.length) - 1];
            ansi =
                typeof success === "string" && success.startsWith("#")
                    ? fgAnsi(mix(floor, success, step), this.mode)
                    : (this.fgColors.get("success") ?? "");
            this.derived.set(key, ansi);
        }
        return `${ansi}${text}\x1b[39m`;
    }

    /** True when this theme paints dark text, i.e. it is built for a light terminal. */
    get isLight(): boolean {
        const text = this.rawColors.get("text");
        return typeof text === "string" && text.startsWith("#") ? luminance(text) < 0.5 : false;
    }

    bold(text: string): string {
        return chalk.bold(text);
    }
    italic(text: string): string {
        return chalk.italic(text);
    }
    underline(text: string): string {
        return chalk.underline(text);
    }
}

// ---------------------------------------------------------------------------
// Global theme instance
// ---------------------------------------------------------------------------

let activeTheme: Theme | null = null;

/** Proxy so `theme.fg(...)` always resolves against the active theme. */
export const theme: Theme = new Proxy({} as Theme, {
    get(_target, prop) {
        if (!activeTheme) throw new Error("Theme not initialized. Call initTheme() first.");
        return (activeTheme as unknown as Record<string | symbol, unknown>)[prop];
    },
});

/** Whether a theme has been activated yet — lets helpers degrade to plain
 * chalk on paths that run before `initTheme` (print mode, early startup). */
export function themeReady(): boolean {
    return activeTheme !== null;
}

/**
 * Colour text with a hex outside the theme's named slots, honouring the
 * terminal's colour depth exactly as `theme.fg` does. For values a theme
 * cannot name because they are computed — the welcome banner interpolates a
 * gradient from the accent, and a slot per step would be absurd.
 */
export function fgHex(hex: string, text: string): string {
    return `${fgAnsi(hex, detectColorMode())}${text}\x1b[39m`;
}

/** As {@link fgHex}, but painting the cell's background. */
export function bgHex(hex: string, text: string): string {
    return `${bgAnsi(hex, detectColorMode())}${text}\x1b[49m`;
}

/**
 * One cell of a continuous vertical rule in `hex`.
 *
 * Terminals paint a cell's BACKGROUND across the whole cell rectangle, but a
 * glyph only covers its own ink extent — so on any terminal whose line height
 * exceeds the font's glyph box (macOS Terminal.app, notably, and anything with
 * line spacing turned up) a column of `█` or `┃` renders as a dashed line with
 * gaps between the rows. Painting a space's background instead is gapless
 * everywhere, because there is no glyph to fall short.
 *
 * Only Terminal.app takes the background path: elsewhere the glyph is sharper
 * (it can be a THIN rule rather than a full cell), and a full-width background
 * bar is a heavier mark than the design wants.
 */
export function verticalRule(hex: string, glyph = "█"): string {
    return process.env.TERM_PROGRAM === "Apple_Terminal" ? bgHex(hex, " ") : fgHex(hex, glyph);
}

/**
 * {@link verticalRule} for a bar whose colour comes from a theme slot.
 *
 * Falls back to plain foreground painting when the slot is a 256-index or the
 * terminal default — there is no hex to hand the background path, and a
 * mis-coloured bar is worse than a gapped one.
 */
export function verticalRuleSlot(slot: ThemeColor, glyph = "█"): string {
    const raw = theme.raw(slot);
    return typeof raw === "string" && raw.startsWith("#") ? verticalRule(raw, glyph) : theme.fg(slot, glyph);
}

/**
 * True when the active theme paints dark text — i.e. it is meant for a light
 * terminal. Derived from the `text` slot rather than the theme's name so
 * custom themes and extension modes classify correctly too.
 */
export function isLightTheme(): boolean {
    return activeTheme?.isLight ?? false;
}

function customThemesDir(): string {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
    return path.join(home, CONFIG_DIR_NAME, "agent", "themes");
}

/** Fill missing slots from the builtin dark theme — custom files written
 * before a slot existed, and mode themes (extensions) that skip optional
 * slots, would otherwise make theme.fg() throw at render time. Vars merge
 * too: the inherited color values are var REFERENCES into dark's vars. */
function withDarkFallback(json: ThemeJson): ThemeJson {
    return {
        ...json,
        vars: { ...DARK_THEME.vars, ...json.vars },
        colors: { ...DARK_THEME.colors, ...json.colors },
    };
}

function loadThemeJson(name: string): ThemeJson {
    // The active UI mode's own themes first (loop owns dark/light), then the
    // user's custom theme files.
    const builtin = activeUiMode().themes.find((t) => t.name === name);
    if (builtin) return withDarkFallback(builtin);
    const file = path.join(customThemesDir(), `${name}.json`);
    return withDarkFallback(JSON.parse(fs.readFileSync(file, "utf8")) as ThemeJson);
}

export function initTheme(themeName = "dark"): void {
    const fallback = activeUiMode().themes[0] ?? DARK_THEME;
    try {
        activeTheme = new Theme(loadThemeJson(themeName));
    } catch {
        activeTheme = new Theme(withDarkFallback(fallback));
    }
}

/**
 * Activate the configured UI mode and its theme (startup and /reload).
 * Noir is the default when no uiMode is set. Mode themes resolve from
 * `uiThemes[modeId]`; loop keeps honoring the legacy `theme` key. Unknown
 * modes (e.g. an uninstalled extension's) fall back to loop rather than
 * failing startup.
 */
export function initUiModeAndTheme(): void {
    const raw = (settingsStore.get("uiMode") as string | undefined) ?? "noir";
    // The dark-canvas mode shipped briefly as "grok" — honor old settings.
    const modeId = raw === "grok" ? "noir" : raw;
    if (!setActiveUiMode(modeId)) setActiveUiMode("loop");
    const mode = activeUiMode();
    const perMode = settingsStore.get("uiThemes") as Record<string, string> | undefined;
    const legacy = mode.id === "loop" ? (settingsStore.get("theme") as string | undefined) : undefined;
    const perModeTheme = perMode?.[mode.id] ?? (mode.id === "noir" ? perMode?.grok : undefined);
    initTheme(perModeTheme ?? legacy ?? mode.themes[0]?.name ?? "dark");
    // Which VARIANT of that mode to start in. Only ever on for a mode that
    // defines one, so a saved preference can't strand a mode in a state it
    // has no look for.
    setLiveVariant(Boolean(settingsStore.get("uiLive")) && Boolean(activeUiMode().live));
    // How much of a finished call to show. Unknown values (a hand-edited
    // settings file) fall back rather than resolving to a style nobody defined.
    const detail = settingsStore.get("toolDetail");
    setToolDetail(detail === "compact" || detail === "full" ? detail : "normal");
}

// ---------------------------------------------------------------------------
// Syntax highlighting (highlight.js/lib/common — ~35 languages instead of
// a curated set; covers everything in getLanguageFromPath that matters)
// ---------------------------------------------------------------------------

import hljs from "highlight.js/lib/common";

type HighlightTheme = Record<string, (s: string) => string>;

let cachedHighlightTheme: HighlightTheme | null = null;
let cachedHighlightFor: Theme | null = null;

function getHighlightTheme(): HighlightTheme {
    if (cachedHighlightFor !== activeTheme || !cachedHighlightTheme) {
        cachedHighlightFor = activeTheme;
        cachedHighlightTheme = {
            keyword: (s) => theme.fg("syntaxKeyword", s),
            built_in: (s) => theme.fg("syntaxType", s),
            literal: (s) => theme.fg("syntaxNumber", s),
            number: (s) => theme.fg("syntaxNumber", s),
            string: (s) => theme.fg("syntaxString", s),
            comment: (s) => theme.fg("syntaxComment", s),
            function: (s) => theme.fg("syntaxFunction", s),
            title: (s) => theme.fg("syntaxFunction", s),
            class: (s) => theme.fg("syntaxType", s),
            type: (s) => theme.fg("syntaxType", s),
            attr: (s) => theme.fg("syntaxVariable", s),
            variable: (s) => theme.fg("syntaxVariable", s),
            params: (s) => theme.fg("syntaxVariable", s),
            operator: (s) => theme.fg("syntaxOperator", s),
            punctuation: (s) => theme.fg("syntaxPunctuation", s),
        };
    }
    return cachedHighlightTheme;
}

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#x27;": "'" };

/** Convert hljs HTML span markup to ANSI using the active theme. */
function renderHighlightedHtml(html: string, hlTheme: HighlightTheme): string {
    let output = "";
    let textBuffer = "";
    const scopes: Array<string | undefined> = [];

    const formatterFor = (scope: string): ((s: string) => string) | undefined => {
        if (hlTheme[scope]) return hlTheme[scope];
        const dot = scope.indexOf(".");
        if (dot !== -1 && hlTheme[scope.slice(0, dot)]) return hlTheme[scope.slice(0, dot)];
        const dash = scope.indexOf("-");
        if (dash !== -1 && hlTheme[scope.slice(0, dash)]) return hlTheme[scope.slice(0, dash)];
        return undefined;
    };

    const flush = () => {
        if (!textBuffer) return;
        let formatter: ((s: string) => string) | undefined;
        for (let i = scopes.length - 1; i >= 0; i--) {
            const scope = scopes[i];
            if (scope) {
                formatter = formatterFor(scope);
                if (formatter) break;
            }
        }
        output += formatter ? formatter(textBuffer) : textBuffer;
        textBuffer = "";
    };

    let i = 0;
    while (i < html.length) {
        if (html.startsWith("<span", i)) {
            const end = html.indexOf(">", i + 5);
            if (end !== -1) {
                flush();
                const tag = html.slice(i, end + 1);
                const m = /class\s*=\s*"([^"]*)"/.exec(tag);
                const cls = m?.[1]?.split(/\s+/).find((c) => c.startsWith("hljs-"));
                scopes.push(cls ? cls.slice(5) : undefined);
                i = end + 1;
                continue;
            }
        }
        if (html.startsWith("</span>", i)) {
            flush();
            scopes.pop();
            i += 7;
            continue;
        }
        if (html[i] === "&") {
            const entity = Object.keys(ENTITIES).find((e) => html.startsWith(e, i));
            if (entity) {
                textBuffer += ENTITIES[entity];
                i += entity.length;
                continue;
            }
        }
        textBuffer += html[i];
        i++;
    }
    flush();
    return output;
}

export function highlightCode(code: string, lang?: string): string[] {
    // No valid language → plain mdCodeBlock color. Auto-detection is unreliable
    // (mirrors reasoning), so we never auto-detect.
    const validLang = lang && hljs.getLanguage(lang) ? lang : undefined;
    if (!validLang) return code.split("\n").map((line) => theme.fg("mdCodeBlock", line));
    try {
        const html = hljs.highlight(code, { language: validLang, ignoreIllegals: true }).value;
        return renderHighlightedHtml(html, getHighlightTheme()).split("\n");
    } catch {
        return code.split("\n").map((line) => theme.fg("mdCodeBlock", line));
    }
}

const EXT_TO_LANG: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    py: "python",
    rb: "ruby",
    rs: "rust",
    go: "go",
    java: "java",
    kt: "kotlin",
    swift: "swift",
    c: "c",
    h: "c",
    cpp: "cpp",
    cc: "cpp",
    cxx: "cpp",
    hpp: "cpp",
    cs: "csharp",
    php: "php",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    sql: "sql",
    html: "html",
    htm: "html",
    css: "css",
    scss: "scss",
    less: "less",
    json: "json",
    yaml: "yaml",
    yml: "yaml",
    toml: "ini",
    xml: "xml",
    md: "markdown",
    markdown: "markdown",
    makefile: "makefile",
    lua: "lua",
    perl: "perl",
    r: "r",
    scala: "scala",
    graphql: "graphql",
};

export function getLanguageFromPath(filePath: string): string | undefined {
    const ext = filePath.split(".").pop()?.toLowerCase();
    return ext ? EXT_TO_LANG[ext] : undefined;
}

// ---------------------------------------------------------------------------
// TUI theme adapters
// ---------------------------------------------------------------------------

export function getMarkdownTheme(): MarkdownTheme {
    return {
        heading: (text) => theme.fg("mdHeading", text),
        link: (text) => theme.fg("mdLink", text),
        linkUrl: (text) => theme.fg("mdLinkUrl", text),
        code: (text) => theme.fg("mdCode", text),
        codeBlock: (text) => theme.fg("mdCodeBlock", text),
        codeBlockBorder: (text) => theme.fg("mdCodeBlockBorder", text),
        quote: (text) => theme.fg("mdQuote", text),
        quoteBorder: (text) => theme.fg("mdQuoteBorder", text),
        hr: (text) => theme.fg("mdHr", text),
        listBullet: (text) => theme.fg("mdListBullet", text),
        bold: (text) => theme.bold(text),
        italic: (text) => theme.italic(text),
        underline: (text) => theme.underline(text),
        strikethrough: (text) => chalk.strikethrough(text),
        highlightCode: (code, lang) => highlightCode(code, lang),
        diagram: {
            // Structure recedes, prose reads at normal weight: a diagram whose
            // boxes shout louder than their labels is harder to follow, not easier.
            border: (text) => theme.fg("mdCodeBlockBorder", text),
            edge: (text) => theme.fg("mdCodeBlockBorder", text),
            label: (text) => theme.fg("mdCodeBlock", text),
            accent: (text) => theme.fg("mdHeading", text),
            muted: (text) => theme.fg("muted", text),
        },
    };
}

export function getSelectListTheme(): SelectListTheme {
    return {
        selectedPrefix: (text) => theme.fg("accent", text),
        selectedText: (text) => theme.fg("accent", text),
        description: (text) => theme.fg("muted", text),
        scrollInfo: (text) => theme.fg("muted", text),
        noMatch: (text) => theme.fg("muted", text),
    };
}
