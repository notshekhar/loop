import { createSessionInsightsAtoms } from "@loop/runtime/state/insights";

import { connectionAtomRuntime } from "../connection/runtime";

export const sessionInsights = createSessionInsightsAtoms(connectionAtomRuntime);
