import { getExtensionHost, getModelSync, parseModelId } from "@notshekhar/loop-core";
import type { StatusLineContext, StatusSegment } from "@notshekhar/loop-core";
import type { Component } from "@notshekhar/loop-tui";
import { formatClock, formatCountdown } from "../time";
import { formatTokens as fmtTokens } from "@notshekhar/loop-core";
import { accent, dim, err, ok, warn } from "../ui/text";
import { theme } from "../ui/theme";

const ANSI_RE = /\x1b\[[0-9;]*m/g;
function ansiLen(s: string): number {
    return s.replace(ANSI_RE, "").length;
}

// Slice keeping ANSI escapes intact, counting only visible chars toward width.
function ansiSlice(s: string, width: number): string {
    let out = "";
    let visible = 0;
    let i = 0;
    while (i < s.length && visible < width) {
        if (s[i] === "\x1b" && s[i + 1] === "[") {
            const end = s.indexOf("m", i);
            if (end >= 0) {
                out += s.slice(i, end + 1);
                i = end + 1;
                continue;
            }
        }
        out += s[i];
        visible++;
        i++;
    }
    // append trailing reset/closing ANSI sequences so colors don't bleed
    while (i < s.length && s[i] === "\x1b" && s[i + 1] === "[") {
        const end = s.indexOf("m", i);
        if (end < 0) break;
        out += s.slice(i, end + 1);
        i = end + 1;
    }
    return out;
}

export class StatusLine implements Component {
    private modelId = "";
    private sessionId = "";
    private cost = "$0.0000";
    private ctxUsed = 0;
    private ctxMax = 0;
    private thinking = "off";
    // Whether the current model reasons.
    // shows the thinking level when state.model?.reasoning is truthy.
    private modelReasoning = true;
    private agent = "default";
    private timerEndsAt: number | null = null;
    private clockEnabled = false;
    private cwd = "";
    // Structured cost snapshot for the extension status-line context (the `cost`
    // string above is the pre-formatted display version).
    private costData = { usd: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };

    setModel(id: string) {
        this.modelId = id;
        // Custom-provider models (e.g. custom:gw/claude-sonnet-5) aren't
        // resolvable synchronously until the async catalog lands, so getModelSync
        // returns undefined at boot. Leave modelReasoning at its prior value in
        // that case rather than forcing it false — otherwise the thinking level
        // is hidden on first load until the user re-picks the model. app.ts
        // re-applies setModel once the catalog is warm to get the real value.
        const info = getModelSync(id);
        if (info) this.modelReasoning = Boolean(info.reasoning);
    }
    setAgent(name: string) {
        this.agent = name;
    }
    private planMode = false;
    setPlanMode(active: boolean) {
        this.planMode = active;
    }
    setSession(id: string) {
        this.sessionId = id;
    }
    setCost(s: string) {
        this.cost = s;
    }
    setContext(used: number, max: number) {
        this.ctxUsed = used;
        this.ctxMax = max;
    }
    setThinking(level: string) {
        this.thinking = level;
    }
    setTimer(endsAt: number | null) {
        this.timerEndsAt = endsAt;
    }
    setClockEnabled(enabled: boolean) {
        this.clockEnabled = enabled;
    }
    setCwd(cwd: string) {
        this.cwd = cwd;
    }
    setCostData(d: { usd: number; inputTokens: number; outputTokens: number; cachedInputTokens: number }) {
        this.costData = d;
    }

    /** The other live sessions in this loop ("◆ 1 needs you · ⋮ 2 working"),
     * pre-rendered by the caller; null while this is the only one. */
    private sessions: string | null = null;

    setSessions(chip: string | null): void {
        this.sessions = chip;
    }

    /** Transient contextual hint row — replaces the status rows while set
     * (scrollback focus mode). */
    private hint: string | null = null;

    setHint(hint: string | null): void {
        this.hint = hint;
    }

    invalidate(): void {}

    render(width: number): string[] {
        if (this.hint !== null) {
            return [ansiSlice(dim(this.hint), width)];
        }
        let ctxStr: string;
        if (this.ctxMax > 0) {
            const pct = (this.ctxUsed / this.ctxMax) * 100;
            const body = `ctx ${fmtTokens(this.ctxUsed)}/${fmtTokens(this.ctxMax)} (${pct.toFixed(1)}%)`;
            ctxStr = pct > 90 ? err(body) : pct > 70 ? warn(body) : dim(body);
        } else {
            ctxStr = dim(`ctx ${fmtTokens(this.ctxUsed)}`);
        }
        const sid = this.sessionId ? this.sessionId.slice(0, 8) : "unsaved";
        const showThinking = this.modelReasoning && this.thinking && this.thinking !== "off";
        const modelLabel = showThinking
            ? `${this.modelId || "no-model"} • ${this.thinking}`
            : this.modelId || "no-model";
        // Two rows: agent/model identity on top, usage below.
        const agentStr =
            (this.agent && this.agent !== "default"
                ? theme.fg("hookAccent", `agent ${this.agent}`)
                : dim("agent default")) + dim(" (shift+tab)");
        const identity = [agentStr, accent(modelLabel)];
        if (this.planMode) identity.push(warn("plan mode (read-only)"));
        const usage = [dim(`session ${sid}`), ok(this.cost), ctxStr];
        if (this.timerEndsAt !== null) {
            const remaining = this.timerEndsAt - Date.now();
            const body = `timer ${formatCountdown(remaining)}`;
            usage.push(remaining < 60_000 ? warn(body) : dim(body));
        }
        if (this.clockEnabled) usage.push(dim(formatClock()));
        if (this.sessions) usage.push(this.sessions);

        // Extension contributions: rows[0]=identity, rows[1]=usage, >1 = extra.
        const { contributors, transforms } = getExtensionHost().getStatusLine();
        const rows: string[][] = [identity, usage];
        if (contributors.length > 0 || transforms.length > 0) {
            const ctx = this.buildContext(width);
            for (const fn of contributors) {
                try {
                    for (const seg of normalizeSegments(fn(ctx))) {
                        const r = seg.row ?? 1;
                        (rows[r] ??= []).push(seg.text);
                    }
                } catch {
                    // A throwing contributor must never break the UI render.
                }
            }
            let lines = rows.flatMap((parts) => (parts && parts.length ? wrapParts(parts, width) : []));
            for (const fn of transforms) {
                try {
                    lines = fn(lines, ctx) ?? lines;
                } catch {
                    // Same: a bad transform leaves the prior lines intact.
                }
            }
            return lines.map((l) => (ansiLen(l) > width ? ansiSlice(l, width) : l));
        }

        const lines = [...wrapParts(identity, width), ...wrapParts(usage, width)];
        // Hard-clip any single part that still exceeds width (rare).
        return lines.map((l) => (ansiLen(l) > width ? ansiSlice(l, width) : l));
    }

    private buildContext(width: number): StatusLineContext {
        let provider = "";
        let model = this.modelId;
        try {
            const parsed = parseModelId(this.modelId);
            provider = parsed.provider;
            model = parsed.model;
        } catch {
            // Unparseable id (e.g. "no-model") — leave provider empty.
        }
        return {
            agent: this.agent,
            modelId: this.modelId,
            provider,
            model,
            sessionId: this.sessionId || null,
            cwd: this.cwd,
            cost: { ...this.costData },
            context: { used: this.ctxUsed, max: this.ctxMax },
            thinking: this.thinking,
            reasoning: this.modelReasoning,
            width,
        };
    }
}

/** Coerce a contributor's return into a segment array. */
function normalizeSegments(out: StatusSegment | StatusSegment[] | string | null | undefined): StatusSegment[] {
    if (out == null) return [];
    if (typeof out === "string") return out ? [{ text: out }] : [];
    if (Array.isArray(out)) return out.filter((s) => s && s.text);
    return out.text ? [out] : [];
}

function wrapParts(parts: string[], width: number): string[] {
    const sep = dim(" · ");
    const sepLen = ansiLen(sep);
    const lines: string[] = [];
    let cur = "";
    let curLen = 0;
    for (const p of parts) {
        const pLen = ansiLen(p);
        if (cur === "") {
            cur = p;
            curLen = pLen;
            continue;
        }
        if (curLen + sepLen + pLen <= width) {
            cur += sep + p;
            curLen += sepLen + pLen;
        } else {
            lines.push(cur);
            cur = p;
            curLen = pLen;
        }
    }
    if (cur) lines.push(cur);
    return lines;
}
