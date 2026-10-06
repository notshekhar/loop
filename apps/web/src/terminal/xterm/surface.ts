/**
 * The terminal surface, on xterm.js.
 *
 * This replaces the libghostty-vt canvas surface (terminal/ghostty), which
 * reimplemented input, IME, selection, scrolling and painting by hand on a 2D
 * canvas — and showed it: missing cursors, stray reflow artifacts after a
 * resize, and keys that never reached the shell. xterm.js is what VS Code and
 * Synara run; its WebGL renderer, Unicode 11 widths and textarea input path
 * are years ahead of anything this repo can maintain.
 *
 * The class keeps the old surface's API on purpose (create / write / fit /
 * selection / theme, with the same option callbacks), so TerminalViewport and
 * its tests did not have to learn a new shape.
 */
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal, type IDisposable, type ILink, type ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

import { isMacPlatform } from "../../lib/utils";
import {
  collectWrappedTerminalLinkLine,
  extractTerminalLinks,
  resolveWrappedTerminalLinkRange,
  wrappedTerminalLinkRangeIntersectsBufferLine,
} from "../../terminal-links";
import symbolsFontUrl from "./SymbolsNerdFontMono-Regular.woff2?url";

export interface TerminalColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

export interface TerminalTheme {
  readonly foreground: TerminalColor;
  readonly background: TerminalColor;
  readonly cursor: TerminalColor;
  readonly selectionBackground?: string;
  /** ANSI 0-15. 16-255 are the fixed cube and greyscale ramp under any theme. */
  readonly palette?: readonly TerminalColor[];
}

export interface TerminalFont {
  readonly family?: string;
  readonly size?: number;
}

/** Zero-based buffer rows, as the line-range helpers expect. */
export interface TerminalSelectionPosition {
  readonly start: { readonly x: number; readonly y: number };
  readonly end: { readonly x: number; readonly y: number };
}

export interface TerminalSurfaceOptions {
  readonly theme: TerminalTheme;
  readonly font?: TerminalFont;
  readonly onData: (data: string) => void;
  readonly onResize: (cols: number, rows: number) => void;
  readonly onSelectionChange: () => void;
  readonly onCopy: (text: string) => void;
  /** Return false to keep the key from the shell (the app handled it). */
  readonly beforeKey: (event: KeyboardEvent) => boolean;
  readonly onLinkActivate: (text: string, event: MouseEvent) => void;
}

export const DEFAULT_TERMINAL_FONT_SIZE = 12;
const MIN_TERMINAL_FONT_SIZE = 6;
const MAX_TERMINAL_FONT_SIZE = 32;
// Only symbols the text faces lack (powerline separators, devicons, prompt
// glyphs) come from these, so a shell themed for a Nerd Font keeps its prompt.
const TERMINAL_GLYPH_FALLBACKS =
  '"Symbols Nerd Font Mono", "Symbols Nerd Font", "JetBrainsMono Nerd Font", ' +
  '"JetBrainsMono NF", "FiraCode Nerd Font", "Hack Nerd Font", "MesloLGS NF", ' +
  '"CaskaydiaCove Nerd Font", "PowerlineSymbols", monospace';
export const DEFAULT_TERMINAL_FONT_FAMILY =
  '"SF Mono", "SFMono-Regular", "JetBrains Mono", ' + TERMINAL_GLYPH_FALLBACKS;
/** The PTY hears about a size only once a drag settles; see notifyResize. */
const RESIZE_SETTLE_MS = 150;
/** Native paste gets this long to arrive before the clipboard read stands in. */
const PASTE_FALLBACK_MS = 60;

export function terminalFontFamily(family?: string): string {
  const requested = family?.trim();
  return requested ? `${requested}, ${TERMINAL_GLYPH_FALLBACKS}` : DEFAULT_TERMINAL_FONT_FAMILY;
}

export function terminalFontSize(size?: number): number {
  if (size === undefined || !Number.isFinite(size)) return DEFAULT_TERMINAL_FONT_SIZE;
  return Math.min(MAX_TERMINAL_FONT_SIZE, Math.max(MIN_TERMINAL_FONT_SIZE, Math.round(size)));
}

export function isTerminalCopyShortcut(
  event: Pick<KeyboardEvent, "ctrlKey" | "key" | "metaKey" | "shiftKey">,
  platform = navigator.platform,
): boolean {
  if (event.key.toLowerCase() !== "c") return false;
  return isMacPlatform(platform) ? event.metaKey : event.ctrlKey && event.shiftKey;
}

export function isTerminalPasteShortcut(
  event: Pick<KeyboardEvent, "ctrlKey" | "key" | "metaKey" | "shiftKey">,
  platform = navigator.platform,
): boolean {
  if (event.key.toLowerCase() !== "v") return false;
  return isMacPlatform(platform) ? event.metaKey : event.ctrlKey && event.shiftKey;
}

function cssColor({ r, g, b }: TerminalColor): string {
  const hex = (value: number) =>
    Math.max(0, Math.min(255, Math.round(value)))
      .toString(16)
      .padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

const ANSI_KEYS = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;

export function xtermTheme(theme: TerminalTheme): ITheme {
  const result: Record<string, string> = {
    foreground: cssColor(theme.foreground),
    background: cssColor(theme.background),
    cursor: cssColor(theme.cursor),
    // The cursor block's glyph is drawn in the background color, so the
    // character under a block cursor stays readable.
    cursorAccent: cssColor(theme.background),
  };
  if (theme.selectionBackground) result.selectionBackground = theme.selectionBackground;
  // xterm 6 draws its own scrollbar; by default a wide opaque grey slab.
  const foreground = cssColor(theme.foreground);
  result.scrollbarSliderBackground = `${foreground}26`;
  result.scrollbarSliderHoverBackground = `${foreground}40`;
  result.scrollbarSliderActiveBackground = `${foreground}59`;
  theme.palette?.slice(0, ANSI_KEYS.length).forEach((color, index) => {
    result[ANSI_KEYS[index]!] = cssColor(color);
  });
  return result as ITheme;
}

let symbolsFontLoad: Promise<void> | null = null;

/**
 * Register the bundled symbols-only Nerd Font once per page. It carries no
 * regular text glyphs, so it composes with any face without moving metrics.
 */
function ensureTerminalSymbolsFont(): Promise<void> {
  if (symbolsFontLoad !== null) return symbolsFontLoad;
  symbolsFontLoad = (async () => {
    try {
      const face = new FontFace("Symbols Nerd Font Mono", `url(${symbolsFontUrl})`);
      document.fonts.add(await face.load());
    } catch {
      // Locally installed fallback faces still apply.
    }
  })();
  return symbolsFontLoad;
}

/**
 * zsh's PROMPT_SP marker, when it begins a line: an inverse `%` (or `#`), then
 * columns-1 spaces, then `\r \r`. At the width it was printed for it erases
 * itself; replayed into a narrower terminal (a split, a reopened drawer) the
 * spaces wrap and leave a lone `%` over a blank line. Only the column-0 form
 * is dropped — after partial output (`abc%`) the marker is real information.
 */
const ZSH_LINE_START_EOL_MARK =
  // eslint-disable-next-line no-control-regex
  /(^|\n)(?:\x1b\[[0-9;]*m)*[%#](?:\x1b\[[0-9;]*m)* {2,}\r \r/g;

export function stripReplayedPromptMarks(data: string): string {
  return data.replace(ZSH_LINE_START_EOL_MARK, "$1");
}

export class TerminalSurface {
  private readonly terminal: Terminal;
  private readonly fitAddon = new FitAddon();
  private webgl: WebglAddon | null = null;
  private readonly mount: HTMLElement;
  private readonly host: HTMLDivElement;
  private readonly options: TerminalSurfaceOptions;
  private readonly resizeObserver: ResizeObserver;
  private readonly disposables: IDisposable[] = [];
  private resizeNotifyTimer: number | null = null;
  private resizeNotified = false;
  private pasteFallbackTimer: number | null = null;
  private disposed = false;

  private constructor(mount: HTMLElement, options: TerminalSurfaceOptions) {
    this.mount = mount;
    this.options = options;
    this.host = document.createElement("div");
    this.host.className = "loop-terminal-host";
    this.host.style.cssText = "width:100%;height:100%;";
    mount.replaceChildren(this.host);

    this.terminal = new Terminal({
      allowProposedApi: true,
      fontFamily: terminalFontFamily(options.font?.family),
      fontSize: terminalFontSize(options.font?.size),
      lineHeight: 1.2,
      cursorBlink: true,
      cursorStyle: "block",
      cursorInactiveStyle: "outline",
      scrollback: 10_000,
      macOptionIsMeta: false,
      macOptionClickForcesSelection: true,
      rightClickSelectsWord: false,
      drawBoldTextInBrightColors: false,
      minimumContrastRatio: 1,
      smoothScrollDuration: 0,
      theme: xtermTheme(options.theme),
    });
    this.terminal.loadAddon(this.fitAddon);
    const unicode = new Unicode11Addon();
    this.terminal.loadAddon(unicode);
    this.terminal.unicode.activeVersion = "11";
    this.terminal.open(this.host);
    this.loadWebgl();

    this.disposables.push(
      this.terminal.onData((data) => options.onData(data)),
      this.terminal.onBinary((data) => options.onData(data)),
      this.terminal.onSelectionChange(() => options.onSelectionChange()),
      this.terminal.registerLinkProvider({
        provideLinks: (bufferLineNumber, callback) => callback(this.linksForLine(bufferLineNumber)),
      }),
    );
    this.terminal.attachCustomKeyEventHandler((event) => this.handleKey(event));
    this.terminal.textarea?.addEventListener("paste", this.onNativePaste, true);

    this.resizeObserver = new ResizeObserver(() => this.fit());
    this.resizeObserver.observe(mount);
  }

  static async create(
    mount: HTMLElement,
    options: TerminalSurfaceOptions,
  ): Promise<TerminalSurface> {
    const family = terminalFontFamily(options.font?.family);
    const size = terminalFontSize(options.font?.size);
    try {
      // Cell metrics come from the faces that will render; measuring before
      // they load sizes the grid from a fallback font.
      await ensureTerminalSymbolsFont();
      await document.fonts.load(`${size}px ${family}`);
    } catch {
      // Metrics fall back to whichever faces are already available.
    }
    const surface = new TerminalSurface(mount, options);
    surface.fit();
    return surface;
  }

  /**
   * WebGL paints crisp text and keeps up with fast output. A lost context (GPU
   * reset, too many live contexts) falls back to xterm's DOM renderer rather
   * than leaving a blank pane.
   */
  private loadWebgl(): void {
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        webgl.dispose();
        if (this.webgl === webgl) this.webgl = null;
      });
      this.terminal.loadAddon(webgl);
      this.webgl = webgl;
    } catch {
      this.webgl = null;
    }
  }

  private handleKey(event: KeyboardEvent): boolean {
    // xterm calls this for keydown, keypress and keyup alike; the app's
    // shortcuts are keydown decisions, and replaying them on keyup would send
    // navigation sequences twice.
    if (event.type !== "keydown") return true;
    if (isTerminalCopyShortcut(event) && this.terminal.hasSelection()) {
      event.preventDefault();
      this.options.onCopy(this.terminal.getSelection());
      return false;
    }
    if (isTerminalPasteShortcut(event)) {
      this.schedulePasteFallback();
      // Not handled here: the native paste event, when the platform fires one,
      // reaches xterm's textarea and is bracketed like any other paste.
      return false;
    }
    return this.options.beforeKey(event);
  }

  /**
   * Some shells (Electron without an Edit menu, some browsers) never turn the
   * paste chord into a paste event. A clipboard read stands in for those, and
   * stands down the moment a native paste does arrive.
   */
  private schedulePasteFallback(): void {
    if (this.pasteFallbackTimer !== null) window.clearTimeout(this.pasteFallbackTimer);
    this.pasteFallbackTimer = window.setTimeout(() => {
      this.pasteFallbackTimer = null;
      const clipboard = navigator.clipboard;
      if (this.disposed || typeof clipboard?.readText !== "function") return;
      void clipboard.readText().then(
        (text) => {
          if (!this.disposed && text) this.terminal.paste(text);
        },
        () => {
          // Read denied: nothing else to do; the chord did nothing natively either.
        },
      );
    }, PASTE_FALLBACK_MS);
  }

  private readonly onNativePaste = () => {
    if (this.pasteFallbackTimer !== null) {
      window.clearTimeout(this.pasteFallbackTimer);
      this.pasteFallbackTimer = null;
    }
  };

  private linksForLine(bufferLineNumber: number): ILink[] | undefined {
    const buffer = this.terminal.buffer.active;
    const wrapped = collectWrappedTerminalLinkLine(bufferLineNumber, (index) =>
      buffer.getLine(index),
    );
    if (!wrapped) return undefined;
    const links: ILink[] = [];
    for (const match of extractTerminalLinks(wrapped.text)) {
      const range = resolveWrappedTerminalLinkRange(wrapped, match);
      if (!wrappedTerminalLinkRangeIntersectsBufferLine(range, bufferLineNumber)) continue;
      links.push({
        range,
        text: match.text,
        decorations: { underline: true, pointerCursor: true },
        activate: (event) => this.options.onLinkActivate(match.text, event),
      });
    }
    return links.length > 0 ? links : undefined;
  }

  get cols(): number {
    return this.terminal.cols;
  }

  get rows(): number {
    return this.terminal.rows;
  }

  write(data: string): void {
    if (this.disposed) return;
    this.terminal.write(data);
  }

  /** Replays a session's history (attach, remount, or a non-append update). */
  resetAndWrite(data: string): void {
    if (this.disposed) return;
    this.terminal.reset();
    this.terminal.write(stripReplayedPromptMarks(data));
  }

  setTheme(theme: TerminalTheme): void {
    if (this.disposed) return;
    this.terminal.options.theme = xtermTheme(theme);
  }

  async setFont(font: TerminalFont): Promise<void> {
    if (this.disposed) return;
    const family = terminalFontFamily(font.family);
    const size = terminalFontSize(font.size);
    try {
      await document.fonts.load(`${size}px ${family}`);
    } catch {
      // Metrics fall back to whichever faces are already available.
    }
    if (this.disposed) return;
    this.terminal.options.fontFamily = family;
    this.terminal.options.fontSize = size;
    this.fit();
  }

  fit(): boolean {
    if (this.disposed) return false;
    if (this.mount.clientWidth <= 0 || this.mount.clientHeight <= 0) return false;
    const before = { cols: this.terminal.cols, rows: this.terminal.rows };
    const dimensions = this.fitAddon.proposeDimensions();
    if (!dimensions || !Number.isFinite(dimensions.cols) || !Number.isFinite(dimensions.rows)) {
      return false;
    }
    const cols = Math.max(2, dimensions.cols);
    const rows = Math.max(1, dimensions.rows);
    if (cols !== before.cols || rows !== before.rows) this.terminal.resize(cols, rows);
    // The first successful fit always notifies: the PTY starts at its own
    // default size and must hear the real one even if it happens to match.
    if (cols !== before.cols || rows !== before.rows || !this.resizeNotified) this.notifyResize();
    return true;
  }

  /**
   * The local grid reflows at once, but the PTY hears only settled sizes:
   * notifying on every drag step makes the shell reprint its prompt mid-drag.
   */
  private notifyResize(): void {
    this.resizeNotified = true;
    if (this.resizeNotifyTimer !== null) window.clearTimeout(this.resizeNotifyTimer);
    this.resizeNotifyTimer = window.setTimeout(() => {
      this.resizeNotifyTimer = null;
      if (!this.disposed) this.options.onResize(this.terminal.cols, this.terminal.rows);
    }, RESIZE_SETTLE_MS);
  }

  focus(): void {
    this.terminal.focus();
  }

  hasSelection(): boolean {
    return this.terminal.hasSelection();
  }

  getSelection(): string {
    return this.terminal.getSelection();
  }

  getSelectionPosition(): TerminalSelectionPosition | null {
    const range = this.terminal.getSelectionPosition();
    if (!range) return null;
    return { start: { ...range.start }, end: { ...range.end } };
  }

  /** Where the selection ends on screen, for anchoring its action menu. */
  getSelectionEndClientRect(): { readonly right: number; readonly bottom: number } | null {
    const range = this.terminal.getSelectionPosition();
    const screen = this.host.querySelector<HTMLElement>(".xterm-screen");
    if (!range || !screen) return null;
    const viewportRow = range.end.y - this.terminal.buffer.active.viewportY;
    if (viewportRow < 0 || viewportRow >= this.terminal.rows) return null;
    const bounds = screen.getBoundingClientRect();
    const cellWidth = bounds.width / this.terminal.cols;
    const cellHeight = bounds.height / this.terminal.rows;
    return {
      right: bounds.left + Math.min(range.end.x, this.terminal.cols) * cellWidth,
      bottom: bounds.top + (viewportRow + 1) * cellHeight,
    };
  }

  clearSelection(): void {
    this.terminal.clearSelection();
  }

  scrollToBottom(): void {
    this.terminal.scrollToBottom();
  }

  isAtBottom(): boolean {
    const buffer = this.terminal.buffer.active;
    return buffer.viewportY >= buffer.baseY;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.resizeObserver.disconnect();
    if (this.pasteFallbackTimer !== null) window.clearTimeout(this.pasteFallbackTimer);
    if (this.resizeNotifyTimer !== null) {
      window.clearTimeout(this.resizeNotifyTimer);
      this.resizeNotifyTimer = null;
      // Flush the settled size so the PTY keeps it when the pane unmounts
      // inside the debounce window.
      this.options.onResize(this.terminal.cols, this.terminal.rows);
    }
    this.terminal.textarea?.removeEventListener("paste", this.onNativePaste, true);
    for (const disposable of this.disposables) disposable.dispose();
    this.webgl?.dispose();
    this.terminal.dispose();
    this.mount.replaceChildren();
  }
}
