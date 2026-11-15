import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CommandRegistry, SlashCommand } from "../registry";
import { getAppDataDir, getAppProfile } from "../../app-profile";
import { loadProjectSkills, type Skill } from "../../agent/skills";

/** Skills as /skill:name commands (the app picks the prefix). A skill never
 * shadows a command already registered under the same name. */
export async function registerSkillCommands(reg: CommandRegistry, cwd: string): Promise<void> {
    try {
        const sk = await loadProjectSkills(cwd);
        const prefix = getAppProfile().skillCommandPrefix ?? "skill:";
        for (const skill of sk.skills) {
            const name = `${prefix}${skill.name}`;
            if (reg.has(name)) continue;
            reg.register(skillCommand(name, skill));
        }
    } catch {}
}

function skillCommand(name: string, skill: Skill): SlashCommand {
    return {
        name,
        description: skill.description.slice(0, 100),
        handler: (ctx, args) => {
            let content: string;
            try {
                content = readFileSync(skill.filePath, "utf8");
                content = content.replace(/^---[\s\S]*?---\s*\n/, "").trim();
            } catch (e) {
                ctx.emit("error", `failed reading skill ${skill.name}: ${(e as Error).message}`);
                return;
            }
            // the reference skill block format — must match parseSkillBlock regex exactly
            const block = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${content}\n</skill>`;
            const text = args ? `${block}\n\n${args}` : block;
            ctx.emit("inject-skill", text);
        },
    };
}

/** User prompts (`<data dir>/agent/prompts/*.md`) as commands. */
export function registerPromptCommands(reg: CommandRegistry): void {
    const promptsDir = join(getAppDataDir(), "agent", "prompts");
    if (!existsSync(promptsDir)) return;
    for (const file of readdirSync(promptsDir)) {
        if (!file.endsWith(".md")) continue;
        const name = file.replace(/\.md$/, "");
        const path = join(promptsDir, file);
        reg.register({
            name,
            description: `Custom prompt from ${file}`,
            handler: (ctx) => {
                const body = readFileSync(path, "utf8");
                ctx.emit("inject-prompt", body);
            },
        });
    }
}
