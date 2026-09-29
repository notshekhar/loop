/** The live session.event stream: text/reasoning deltas, tool cards,
 * subagents, usage, todos, and turn finish. */
import { byId } from "../lib/dom";
import { TRUNCATE, escapeHtml, formatTokens, pretty, truncate } from "../lib/format";
import { rpc } from "../services/connection";
import { state } from "../state";
import { setRunning, setStatus } from "../ui/status";
import {
    addError,
    addNote,
    appendAssistantText,
    appendReasoning,
    breakLiveText,
    breakReasoning,
    finishToolCard,
    getSubagentCard,
    reasoningBox,
    renderToolInput,
    subagentCard,
    toolCard,
    toolCards,
    toolSummary,
} from "../ui/transcript";
import { renderCrumb } from "../ui/views";
import { drainQueue } from "./session";

export function onEvent(params: any): void {
    if (!params || !state.current || params.sessionId !== state.current.id) return;
    // Seq guard: replayed + live streams are both monotonic; anything at or
    // below what we've applied is a duplicate (e.g. racing attach calls).
    if (typeof params.seq === "number") {
        if (params.seq <= state.lastSeq) return;
        state.lastSeq = params.seq;
    }
    const { type, data } = params.part || {};
    switch (type) {
        case "text-delta":
            appendAssistantText(data);
            break;
        case "reasoning-start":
            breakLiveText();
            reasoningBox();
            break;
        case "reasoning-delta":
            breakLiveText();
            appendReasoning(data);
            break;
        case "reasoning-end":
            breakReasoning();
            break;
        case "tool-input-start":
            breakLiveText();
            breakReasoning();
            if (data && data.toolCallId) toolCard(data.toolCallId, data.toolName);
            break;
        case "tool-input-delta": {
            if (data && data.toolCallId) {
                const card = toolCards.get(data.toolCallId);
                // Stream raw JSON into the generic pre; structured modes
                // re-render on the full tool-call anyway.
                if (card && card.mode === "generic" && card.input && card.inputRaw.length < TRUNCATE) {
                    card.inputRaw += data.delta;
                    card.input.textContent = truncate(card.inputRaw);
                }
            }
            break;
        }
        case "tool-call": {
            breakLiveText();
            breakReasoning();
            const card = toolCard((data && data.toolCallId) || String(Math.random()), data && data.toolName);
            renderToolInput(card, data && data.toolName, data && data.input);
            card.sum.textContent = toolSummary(data && data.toolName, data && data.input);
            setStatus(((data && data.toolName) || "tool") + "…");
            break;
        }
        case "tool-result": {
            const card = data && toolCards.get(data.toolCallId);
            if (card) finishToolCard(card, data.output, false);
            setStatus("working…");
            break;
        }
        case "tool-error": {
            const card = data && data.toolCallId && toolCards.get(data.toolCallId);
            if (card) finishToolCard(card, data.error, true);
            else addError("tool error: " + pretty(data && data.error));
            break;
        }
        case "subagent-delta": {
            const card = subagentCard(data.toolCallId, data.agent);
            if (!card.textEl) {
                card.textEl = document.createElement("div");
                card.textEl.className = "line text";
                card.body.appendChild(card.textEl);
            }
            card.textEl.textContent = truncate((card.textEl.textContent || "") + data.text);
            break;
        }
        case "subagent-tool": {
            const card = subagentCard(data.toolCallId, data.agent);
            const line = document.createElement("div");
            line.className = "line";
            line.textContent = data.toolName || "tool";
            card.body.appendChild(line);
            card.textEl = null;
            break;
        }
        case "subagent-step-usage": {
            const card = getSubagentCard(data.toolCallId);
            if (card && data.steps) {
                card.sum.textContent =
                    data.agent + " · step " + data.steps + (data.usd ? " · $" + data.usd.toFixed(4) : "");
            }
            break;
        }
        case "subagent-finish": {
            const card = getSubagentCard(data.toolCallId);
            if (card) {
                card.det.open = false;
                card.det.classList.remove("running");
            }
            break;
        }
        case "step-usage":
            if (data && data.breakdown && typeof data.breakdown.usd === "number") {
                byId("cost").textContent = (data.breakdown.estimated ? "~" : "") + "$" + data.breakdown.usd.toFixed(4);
            }
            if (data && data.usage) {
                const u = data.usage;
                const ctx = u.totalTokens ?? (u.inputTokens || 0) + (u.outputTokens || 0) + (u.cachedInputTokens || 0);
                if (ctx > 0) byId("ctx").textContent = "ctx " + formatTokens(ctx);
            }
            break;
        case "compact-start":
            addNote("compacting…");
            break;
        case "compact-end":
            addNote(data && data.error ? "compact failed: " + data.error : "compacted");
            break;
        case "todo-update": {
            const el = byId("todos");
            const items = (data && data.items) || [];
            el.classList.toggle("visible", items.length > 0);
            el.innerHTML = items
                .map(
                    (i: any) =>
                        '<div class="' +
                        (i.status === "completed" ? "done" : "") +
                        '">' +
                        "[" +
                        (i.status === "completed" ? "x" : i.status === "in_progress" ? ">" : " ") +
                        "] " +
                        escapeHtml(i.content || i.subject || "") +
                        "</div>",
                )
                .join("");
            break;
        }
        case "attached-images":
            if (Array.isArray(data) && data.length) {
                addNote("attached " + data.length + " image" + (data.length > 1 ? "s" : ""));
            }
            break;
        case "hook-message":
            addNote(String(data));
            break;
        case "data-recap":
            if (data && data.text) addNote("recap: " + data.text);
            break;
        case "error":
            addError(pretty(data));
            setRunning(false);
            drainQueue();
            break;
        case "finish": {
            breakLiveText();
            breakReasoning();
            setRunning(false);
            // First prompt names the session; refresh titles quietly.
            rpc("session.list")
                .then((l) => {
                    state.sessions = l;
                    renderCrumb();
                })
                .catch(() => {});
            drainQueue();
            break;
        }
        default:
            break;
    }
}
