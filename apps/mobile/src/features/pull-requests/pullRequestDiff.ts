/** A pull request patch flattened into list rows (PullRequestDiffScreen). */
import { parseUnifiedDiff, type ParsedDiffLine } from "../review/diffParser";

export type DiffRow =
  | { readonly kind: "file"; readonly id: string; readonly path: string }
  | { readonly kind: "line"; readonly id: string; readonly line: ParsedDiffLine };

/** Flatten the parsed files into rows, keeping only `path` when one is asked for. */
export function diffRows(patch: string, path: string | undefined): DiffRow[] {
  const rows: DiffRow[] = [];
  // The patch's final newline is not a line of the last file.
  for (const file of parseUnifiedDiff(patch.replace(/\n+$/, ""))) {
    const filePath = file.newPath ?? file.oldPath ?? "";
    if (path && filePath !== path) continue;
    rows.push({ kind: "file", id: `file:${file.id}`, path: filePath });
    for (const line of file.lines) {
      if (line.type === "meta") continue;
      rows.push({ kind: "line", id: `${file.id}:${line.id}`, line });
    }
  }
  return rows;
}

