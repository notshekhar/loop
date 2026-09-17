import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { ConversationViewSwitch, TrajectoryInspector, TrajectoryView } from "./TrajectoryView";

describe("trajectory presentation", () => {
  it("exposes the active view as a keyboard-accessible tab", () => {
    const html = renderToStaticMarkup(
      <ConversationViewSwitch value="trajectory" onChange={() => {}} />,
    );
    expect(html).toContain('aria-label="Conversation view"');
    expect(html).toMatch(
      /id="conversation-tab-trajectory"[^>]*aria-selected="true"[^>]*tabindex="0"/,
    );
    expect(html).toMatch(
      /id="conversation-tab-chat"[^>]*aria-selected="false"[^>]*tabindex="-1"/,
    );
  });

  it("shows loading separately from an empty session", () => {
    expect(
      renderToStaticMarkup(<TrajectoryView entries={[]} bottomInset={120} loading />),
    ).toContain("Loading trajectory…");
    const empty = renderToStaticMarkup(
      <TrajectoryView entries={[]} bottomInset={120} loading={false} />,
    );
    expect(empty).toContain("Send a message to start the trajectory.");
    expect(empty).toContain("padding-bottom:120px");
  });

  it("shows full input and output as escaped text and labels unknown timing", () => {
    const html = renderToStaticMarkup(
      <TrajectoryInspector
        record={{
          id: "call",
          turn: 1,
          kind: "Tool",
          label: "bash",
          summary: "Run script",
          status: "Failed",
          startedAt: null,
          durationMs: null,
          input: { command: "echo '<script>alert(1)</script>'" },
          output: "<img src=x onerror=alert(1)>",
        }}
        onClose={() => {}}
      />,
    );
    expect(html).toContain("Not recorded");
    expect(html).toContain("Failed");
    expect(html).toContain("Input");
    expect(html).toContain("Output");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
  });
});
