/**
 * Runs in its own process for app-profile.test.ts: the settings and
 * datasource stores are process-wide, and other test files replace them with
 * mocks for the rest of the run. An embedding app sets its profile once in a
 * fresh process, which is exactly what this does. Prints one JSON line.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tool } from "ai";
import { z } from "zod";
import { getAppDataDir, isSettingOffered, setAppProfile } from "../../src/app-profile";
import { settingsStore } from "../../src/auth/storage";
import { buildSystemPrompt } from "../../src/agent/system-prompt";
import { CommandRegistry, registerBuiltins } from "../../src/commands";
import { listDatasources, saveDatasource } from "../../src/datasources/config";
import { createBaseTools } from "../../src/tools";

const dataDir = process.argv[2];
const loopDataDir = getAppDataDir();

const skills = join(dataDir, "skills");
mkdirSync(join(skills, "debugging"), { recursive: true });
writeFileSync(
    join(skills, "debugging", "SKILL.md"),
    "---\nname: debugging\ndescription: Find the cause of a bug\n---\nStart from the symptom.\n",
);
// Named like a builtin, which it must not replace.
mkdirSync(join(skills, "help"), { recursive: true });
writeFileSync(join(skills, "help", "SKILL.md"), "---\nname: help\ndescription: Shadow\n---\nNo.\n");

const probe = tool({ description: "probe", inputSchema: z.object({}), execute: async () => "ok" });
setAppProfile({
    name: "probe",
    dataDir,
    createTools: () => ({ probe }),
    basePrompt: () => "You are probe.",
    fixedSettings: { subagents: false },
    hiddenSettings: ["serve"],
    ownSettings: ["mcpServers"],
    skillDirs: [skills],
    skillCommandPrefix: "",
    hiddenCommands: ["goal", "agents"],
    commands: [{ name: "sources", description: "probe's own command", handler: () => {} }],
    agents: false,
});

settingsStore.set("subagents", true);
settingsStore.set("mcpServers", { probe: { command: "true" } });
saveDatasource("orders", { type: "postgres", host: "db", port: 5432, database: "orders", user: "ro" });

const reg = new CommandRegistry();
await registerBuiltins(reg, { cwd: dataDir });

console.log(
    JSON.stringify({
        loopDataDir,
        dataDir: getAppDataDir(),
        subagents: settingsStore.get("subagents"),
        offered: { subagents: isSettingOffered("subagents"), serve: isSettingOffered("serve"), theme: isSettingOffered("theme") },
        ownSettingsFile: JSON.parse(readFileSync(join(dataDir, "settings.json"), "utf8")),
        sharedSettingsFile: JSON.parse(readFileSync(join(loopDataDir, "settings.json"), "utf8")),
        datasources: listDatasources().map((d) => d.id),
        datasourcesFile: Object.keys(JSON.parse(readFileSync(join(dataDir, "datasources.json"), "utf8")).connections),
        tools: Object.keys(createBaseTools({ cwd: dataDir })),
        prompt: buildSystemPrompt({ cwd: dataDir }).split("\n")[0],
        agentPrompt: buildSystemPrompt({ cwd: dataDir, basePrompt: "You are an agent." }).split("\n")[0],
        commands: {
            sources: reg.get("sources")?.description,
            debugging: reg.has("debugging"),
            prefixedSkill: reg.has("skill:debugging"),
            help: reg.get("help")?.description,
            goal: reg.has("goal"),
            agents: reg.has("agents"),
            plan: reg.has("plan"),
            data: reg.has("data"),
        },
    }),
);
