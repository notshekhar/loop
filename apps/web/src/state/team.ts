import { createTeamAtoms } from "@loop/runtime/state/team";

import { connectionAtomRuntime } from "../connection/runtime";

export const teamAtoms = createTeamAtoms(connectionAtomRuntime);
