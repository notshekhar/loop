import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ComposerQueuedTurns } from "./ComposerQueuedTurns";

const turn = (id: string, text: string, attachmentCount = 0) => ({
  id,
  sessionId: "s1",
  threadId: "t1",
  text,
  attachmentCount,
  queuedAt: "2026-08-08T00:00:00.000Z",
  send: () => Promise.resolve(),
  interrupt: () => Promise.resolve(),
});

describe("ComposerQueuedTurns", () => {
  it("renders nothing when the queue is empty", () => {
    // The strip must not reserve space it is not using — an empty band above
    // the composer reads as a rendering fault.
    expect(renderToStaticMarkup(<ComposerQueuedTurns turns={[]} onCancel={() => {}} />)).toBe("");
  });

  it("offers to send a message now, stopping the running turn", () => {
    // The terminal's Esc. Without it the only way to act on a turn going the
    // wrong way was Stop, which threw the queued message away with it.
    const markup = renderToStaticMarkup(
      <ComposerQueuedTurns turns={[turn("a", "one")]} onCancel={() => {}} onSendNow={() => {}} />,
    );
    expect(markup).toContain('aria-label="Send this message now"');
  });

  it("leaves the send-now control out when no handler is given", () => {
    const markup = renderToStaticMarkup(
      <ComposerQueuedTurns turns={[turn("a", "one")]} onCancel={() => {}} />,
    );
    expect(markup).not.toContain('aria-label="Send this message now"');
    expect(markup).toContain('aria-label="Remove queued message"');
  });

  it("shows each queued message with a way to take it back", () => {
    const markup = renderToStaticMarkup(
      <ComposerQueuedTurns
        turns={[turn("a", "first thing"), turn("b", "second thing")]}
        onCancel={() => {}}
      />,
    );

    expect(markup).toContain("first thing");
    expect(markup).toContain("second thing");
    expect(markup).toContain("Queued · 2");
    expect(markup.match(/aria-label="Remove queued message"/g)).toHaveLength(2);
  });

  it("collapses a multi-line message to one line", () => {
    // A queue that grows a paragraph tall pushes the input off the screen.
    const markup = renderToStaticMarkup(
      <ComposerQueuedTurns turns={[turn("a", "  one\n\ntwo   three  ")]} onCancel={() => {}} />,
    );
    expect(markup).toContain("one two three");
  });

  it("labels an attachment-only message rather than showing an empty row", () => {
    const markup = renderToStaticMarkup(
      <ComposerQueuedTurns turns={[turn("a", "   ", 2)]} onCancel={() => {}} />,
    );
    expect(markup).toContain("Attachment");
    expect(markup).toContain("2 attachments");
  });
});
