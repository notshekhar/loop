const labels = {
  "column.input": "Input",
  "column.model": "Model",
  "column.tools": "Tools",
  "kind.system": "SYSTEM",
  "kind.user": "USER",
  "kind.context": "CONTEXT",
  "kind.compacted": "COMPACTED",
  "kind.assistant": "ASSISTANT",
  "kind.tool": "TOOL",
  "kind.subtool": "SUBTOOL",
  "timeline.aria": "Trajectory timing overview",
  "timeline.overviewAria": "Timeline overview; drag horizontally to focus events",
  "timeline.noTimingData": "No timing data",
  "timeline.total": "Total {duration}",
  "timeline.started": "Started {time}",
  "timeline.ttftDecoding": "TTFT {ttft} · Decoding {decoding}",
  "history.loadingEarlier": "Loading earlier history…",
  "history.loadingEarlierAria": "Loading earlier history…",
  "history.loadEarlier": "Load earlier history",
  "history.clickToLoadEarlier": "Click to load earlier history",
  "toolbar.aria": "Trajectory toolbar",
  "toolbar.duration": "Duration",
  "toolbar.useActualDuration": "Use actual duration",
  "toolbar.useEqualWidth": "Use equal-width operations",
  "toolbar.actualTime": "Actual time",
  "toolbar.turns": "Turns",
  "toolbar.expandTurns": "Expand turns",
  "toolbar.collapseTurns": "Collapse turns",
  "toolbar.calls": "Calls",
  "toolbar.expandCalls": "Expand calls",
  "toolbar.collapseCalls": "Collapse calls",
  "toolbar.search": "Search trajectory",
  "toolbar.searchPlaceholder": "Search",
} as const;

export type TrajectoryTranslate = (
  key: keyof typeof labels,
  values?: Record<string, string | number>,
) => string;

export const trajectoryTranslate: TrajectoryTranslate = (key, values) =>
  labels[key].replace(/\{(\w+)\}/g, (match, name: string) => String(values?.[name] ?? match));
