import { LegendList, type LegendListRef } from "@legendapp/list/react";
import {
  ArrowDownIcon,
  UserIcon,
  SparklesIcon,
  WrenchIcon,
  LayersIcon,
  XIcon,
} from "lucide-react";
import { memo, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { formatDuration, type TimelineEntry } from "../../session-logic";
import { cn } from "../../lib/utils";
import {
  deriveTrajectoryRecords,
  filterTrajectoryRecords,
  trajectoryText,
  type TrajectoryRecord,
} from "./trajectory";

import { TrajectoryTimeline } from "./TrajectoryTimeline";
import { TrajectoryToolbar } from "./TrajectoryToolbar";
import {
  trajectoryTimelineFocusIndexes,
  type TrajectoryTimeRange,
} from "./trajectoryTimelineModel";
import { trajectoryCellKind, trajectoryTimelineTurns } from "./trajectoryTimelineAdapter";
import { trajectoryTranslate } from "./trajectoryLocale";
import css from "./TrajectoryView.module.css";

export type ConversationView = "chat" | "trajectory";

export function ConversationViewSwitch({
  value,
  onChange,
}: {
  value: ConversationView;
  onChange: (value: ConversationView) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Conversation view"
      className="flex shrink-0 gap-4 border-b border-border/50 px-5"
    >
      {(["chat", "trajectory"] as const).map((view) => (
        <button
          key={view}
          id={`conversation-tab-${view}`}
          type="button"
          role="tab"
          aria-selected={value === view}
          aria-controls={`conversation-panel-${view}`}
          tabIndex={value === view ? 0 : -1}
          onClick={() => onChange(view)}
          onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const next =
              event.key === "Home"
                ? "chat"
                : event.key === "End"
                  ? "trajectory"
                  : view === "chat"
                    ? "trajectory"
                    : "chat";
            onChange(next);
            document.getElementById(`conversation-tab-${next}`)?.focus();
          }}
          className={cn(
            "cursor-pointer border-b-2 py-2 text-xs transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
            value === view
              ? "border-foreground text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground",
          )}
        >
          {view === "chat" ? "Chat" : "Trajectory"}
        </button>
      ))}
    </div>
  );
}

function InspectorSection({ label, value }: { label: string; value: unknown }) {
  if (value === undefined) return null;
  return (
    <section className="mt-4">
      <h4 className="mb-1 text-xs font-medium text-muted-foreground">{label}</h4>
      <pre className="whitespace-pre-wrap break-words rounded border border-border/50 bg-muted/30 p-3 font-mono text-xs select-text">
        {trajectoryText(value) || "(empty)"}
      </pre>
    </section>
  );
}

export function TrajectoryInspector({
  record,
  onClose,
}: {
  record: TrajectoryRecord;
  onClose: () => void;
}) {
  return (
    <aside
      aria-label="Trajectory record inspector"
      className="min-h-0 overflow-auto border-t border-border/50 bg-background p-4 md:border-t-0 md:border-l"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="truncate text-sm font-medium">
          {record.parentId ? "Subagent · " : ""}
          {record.label}
        </h3>
        <button
          type="button"
          aria-label="Close record inspector"
          onClick={onClose}
          className="cursor-pointer rounded p-1 text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <XIcon className="size-4" />
        </button>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {record.turn > 0 ? `Turn ${record.turn}` : "Before first turn"} · {record.kind} ·{" "}
        {record.status}
      </p>
      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">Started</dt>
        <dd>
          {record.startedAt === null
            ? "Not recorded"
            : new Date(record.startedAt).toLocaleString()}
        </dd>
        <dt className="text-muted-foreground">Duration</dt>
        <dd>
          {record.durationMs === null
            ? record.status === "Running"
              ? "In progress"
              : "Not recorded"
            : record.durationMs === 0
              ? "0ms"
              : formatDuration(record.durationMs)}
        </dd>
      </dl>
      <InspectorSection label="Input" value={record.input} />
      <InspectorSection label="Output" value={record.output} />
      {record.attachments?.map((attachment) => (
        <div key={attachment.id} className="mt-3">
          <p className="text-xs text-muted-foreground">{attachment.name}</p>
          {attachment.type === "image" && attachment.previewUrl ? (
            <img
              src={attachment.previewUrl}
              alt={attachment.name}
              className="mt-1 max-h-64 rounded object-contain"
            />
          ) : null}
        </div>
      ))}
      {record.details !== undefined ? (
        <details className="mt-4 text-xs">
          <summary className="cursor-pointer text-muted-foreground">Recorded details</summary>
          <InspectorSection label="Details" value={record.details} />
        </details>
      ) : null}
    </aside>
  );
}

export const TrajectoryView = memo(function TrajectoryView({
  entries,
  bottomInset,
  loading,
}: {
  entries: readonly TimelineEntry[];
  bottomInset: number;
  loading: boolean;
}) {
  const records = useMemo(() => deriveTrajectoryRecords(entries), [entries]);
  const turns = useMemo(() => trajectoryTimelineTurns(records), [records]);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const matches = useMemo(
    () => filterTrajectoryRecords(records, deferredQuery),
    [records, deferredQuery],
  );
  const matchIds = useMemo(() => new Set(matches.map((record) => record.id)), [matches]);
  const searchMatchIndexes = useMemo(
    () =>
      deferredQuery.trim()
        ? new Set(records.flatMap((record, index) => (matchIds.has(record.id) ? [index] : [])))
        : null,
    [deferredQuery, records, matchIds],
  );
  const [actualDuration, setActualDuration] = useState(false);
  const [collapsedTurns, setCollapsedTurns] = useState(false);
  const [collapsedCalls, setCollapsedCalls] = useState(false);
  const [range, setRange] = useState<TrajectoryTimeRange | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const selected = records.find((record) => record.id === selectedId);
  const mode = actualDuration ? "duration" : "sequence";
  const focusIndexes = useMemo(
    () => (range ? trajectoryTimelineFocusIndexes(turns, range, mode) : null),
    [turns, range, mode],
  );
  const focusIds = useMemo(
    () =>
      focusIndexes
        ? new Set(
            records.filter((_, index) => focusIndexes.has(index)).map((record) => record.id),
          )
        : null,
    [records, focusIndexes],
  );
  const filtered = useMemo(() => {
    if (deferredQuery.trim()) return matches;
    const seenTurns = new Set<number>();
    return matches.filter((record) => {
      const firstInTurn = !seenTurns.has(record.turn);
      seenTurns.add(record.turn);
      if (collapsedTurns) return firstInTurn;
      return !collapsedCalls || (record.kind !== "Tool" && !record.parentId);
    });
  }, [matches, deferredQuery, collapsedTurns, collapsedCalls]);
  const listRef = useRef<LegendListRef>(null);
  const rowState = useMemo(
    () => ({ selectedId, focusIds, collapsedTurns, deferredQuery }),
    [selectedId, focusIds, collapsedTurns, deferredQuery],
  );
  useEffect(() => {
    if (focusId === null) return;
    const index = filtered.findIndex((record) => record.id === focusId);
    if (index < 0) return;
    void listRef.current?.scrollToIndex({ index, animated: false, viewPosition: 0.5 });
    setFocusId(null);
  }, [filtered, focusId]);

  function focusRecord(index: number, inspect: boolean) {
    const record = records[index];
    if (!record) return;
    if (!matchIds.has(record.id)) setQuery("");
    setCollapsedTurns(false);
    setCollapsedCalls(false);
    if (inspect) setSelectedId(record.id);
    setFocusId(record.id);
  }

  return (
    <div className={css.root} style={{ paddingBottom: bottomInset }}>
      <TrajectoryToolbar
        t={trajectoryTranslate}
        actualDuration={actualDuration}
        onActualDurationChange={(value) => {
          setActualDuration(value);
          setRange(null);
        }}
        actualTime={false}
        onActualTimeChange={() => {}}
        allTurnsCollapsed={collapsedTurns}
        onToggleAllTurns={() => setCollapsedTurns((value) => !value)}
        allAssistantsCollapsed={collapsedCalls}
        onToggleAllAssistants={() => setCollapsedCalls((value) => !value)}
        searchQuery={query}
        onSearchQueryChange={setQuery}
      />
      <TrajectoryTimeline
        key={mode}
        t={trajectoryTranslate}
        turns={turns}
        mode={mode}
        range={range}
        searchMatchIndexes={searchMatchIndexes}
        selectedIndex={
          selectedId === null ? null : records.findIndex((record) => record.id === selectedId)
        }
        onRangeChange={(nextRange) => {
          setRange(nextRange);
          if (!nextRange) return;
          const indexes = trajectoryTimelineFocusIndexes(turns, nextRange, mode);
          const first = records.findIndex(
            (record, index) => indexes.has(index) && matchIds.has(record.id),
          );
          if (first >= 0) focusRecord(first, false);
        }}
        onRecordSelect={(index) => focusRecord(index, true)}
        onRecordFocus={(index) => focusRecord(index, false)}
      />
      <div
        className={cn(
          "relative grid min-h-0 flex-1",
          selected
            ? "grid-rows-2 md:grid-cols-[minmax(0,3fr)_minmax(16rem,2fr)] md:grid-rows-1"
            : "grid-cols-1",
        )}
      >
        <div
          role="table"
          aria-label="Trajectory timeline"
          aria-rowcount={filtered.length}
          aria-colcount={2}
          className="relative flex min-h-0 min-w-0 flex-col"
        >
          {filtered.length === 0 ? (
            <p role="status" className="p-8 text-center text-xs text-muted-foreground">
              {loading
                ? "Loading trajectory…"
                : records.length > 0
                  ? "No matching records."
                  : "Send a message to start the trajectory."}
            </p>
          ) : (
            <LegendList
              ref={listRef}
              data={filtered}
              extraData={rowState}
              keyExtractor={(record) => record.id}
              estimatedItemSize={30}
              recycleItems={false}
              initialScrollAtEnd={!deferredQuery}
              maintainScrollAtEnd={
                !deferredQuery && !selected && !range
                  ? {
                      animated: false,
                      on: { dataChange: true, itemLayout: true, layout: true },
                    }
                  : false
              }
              maintainVisibleContentPosition
              className="min-h-0 flex-1 overflow-x-hidden overscroll-y-contain"
              renderItem={({ item: record, index }) => {
                const kind = trajectoryCellKind(record);
                const Icon =
                  kind === "user"
                    ? UserIcon
                    : kind === "tool" || kind === "subtool"
                      ? WrenchIcon
                      : kind === "message"
                        ? SparklesIcon
                        : LayersIcon;
                const label =
                  record.kind === "Thinking"
                    ? "THINKING"
                    : record.kind === "Plan"
                      ? "PLAN"
                      : kind === "message"
                        ? "ASSISTANT"
                        : kind.toUpperCase();
                const turnStart = index === 0 || filtered[index - 1]?.turn !== record.turn;
                return (
                  <div
                    role="row"
                    aria-rowindex={index + 1}
                    className={css.row}
                    data-turn-start={turnStart || undefined}
                    data-selected={selectedId === record.id || undefined}
                    data-timeline-focus={
                      focusIds && !focusIds.has(record.id) ? "outside" : undefined
                    }
                  >
                    <span role="cell" className={css.event}>
                      {turnStart ? (
                        <span className={css.turn} title={`Turn ${record.turn}`}>
                          {record.turn ? `#${record.turn}` : ""}
                        </span>
                      ) : null}
                      <span
                        className={css.kind}
                        data-kind={kind}
                        data-error={record.status === "Failed" || undefined}
                      >
                        <Icon aria-hidden className="size-3 shrink-0" />
                        {label}
                      </span>
                    </span>
                    <span role="cell" className={css.summary}>
                      <button
                        type="button"
                        aria-label={`Inspect ${record.label}: ${record.summary.slice(0, 100)}`}
                        aria-pressed={selectedId === record.id}
                        onClick={() => setSelectedId(record.id)}
                        title={record.summary}
                      >
                        {record.parentId ? "↳ " : ""}
                        {record.summary.replace(/\s+/g, " ")}
                        {record.kind === "Tool" && record.output !== undefined ? (
                          <span
                            className={cn(css.result, record.status === "Failed" && css.failed)}
                          >
                            → {record.output.replace(/\s+/g, " ")}
                          </span>
                        ) : null}
                        {record.status === "Running" || record.status === "Interrupted" ? (
                          <span className={css.status}>{record.status}</span>
                        ) : null}
                        {collapsedTurns && !deferredQuery ? (
                          <span className={css.status}>· Turn folded</span>
                        ) : null}
                      </button>
                    </span>
                  </div>
                );
              }}
            />
          )}
          <button
            type="button"
            aria-label="Jump to latest trajectory record"
            title="Jump to latest"
            onClick={() => {
              setRange(null);
              listRef.current?.scrollToEnd({ animated: true });
            }}
            className="absolute right-3 bottom-3 cursor-pointer rounded border border-border bg-background p-1 text-muted-foreground shadow-sm hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ArrowDownIcon className="size-3.5" />
          </button>
        </div>
        {selected ? (
          <TrajectoryInspector record={selected} onClose={() => setSelectedId(null)} />
        ) : null}
      </div>
    </div>
  );
});
