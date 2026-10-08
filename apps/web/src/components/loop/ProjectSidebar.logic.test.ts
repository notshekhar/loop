import type { EnvironmentId, ProjectId } from "@loop/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildProjectSidebarRows,
  compactTimeLabel,
  resolveActiveProjectId,
  type ProjectSidebarProjectInput,
  type ProjectSidebarThreadInput,
  orderProjectsForSidebar,
  pickSidebarProject,
} from "./ProjectSidebar.logic";

const LOCAL = "local" as EnvironmentId;

function project(id: string, updatedAt: string): ProjectSidebarProjectInput {
  return {
    id: id as ProjectId,
    environmentId: LOCAL,
    title: id.slice(id.lastIndexOf("/") + 1),
    workspaceRoot: id,
    updatedAt,
  };
}

function thread(
  id: string,
  projectId: string,
  updatedAt: string,
  status?: string,
): ProjectSidebarThreadInput {
  return {
    id,
    environmentId: LOCAL,
    projectId,
    updatedAt,
    session: status === undefined ? null : { status },
  };
}

describe("project sidebar rows", () => {
  it("counts a project's sessions and the running ones", () => {
    const rows = buildProjectSidebarRows({
      projects: [project("/a", "2026-08-01T00:00:00.000Z")],
      threads: [
        thread("1", "/a", "2026-08-01T00:00:00.000Z"),
        thread("2", "/a", "2026-08-02T00:00:00.000Z", "running"),
        thread("3", "/a", "2026-08-03T00:00:00.000Z", "idle"),
      ],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.sessionCount).toBe(3);
    expect(rows[0]?.runningCount).toBe(1);
  });

  it("dates a project by its newest session, not by the project record", () => {
    const rows = buildProjectSidebarRows({
      projects: [project("/a", "2020-01-01T00:00:00.000Z")],
      threads: [
        thread("1", "/a", "2026-08-01T00:00:00.000Z"),
        thread("2", "/a", "2026-08-05T00:00:00.000Z"),
      ],
    });

    expect(rows[0]?.lastActivity).toBe(Date.parse("2026-08-05T00:00:00.000Z"));
  });

  it("falls back to the project's own timestamp when it has no sessions", () => {
    const rows = buildProjectSidebarRows({
      projects: [project("/a", "2026-08-01T00:00:00.000Z")],
      threads: [],
    });

    expect(rows[0]?.sessionCount).toBe(0);
    expect(rows[0]?.lastActivity).toBe(Date.parse("2026-08-01T00:00:00.000Z"));
  });

  it("puts the most recently touched folder first", () => {
    const rows = buildProjectSidebarRows({
      projects: [
        project("/old", "2026-01-01T00:00:00.000Z"),
        project("/new", "2026-01-01T00:00:00.000Z"),
      ],
      threads: [
        thread("1", "/old", "2026-08-01T00:00:00.000Z"),
        thread("2", "/new", "2026-08-05T00:00:00.000Z"),
      ],
    });

    expect(rows.map((row) => row.id)).toEqual(["/new", "/old"]);
  });

  it("does not date a project by an unparseable timestamp", () => {
    const rows = buildProjectSidebarRows({
      projects: [project("/a", "not a date")],
      threads: [thread("1", "/a", "also not a date")],
    });

    expect(rows[0]?.lastActivity).toBe(0);
  });

  it("ignores sessions belonging to another project", () => {
    const rows = buildProjectSidebarRows({
      projects: [project("/a", "2026-08-01T00:00:00.000Z")],
      threads: [thread("1", "/b", "2026-08-01T00:00:00.000Z")],
    });

    expect(rows[0]?.sessionCount).toBe(0);
  });
});

describe("compact time labels", () => {
  it("drop the trailing ago a sidebar row has no width for", () => {
    expect(compactTimeLabel("15m ago")).toBe("15m");
    expect(compactTimeLabel("2d ago")).toBe("2d");
  });

  it("shorten just now", () => {
    expect(compactTimeLabel("just now")).toBe("now");
  });

  it("leave anything else alone", () => {
    expect(compactTimeLabel("Aug 7")).toBe("Aug 7");
  });
});

describe("the active project row", () => {
  const threads = [
    thread("t1", "/a", "2026-08-01T00:00:00.000Z"),
    thread("t2", "/b", "2026-08-01T00:00:00.000Z"),
  ];

  it("is the one the project route names", () => {
    expect(resolveActiveProjectId({ routeProjectId: "/a", threads })).toBe("/a");
  });

  it("follows the open session back to its folder", () => {
    expect(
      resolveActiveProjectId({ routeEnvironmentId: "local", routeThreadId: "t2", threads }),
    ).toBe("/b");
  });

  it("follows a draft to the folder the draft carries", () => {
    // A draft has no server thread yet, so nothing in `threads` can answer it.
    expect(resolveActiveProjectId({ routeDraftProjectId: "/b", threads })).toBe("/b");
  });

  it("does not match a thread id from another environment", () => {
    expect(
      resolveActiveProjectId({ routeEnvironmentId: "remote", routeThreadId: "t2", threads }),
    ).toBeNull();
  });

  it("highlights nothing on a route that names no project", () => {
    expect(resolveActiveProjectId({ threads })).toBeNull();
    expect(resolveActiveProjectId({ routeThreadId: "gone", threads })).toBeNull();
  });
});

describe("projects across paired machines", () => {
  // The same folder on two machines: one id, two projects.
  const mac = { id: "/work/app", environmentId: "mac", title: "app" };
  const devbox = { id: "/work/app", environmentId: "devbox", title: "app" };
  const other = { id: "/work/zeta", environmentId: "mac", title: "zeta" };

  it("puts this machine's projects first", () => {
    expect(orderProjectsForSidebar([devbox, other, mac], "mac")).toEqual([mac, other, devbox]);
  });

  it("opens this machine's copy of a folder when the route names no machine", () => {
    const ordered = orderProjectsForSidebar([devbox, mac], "mac");
    expect(
      pickSidebarProject(ordered, { projectId: "/work/app", environmentId: null, primaryEnvironmentId: "mac" }),
    ).toBe(mac);
  });

  it("follows the route to the other machine's copy", () => {
    const ordered = orderProjectsForSidebar([devbox, mac], "mac");
    expect(
      pickSidebarProject(ordered, {
        projectId: "/work/app",
        environmentId: "devbox",
        primaryEnvironmentId: "mac",
      }),
    ).toBe(devbox);
  });
});
