/**
 * A dropped or pasted file, as the markdown link the composer inserts.
 *
 * This is what survives of the upstream `composerTrigger` module. Its
 * trigger detection, slash-command parsing and range replacement were all
 * superseded by `src/composer-logic.ts`, which carries loop's own trigger kinds
 * and slash commands ("agents", "mcp", "usage" rather than "plan"/"default") —
 * two copies of that logic, one of which nothing called.
 */

function composerFileLinkBasename(path: string): string {
  const separatorIndex = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return separatorIndex >= 0 ? path.slice(separatorIndex + 1) : path;
}

function escapeMarkdownLinkLabel(label: string): string {
  return label.replaceAll("\\", "\\\\").replaceAll("[", "\\[").replaceAll("]", "\\]");
}

function encodeMarkdownLinkDestination(path: string): string {
  return encodeURI(path)
    .replaceAll("(", "%28")
    .replaceAll(")", "%29")
    .replaceAll("#", "%23")
    .replaceAll("?", "%3F")
    .replaceAll("\\", "%5C");
}

/** `src/a b.ts` → `[a b.ts](src/a%20b.ts)`, label and destination both escaped. */
export function serializeComposerFileLink(path: string): string {
  const label = escapeMarkdownLinkLabel(composerFileLinkBasename(path));
  return `[${label}](${encodeMarkdownLinkDestination(path)})`;
}
