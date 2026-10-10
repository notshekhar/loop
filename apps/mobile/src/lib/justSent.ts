/**
 * The message a screen just sent into a thread another screen is about to show.
 *
 * Sending from an open thread anchors that message to the top of the view and
 * lets the reply grow beneath it, as on desktop. A new chat's first message is
 * sent from the New Thread screen, which then hands over to the thread screen
 * — and without a hand-off the thread screen had nothing to anchor, so the
 * reply pushed the message up off screen as it streamed.
 */

const justSent = new Map<string, string>();

export function rememberJustSent(threadKey: string, messageId: string): void {
  justSent.set(threadKey, messageId);
}

/** Whether a send into `threadKey` is waiting to be shown. */
export function hasJustSent(threadKey: string): boolean {
  return justSent.has(threadKey);
}

/** The message just sent into `threadKey`, once: a later open is not a send. */
export function takeJustSent(threadKey: string): string | null {
  const messageId = justSent.get(threadKey) ?? null;
  justSent.delete(threadKey);
  return messageId;
}
