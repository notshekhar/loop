import type { EnvironmentId } from "@loop/contracts";
import { describe, expect, it } from "vite-plus/test";

import { computerOptions, resolveComputerScope } from "./computerScope";

const id = (value: string) => value as EnvironmentId;
const environments = [
  { environmentId: id("devbox"), label: "devbox" },
  { environmentId: id("local"), label: "This machine" },
  { environmentId: id("air"), label: "air" },
];

describe("the sidebar's computer picker", () => {
  it("lists this computer first, then the hosts by name", () => {
    const options = computerOptions({ environments, primaryEnvironmentId: id("local") });
    expect(options.map((option) => option.label)).toEqual(["This machine", "air", "devbox"]);
    expect(options[0]?.isThisComputer).toBe(true);
  });

  it("forgets a choice whose computer was removed, and needs two computers to narrow", () => {
    const options = computerOptions({ environments, primaryEnvironmentId: id("local") });
    expect(resolveComputerScope("devbox", options)).toBe("devbox");
    expect(resolveComputerScope("gone", options)).toBeNull();
    expect(resolveComputerScope(null, options)).toBeNull();
    expect(resolveComputerScope("local", options.slice(0, 1))).toBeNull();
  });
});
