/**
 * `loop install desktop`: finding the installed app and its version, finding
 * the newest release that actually carries a desktop build, and deciding
 * between install, update and "already up to date". The install itself is the
 * desktop install script, which this never runs.
 */
import { describe, expect, test } from "bun:test";

import {
    desktopAssetName,
    desktopPlan,
    findInstalledDesktop,
    latestDesktopRelease,
    plistVersion,
} from "../src/desktop-install";

const fakeFs = (files: Record<string, string>) => ({
    exists: (path: string) => Object.keys(files).some((f) => f === path || f.startsWith(`${path}/`)),
    read: (path: string) => files[path] ?? null,
});

describe("finding the installed app", () => {
    test("macOS reads the version out of Loop.app's Info.plist", () => {
        const plist =
            "<dict><key>CFBundleName</key><string>Loop</string><key>CFBundleShortVersionString</key><string>0.21.13</string></dict>";
        expect(plistVersion(plist)).toBe("0.21.13");
        const fs = fakeFs({ "/Applications/Loop.app/Contents/Info.plist": plist });
        expect(findInstalledDesktop("darwin", {}, "/Users/u", fs)).toEqual({
            path: "/Applications/Loop.app",
            version: "0.21.13",
        });
    });

    test("falls back to ~/Applications, and is null when there is no app", () => {
        const fs = fakeFs({ "/Users/u/Applications/Loop.app/Contents/Info.plist": "" });
        expect(findInstalledDesktop("darwin", {}, "/Users/u", fs)?.path).toBe("/Users/u/Applications/Loop.app");
        expect(findInstalledDesktop("darwin", {}, "/Users/u", fakeFs({}))).toBeNull();
    });

    test("Linux and Windows read the marker the install scripts write", () => {
        const linux = fakeFs({
            "/home/u/.local/share/loop-desktop/Loop": "",
            "/home/u/.local/share/loop-desktop/.loop-version": "0.21.12\n",
        });
        expect(findInstalledDesktop("linux", {}, "/home/u", linux)).toEqual({
            path: "/home/u/.local/share/loop-desktop",
            version: "0.21.12",
        });
        // An install from before the marker: present, version unknown.
        const old = fakeFs({ "/home/u/.local/share/loop-desktop/Loop": "" });
        expect(findInstalledDesktop("linux", {}, "/home/u", old)?.version).toBeNull();
        const win = fakeFs({ "C:/L/Programs/Loop/Loop.exe": "", "C:/L/Programs/Loop/.loop-version": "0.21.13" });
        expect(findInstalledDesktop("win32", { LOCALAPPDATA: "C:/L" }, "C:/Users/u", win)?.version).toBe("0.21.13");
    });
});

describe("the newest release with a desktop build", () => {
    const releases = [
        { tag_name: "v0.21.14", assets: [{ name: "loop-darwin-arm64.tar.gz" }] }, // CLI-only
        { tag_name: "v0.21.13", assets: [{ name: desktopAssetName("darwin", "arm64") }] },
        { tag_name: "v0.21.12", assets: [{ name: desktopAssetName("darwin", "arm64") }] },
    ];
    const fakeFetch = (body: unknown, ok = true) =>
        (async () => ({ ok, json: async () => body })) as unknown as typeof fetch;

    test("skips a CLI-only release", async () => {
        expect(await latestDesktopRelease("darwin", "arm64", fakeFetch(releases))).toEqual({
            tag: "v0.21.13",
            version: "0.21.13",
        });
    });

    test("is null when GitHub cannot be asked, or nothing matches", async () => {
        expect(await latestDesktopRelease("darwin", "arm64", fakeFetch([], false))).toBeNull();
        expect(await latestDesktopRelease("linux", "x64", fakeFetch(releases))).toBeNull();
    });
});

describe("install, update or nothing", () => {
    const latest = { tag: "v0.21.13", version: "0.21.13" };

    test("installs when there is no app", () => {
        expect(desktopPlan(null, latest, false)).toEqual({ action: "install", to: "0.21.13" });
    });

    test("updates an older copy, and one that does not know its version", () => {
        expect(desktopPlan({ path: "/A", version: "0.21.10" }, latest, false)).toEqual({
            action: "update",
            from: "0.21.10",
            to: "0.21.13",
        });
        expect(desktopPlan({ path: "/A", version: null }, latest, false).action).toBe("update");
    });

    test("leaves a current (or newer) copy alone unless forced", () => {
        expect(desktopPlan({ path: "/A", version: "0.21.13" }, latest, false).action).toBe("up-to-date");
        expect(desktopPlan({ path: "/A", version: "0.22.0" }, latest, false).action).toBe("up-to-date");
        expect(desktopPlan({ path: "/A", version: "0.21.13" }, latest, true).action).toBe("update");
    });
});
