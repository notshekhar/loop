import { describe, expect, it } from "vite-plus/test";

import { diffRows } from "./pullRequestDiff";
import {
  checksTone,
  formatChangeSize,
  reviewLabel,
  shortAge,
  splitPath,
  stateTone,
} from "./pullRequestPresentation";

describe("how a pull request reads", () => {
  it("names its state, draft included", () => {
    expect(stateTone({ state: "open", isDraft: false }).label).toBe("Open");
    expect(stateTone({ state: "open", isDraft: true }).label).toBe("Draft");
    expect(stateTone({ state: "merged", isDraft: false }).label).toBe("Merged");
    expect(stateTone({ state: "closed", isDraft: false }).label).toBe("Closed");
  });

  it("says nothing about checks it does not have", () => {
    expect(checksTone("none")).toBeNull();
    expect(checksTone("failing")?.label).toBe("Checks failing");
    expect(reviewLabel(null)).toBeNull();
    expect(reviewLabel("changes_requested")).toBe("Changes requested");
  });

  it("shortens ages, sizes and paths", () => {
    const now = Date.parse("2026-10-12T12:00:00Z");
    expect(shortAge("2026-10-12T11:58:00Z", now)).toBe("2m");
    expect(shortAge("2026-10-12T07:00:00Z", now)).toBe("5h");
    expect(shortAge("2026-10-09T12:00:00Z", now)).toBe("3d");
    expect(shortAge("not a date", now)).toBe("");
    expect(formatChangeSize(1234, 40)).toBe("+1.2k −40");
    expect(splitPath("apps/mobile/a.ts")).toEqual({ name: "a.ts", folder: "apps/mobile" });
    expect(splitPath("README.md")).toEqual({ name: "README.md", folder: "" });
  });
});

describe("a pull request diff as rows", () => {
  const patch = [
    "diff --git a/a.ts b/a.ts",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -1,2 +1,2 @@",
    " keep",
    "-old",
    "+new",
    "diff --git a/b.ts b/b.ts",
    "--- a/b.ts",
    "+++ b/b.ts",
    "@@ -1 +1 @@",
    "-x",
    "+y",
    "",
  ].join("\n");

  it("lists every file with its lines, or only the one asked for", () => {
    const all = diffRows(patch, undefined);
    expect(all.filter((r) => r.kind === "file").map((r) => (r.kind === "file" ? r.path : ""))).toEqual([
      "a.ts",
      "b.ts",
    ]);
    const one = diffRows(patch, "b.ts");
    expect(one[0]).toMatchObject({ kind: "file", path: "b.ts" });
    expect(one.filter((r) => r.kind === "line").map((r) => (r.kind === "line" ? r.line.type : ""))).toEqual([
      "hunk",
      "delete",
      "add",
    ]);
  });
});
