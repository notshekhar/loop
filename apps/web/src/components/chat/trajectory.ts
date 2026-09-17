import type { TimelineEntry } from "../../session-logic";
import type { ChatAttachment } from "../../types";
import {
  loopCompactOf,
  loopHookOf,
  loopRecapOf,
  loopThinkingOf,
  loopToolOf,
} from "../loop/loopEntry";

export interface TrajectoryRecord {
  id: string;
  turn: number;
  kind: "User" | "Assistant" | "Tool" | "Thinking" | "Plan" | "Event";
  label: string;
  summary: string;
  status: "Recorded" | "Running" | "Completed" | "Failed" | "Interrupted";
  startedAt: number | null;
  durationMs: number | null;
  input?: unknown;
  output?: string | undefined;
  details?: unknown;
  attachments?: ReadonlyArray<ChatAttachment>;
  parentId?: string;
}

function finiteNonNegative(value: number | undefined): number | null {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : null;
}

export function trajectoryText(value: unknown): string {
  return typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? "");
}

/** Project the ordered session records without inferring request timings from display timestamps. */
export function deriveTrajectoryRecords(entries: readonly TimelineEntry[]): TrajectoryRecord[] {
  let turn = 0;
  const turns = new Map<string, number>();
  const records: TrajectoryRecord[] = [];
  for (const item of entries) {
    const source =
      item.kind === "message"
        ? item.message
        : item.kind === "work"
          ? item.entry
          : item.proposedPlan;
    if (item.kind === "message" && item.message.role === "user") turn += 1;
    if (source.turnId && !turns.has(source.turnId)) turns.set(source.turnId, turn);
    const record: TrajectoryRecord = {
      id: `${item.kind}:${item.id}`,
      turn: source.turnId ? (turns.get(source.turnId) ?? turn) : turn,
      kind: "Event",
      label: "Event",
      summary: "",
      status: "Recorded",
      startedAt: finiteNonNegative(Date.parse(item.createdAt)),
      durationMs: null,
    };
    if (item.kind === "message") {
      const message = item.message;
      record.kind =
        message.role === "user" ? "User" : message.role === "assistant" ? "Assistant" : "Event";
      record.label = record.kind;
      record.summary = message.text || `${message.attachments?.length ?? 0} attachments`;
      record.status = message.streaming ? "Running" : "Recorded";
      if (message.role === "user") record.input = message.text;
      else record.output = message.text;
      if (message.attachments) record.attachments = message.attachments;
    } else if (item.kind === "proposed-plan") {
      record.kind = "Plan";
      record.label = "Plan";
      record.summary = item.proposedPlan.planMarkdown;
      record.output = item.proposedPlan.planMarkdown;
    } else {
      const entry = item.entry;
      const tool = loopToolOf(entry);
      const thinking = loopThinkingOf(entry);
      const compact = loopCompactOf(entry);
      record.label = entry.label;
      record.summary = entry.detail ?? entry.label;
      record.details = entry.loop ?? entry.toolData;
      record.output = entry.detail;
      if (tool) {
        record.kind = "Tool";
        record.label = tool.name;
        record.summary = entry.label;
        record.input = tool.args;
        record.output = tool.output ?? tool.streamingContent;
        record.status = tool.interrupted
          ? "Interrupted"
          : tool.isError
            ? "Failed"
            : tool.isPartial
              ? "Running"
              : "Recorded";
        record.startedAt = finiteNonNegative(tool.startedAt) ?? record.startedAt;
        record.durationMs = tool.isPartial ? null : finiteNonNegative(tool.stats?.durationMs);
        if (record.status === "Recorded" && tool.output !== undefined)
          record.status = "Completed";
        record.details = tool;
      } else if (thinking) {
        record.kind = "Thinking";
        record.summary = thinking.text;
        record.output = thinking.text;
        record.status = thinking.streaming ? "Running" : "Recorded";
        record.durationMs = thinking.streaming ? null : finiteNonNegative(thinking.durationMs);
      } else if (compact) {
        record.label = "Compaction";
        record.summary = compact.summary ?? entry.label;
        record.output = compact.summary;
        record.status = compact.aborted
          ? "Interrupted"
          : compact.running
            ? "Running"
            : "Recorded";
      } else {
        record.output = loopRecapOf(entry)?.text ?? loopHookOf(entry)?.text ?? entry.detail;
        if (entry.tone === "error" || entry.toolLifecycleStatus === "failed")
          record.status = "Failed";
        else if (entry.toolLifecycleStatus === "inProgress") record.status = "Running";
        else if (entry.toolLifecycleStatus === "stopped") record.status = "Interrupted";
        else if (entry.toolLifecycleStatus === "completed") record.status = "Completed";
      }
      records.push(record);
      // Nested logs have ordering but no timestamps or tool results. Keep those unknown.
      tool?.activity?.forEach((step, index) => {
        const child: TrajectoryRecord = {
          id: `${record.id}:child:${(tool.droppedActivity ?? 0) + index}`,
          parentId: record.id,
          turn: record.turn,
          kind:
            step.kind === "tool" ? "Tool" : step.kind === "thinking" ? "Thinking" : "Assistant",
          label:
            step.kind === "tool"
              ? step.name
              : step.kind === "thinking"
                ? "Thinking"
                : "Assistant",
          summary:
            step.kind === "tool" ? (step.summary ?? trajectoryText(step.input)) : step.text,
          status: "Recorded",
          startedAt: null,
          durationMs: null,
          details: step,
        };
        if (step.kind === "tool") child.input = step.input ?? step.summary;
        else child.output = step.text;
        records.push(child);
      });
      continue;
    }
    records.push(record);
  }
  return records;
}

export function filterTrajectoryRecords(
  records: readonly TrajectoryRecord[],
  query: string,
): TrajectoryRecord[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...records];
  return records.filter((record) =>
    [
      record.label,
      record.kind,
      record.summary,
      record.status,
      trajectoryText(record.input),
      record.output ?? "",
    ].some((text) => text.toLowerCase().includes(needle)),
  );
}
