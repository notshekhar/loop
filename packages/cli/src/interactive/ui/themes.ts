/**
 * The themes loop ships: `night`, `day`, and `system`.
 *
 * Each is one `Palette` — about twenty primitives — and `themeFromPalette`
 * (see `palette.ts`) derives the ~55 theme slots from it. Embedded as TS so no
 * JSON assets need to ship next to the compiled binary.
 *
 * Night and day WASH the canvas: they claim the terminal's background (OSC 11)
 * and own every surface level relative to it. `system` is the same ink with no
 * canvas of its own, rebuilt for the background the terminal already has.
 *
 * The canvas, greys and semantic accents are GrokNight and GrokDay, taken from
 * grok-build's own theme files (`xai-grok-pager-render/src/theme/
 * {groknight,grokday}.rs`): a neutral grayscale ramp under TokyoNight's
 * accents. Markdown keeps loop's own softer set (NIGHT_MARKDOWN).
 */
import {
    atLeastContrast,
    contrastRatio,
    DARK_INK,
    LIGHT_INK,
    mix,
    type Palette,
    type ThemeJson,
    themeFromPalette,
} from "./palette";

export type { ThemeColors, ThemeJson, Palette, SyntaxPalette } from "./palette";
export { PRIMARY_DARK, PRIMARY_LIGHT, SYNTAX_DARK, SYNTAX_LIGHT, themeFromPalette } from "./palette";

/**
 * Markdown's colours — headings, inline code, code blocks, links and the
 * syntax set — are loop's own rather than grok's: a softer set held at one
 * lightness, which reads better in long prose than TokyoNight's saturated
 * hues. Everything else (canvas, greys, semantic accents) is grok's.
 */
const NIGHT_MARKDOWN = {
    heading: "#d5bb7b",
    inlineCode: "#d5afd7",
    codeBlock: "#a0cba5",
    accentLift: "#a2c0eb",
    syntax: {
        comment: "#6f6f6f",
        keyword: "#e6a9c5",
        function: "#beb6e8",
        variable: "#e2b293",
        string: "#a0cba5",
        number: "#87cbd5",
        type: "#d5afd7",
        operator: "#8a8a8a",
        punctuation: "#8a8a8a",
    },
} as const;

const DAY_MARKDOWN = {
    heading: "#7c5f00",
    inlineCode: "#7c527e",
    codeBlock: "#3f7047",
    accentLift: "#446493",
    syntax: {
        comment: "#767676",
        keyword: "#8c4a6b",
        function: "#645a90",
        variable: "#885531",
        string: "#3f7047",
        number: "#04707c",
        type: "#7c527e",
        operator: "#6b6b6b",
        punctuation: "#6b6b6b",
    },
} as const;

/**
 * GrokNight's ink, as grok itself defines it
 * (`xai-grok-pager-render/src/theme/groknight.rs`): a neutral grayscale ramp
 * anchored at `#141414`, wearing TokyoNight's accents.
 *
 * The hues carry meaning rather than decoration, and the mapping is grok's:
 * magenta is the model (its thinking), blue is the system talking, green
 * succeeded, red failed, yellow warns. Markdown wears loop's own set (above).
 */
const NIGHT_INK = {
    // grok's `fuzzy_accent`/`accent_system` blue — the one it uses for the
    // chrome that is loop talking rather than the model.
    accent: "#7aa2f7",
    warning: "#e0af68",
    error: "#f7768e",
    success: "#9ece6a",
    // `accent_thinking` — the model's own hue, which is why the thinking rail
    // and the effort ladder's top rung both ride it.
    thinkingPeak: "#bb9af7",
    ...NIGHT_MARKDOWN,
} as const;

/** GrokDay: the same hue family, deepened until it holds on a light canvas
 * (`grokday.rs`). */
const DAY_INK = {
    accent: "#2f64d2",
    warning: "#a27612",
    error: "#cd3048",
    success: "#378e23",
    thinkingPeak: "#7d4bc6",
    ...DAY_MARKDOWN,
} as const;

export const NIGHT_PALETTE: Palette = {
    ...DARK_INK,
    ...NIGHT_INK,
    name: "night",
    wash: true,
    // grok's `bg_base` / `bg_highlight` / `bg_dark`, and `selection_border`
    // for the chrome line.
    bg: "#141414",
    bgRaised: "#242424",
    bgSunken: "#1c1c1c",
    line: "#3c3c41",
    // `text_primary` / `text_secondary` / `gray`: one neutral ramp, no tint.
    text: "#e1e1e1",
    muted: "#c8c8c8",
    dim: "#6c6c6c",
    toolSurfaces: "flat",
};

export const DAY_PALETTE: Palette = {
    ...LIGHT_INK,
    ...DAY_INK,
    name: "day",
    wash: true,
    bg: "#eeeeee",
    bgRaised: "#dedede",
    bgSunken: "#e4e4e4",
    line: "#b9b9be",
    text: "#262626",
    muted: "#444444",
    dim: "#767676",
    toolSurfaces: "flat",
};

export const NIGHT_THEME: ThemeJson = themeFromPalette(NIGHT_PALETTE);
export const DAY_THEME: ThemeJson = themeFromPalette(DAY_PALETTE);

/**
 * `system` — the transcript WITHOUT a canvas.
 *
 * Night and day each claim the terminal's background and wash it (OSC 11/10).
 * That is right when you want their canvas, and wrong when your terminal
 * already has a background it means: a true black, a transparency, an image.
 * `system` gives that back — it washes nothing, so every row is drawn straight
 * onto whatever the terminal already was.
 *
 * Which ink it uses is not yours to configure: the terminal is ASKED (its
 * colour-scheme report, else its background colour) and the dark or light set
 * follows, live — flip your terminal to light mid-session and the transcript
 * follows it. That is the whole point of calling it `system` rather than
 * shipping two more theme names.
 *
 * Both variants keep their palette's `bg` even though nothing paints it: every
 * surface tint (selection, a custom message, a failed tool's fill) is MIXED
 * against it, so dropping it would drop those surfaces too. It stops being
 * painted; it stays the colour the rest is computed from.
 */
export const SYSTEM_THEME_NAME = "system";

/**
 * How far the two surface levels and the chrome line sit off the canvas.
 * Measured from night AND day, which agree on all three — the lift is a
 * relationship in the design, not a per-palette constant, which is why it
 * survives being moved onto a background neither palette chose.
 */
const LIFT = { raised: 0.05, sunken: 0.025, line: 0.13 } as const;

/**
 * The canvas to assume before the terminal has told us its own — the LIGHTEST
 * background a dark terminal plausibly has (and the darkest a light one does).
 *
 * Not a guess at the average: a guess at the worst case, because the ramp's
 * failure is one-sided. Solve for a canvas lighter than the real one and the
 * greys come out a little brighter than designed — no harm. Solve for a darker
 * one and they come out too faint to read, which is precisely the bug this
 * exists to prevent. It also has to be right from the FIRST paint: the probe's
 * answer lands a moment later, and by then the banner and the startup notices
 * have already baked their colours into the scrollback.
 */
const SAFE_CANVAS = { dark: "#2e2e2e", light: "#ececec" } as const;

/**
 * Build `system` for the canvas it is really drawn on.
 *
 * The ink cannot simply be night's. These colours are not those hexes because
 * the hexes are special — each is a RATIO against night's own `#141414`: text
 * at 16.9:1, muted at 5.3:1, dim deliberately faint at 2.9:1, the accent at
 * 6.9:1. Drop the same hexes onto a lighter terminal and every one of them
 * loses roughly a fifth of its contrast at once; that is not "text is a bit
 * dark", it is the whole palette sinking toward a background it was never
 * measured against.
 *
 * So EVERY colour is checked against the canvas that is actually there — the
 * greys, the semantic hues, the syntax set — and any that fell below the ratio
 * it holds on night's own canvas is lifted back to it. Lifted by tinting
 * toward white (or black on a light terminal), so a hue stays its hue: a
 * raised red is still red.
 *
 * One-sided, deliberately. A terminal DARKER than night's canvas makes every
 * slot more readable, not less, and pulling those back down to the exact ratio
 * would be dimming a screen that was already right. Only what fell below is
 * touched — which is why this is safe to run on every background, including
 * the ones that never needed it.
 */
function systemPalette(scheme: "dark" | "light", canvas?: string): Palette {
    const base = scheme === "light" ? DAY_PALETTE : NIGHT_PALETTE;
    const ground = canvas ?? SAFE_CANVAS[scheme];
    // Tinting past the ink toward pure white/black: on a background lighter
    // than the palette's own, the ratio a slot wants can sit beyond its ink.
    const pole = scheme === "light" ? "#000000" : "#ffffff";
    /** `slot`, still as legible here as it is on the palette's own canvas. */
    const held = (slot: string) => atLeastContrast(ground, slot, pole, contrastRatio(slot, base.bg));
    return {
        ...base,
        name: SYSTEM_THEME_NAME,
        wash: false,
        bg: ground,
        bgRaised: mix(ground, pole, LIFT.raised),
        bgSunken: mix(ground, pole, LIFT.sunken),
        line: mix(ground, pole, LIFT.line),
        text: held(base.text),
        muted: held(base.muted),
        dim: held(base.dim),
        accent: held(base.accent),
        accentLift: held(base.accentLift),
        success: held(base.success),
        error: held(base.error),
        warning: held(base.warning),
        heading: held(base.heading),
        inlineCode: held(base.inlineCode),
        codeBlock: held(base.codeBlock ?? base.success),
        thinkingPeak: held(base.thinkingPeak),
        syntax: {
            comment: held(base.syntax.comment),
            keyword: held(base.syntax.keyword),
            function: held(base.syntax.function),
            variable: held(base.syntax.variable),
            string: held(base.syntax.string),
            number: held(base.syntax.number),
            type: held(base.syntax.type),
            operator: held(base.syntax.operator),
            punctuation: held(base.syntax.punctuation),
        },
    };
}

/**
 * What the terminal last told us: which set to wear, and — when it reported a
 * background colour rather than just "dark"/"light" — the canvas to hold the
 * ramp's contrast against. Dark on the safe canvas until it answers, which is
 * the honest default for a terminal that never replies at all.
 */
let systemScheme: "dark" | "light" = "dark";
let systemCanvas: string | undefined;
let systemThemeJson: ThemeJson = themeFromPalette(systemPalette("dark"));

/** The `system` theme as the terminal currently reads. */
export function systemTheme(): ThemeJson {
    return systemThemeJson;
}

/**
 * The canvas `system` is drawn on — the terminal's own background when it told
 * us, else the set's. Rails and bullets blend toward it, and unlike a washed
 * theme there is no `bgBase` slot to read it back out of.
 */
export function systemCanvasHex(): string {
    return systemCanvas ?? SAFE_CANVAS[systemScheme];
}

/**
 * Record what the terminal reported. Returns true when it CHANGED — the caller
 * only has to re-resolve the theme and repaint when it did.
 */
export function setSystemScheme(scheme: "dark" | "light", canvas?: string): boolean {
    if (scheme === systemScheme && canvas === systemCanvas) return false;
    systemScheme = scheme;
    systemCanvas = canvas;
    systemThemeJson = themeFromPalette(systemPalette(scheme, canvas));
    return true;
}

/**
 * The themes a picker offers and `initTheme` resolves names against, in order.
 *
 * `system` is rebuilt whenever the terminal reports, so it is read through
 * `systemTheme()` on every call rather than captured once at module load.
 */
export function builtinThemes(): ThemeJson[] {
    return [NIGHT_THEME, DAY_THEME, systemTheme()];
}
