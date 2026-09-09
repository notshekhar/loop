/**
 * Composition root for the slash-command surface: each handler module owns
 * one concern (sessions, session tree, models, agents, hooks, settings,
 * misc) and contributes its slice of CommandContext.
 */
import type { CommandContext } from "@notshekhar/loop-core";
import type { AppDeps } from "./deps";
import type { AppState } from "./state";
import { createAgentHandlers } from "./handlers/agent-handlers";
import { createBashDenyHandlers } from "./handlers/bashdeny-handlers";
import { createContextHandlers } from "./handlers/context-handlers";
import { createShellsHandlers } from "./handlers/shells-handlers";
import { createDoctorHandlers } from "./handlers/doctor-handlers";
import { createDatasourceHandlers } from "./handlers/datasource-handlers";
import { createExtensionHandlers } from "./handlers/extension-handlers";
import { createBackgroundHandlers } from "./handlers/background-handlers";
import { goalModeEngine } from "./goal-mode";
import { createHookHandlers } from "./handlers/hook-handlers";
import { createMcpHandlers } from "./handlers/mcp-handlers";
import { createMiscHandlers } from "./handlers/misc-handlers";
import { createModelHandlers } from "./handlers/model-handlers";
import { createPermissionHandlers } from "./handlers/permission-handlers";
import { createSessionHandlers } from "./handlers/session-handlers";
import { createSessionTreeHandlers } from "./handlers/session-tree-handlers";
import { createSettingsHandlers } from "./handlers/settings-handlers";
import { createTimerHandlers } from "./handlers/timer-handlers";
import { createGatewayHandlers } from "./handlers/gateway-handlers";
import { createArtifactHandlers } from "./handlers/artifact-handlers";
import { createTraceHandlers } from "./handlers/trace-handlers";
import { createRecipeHandlers } from "./handlers/recipe-handlers";
import { createHandoffHandlers } from "./handlers/handoff-handlers";

export function createCommandContext(state: AppState, deps: AppDeps): CommandContext {
    return {
        get cwd() {
            return state.cwd;
        },
        ...createMiscHandlers(state, deps),
        ...createModelHandlers(state, deps),
        ...createSessionHandlers(state, deps),
        ...createSessionTreeHandlers(state, deps),
        ...createAgentHandlers(state, deps),
        ...createBashDenyHandlers(state, deps),
        ...createPermissionHandlers(state, deps),
        ...createContextHandlers(state, deps),
        ...createShellsHandlers(state, deps),
        ...createDoctorHandlers(state, deps),
        ...createHookHandlers(state, deps),
        ...createMcpHandlers(state, deps),
        ...createExtensionHandlers(state, deps),
        ...createDatasourceHandlers(state, deps),
        ...createSettingsHandlers(state, deps),
        ...createTimerHandlers(state, deps),
        ...createBackgroundHandlers(state, deps),
        ...createGatewayHandlers(state, deps),
        ...createArtifactHandlers(deps),
        ...createTraceHandlers(state, deps),
        ...createRecipeHandlers(state, deps),
        ...createHandoffHandlers(state, deps),
        manageGoalMode: (args: string) => goalModeEngine(state, deps).manageGoalMode(args),
    };
}
