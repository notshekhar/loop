/**
 * A chat the New Thread screen just created, until the thread screen takes it.
 *
 * The host lists a new session a beat after the turn starts, and until then
 * the thread route has no thread to show — it said "Thread unavailable" for a
 * moment on every new chat. While a hand-off is pending the route shows the
 * opening state instead.
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
