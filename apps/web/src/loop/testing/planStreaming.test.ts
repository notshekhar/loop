import { describe, expect, it } from "vite-plus/test";

import { renderTranscript } from "./renderTranscript";

// History and live overlapping (the same call, run, recap or checklist in
// both) cannot happen any more: the transcript store applies only events
// after the host snapshot's seq, and the host builds that snapshot from one
// stream — see packages/core/test/transcript.test.ts ("the saved turn reads
// exactly as it streamed") and src/loop/transcript/store.ts.

const PLAN =
  "# Add /healthz\n\n## Context\n\nThe server has no health endpoint.\n\n## Steps\n\n1. Add the route\n2. Return 200\n";

/** The wire shapes measured off `loop rpc`: start (with toolName), N deltas, then one tool-call. */
function planEvents(upTo: number) {
  const json = JSON.stringify({ plan: PLAN });
  const chunks: string[] = [];
  for (let i = 0; i < json.length; i += 4) chunks.push(json.slice(i, i + 4));
  const events: { type: string; data?: unknown }[] = [
    { type: "tool-input-start", data: { toolName: "plan", toolCallId: "tool_1" } },
  ];
  for (const delta of chunks.slice(0, upTo)) {
    events.push({ type: "tool-input-delta", data: { toolCallId: "tool_1", delta } });
  }
  return { events, total: chunks.length };
}

const planMarkdown = (view: Awaited<ReturnType<typeof renderTranscript>>) => {
  const row = view.rows.find((r) => r.kind === "proposed-plan");
  return row && "proposedPlan" in row ? row.proposedPlan.planMarkdown : null;
};

describe("the plan tool while it is still streaming", () => {
  it("is a plan card from the first delta, not a tool row that becomes one at the end", async () => {
    const { events } = planEvents(12);
    const view = await renderTranscript({ events, running: true });
    expect(view.shape).toEqual(["plan # Add /healthz"]);
  });

  it("grows as the document arrives", async () => {
    const early = await renderTranscript({ events: planEvents(12).events, running: true });
    const later = await renderTranscript({ events: planEvents(40).events, running: true });
    const earlyText = planMarkdown(early);
    const laterText = planMarkdown(later);
    expect(earlyText).not.toBeNull();
    expect(laterText).not.toBeNull();
    expect(laterText!.length).toBeGreaterThan(earlyText!.length);
    expect(laterText!.startsWith(earlyText!)).toBe(true);
  });

});
