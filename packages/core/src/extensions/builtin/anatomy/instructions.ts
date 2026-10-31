/**
 * The text `/anatomy` submits: the downloaded SKILL.md body in the reference
 * skill block (so the TUI renders it as a skill invocation), located at the
 * skill's own directory — the skill runs `node kit/…`, `node scripts/…` and
 * opens `examples/…`, all relative to it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export function buildInvocation(dir: string, args: string): string {
    const location = join(dir, "SKILL.md");
    const body = readFileSync(location, "utf8")
        .replace(/^---[\s\S]*?---\s*\n/, "")
        .trim();
    const block = `<skill name="anatomy" location="${location}">\nReferences are relative to ${dir}.\n\n${body}\n</skill>`;
    return args ? `${block}\n\n${args}` : block;
}
