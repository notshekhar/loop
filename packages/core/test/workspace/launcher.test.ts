import { afterAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bundleLauncherNames, scanBundleLaunchers } from "../../src/workspace/launcher";

const roots: string[] = [];

async function applications(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "loop-applications-"));
    roots.push(root);
    return root;
}

/** An .app with an executable launcher at `relativePath` inside it. */
async function installBundle(root: string, bundle: string, relativePath: string): Promise<string> {
    const path = join(root, bundle, relativePath);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, "#!/bin/sh\n");
    await chmod(path, 0o755);
    return path;
}

afterAll(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe("scanBundleLaunchers", () => {
    test("finds the CLI an Electron editor ships inside its bundle", async () => {
        // The reported bug: VS Code was installed, `which code` said missing —
        // the shim only exists once the user runs "Install 'code' command in PATH"
        // — and the "Open in..." menu had no VS Code entry.
        const root = await applications();
        const code = await installBundle(root, "Visual Studio Code.app", "Contents/Resources/app/bin/code");

        const launchers = await scanBundleLaunchers([root]);
        expect(launchers.get("code")).toBe(code);
    });

    test("finds a JetBrains IDE's launcher in Contents/MacOS", async () => {
        const root = await applications();
        const idea = await installBundle(root, "IntelliJ IDEA.app", "Contents/MacOS/idea");

        const launchers = await scanBundleLaunchers([root]);
        expect(launchers.get("idea")).toBe(idea);
    });

    test("skips a launcher that is not executable", async () => {
        // Contents/MacOS holds plenty of non-executables (Info.plist neighbours,
        // frameworks); one named like a command must not be reported as one.
        const root = await applications();
        const path = join(root, "Impostor.app/Contents/MacOS");
        await mkdir(path, { recursive: true });
        await writeFile(join(path, "code"), "not a program");
        await chmod(join(path, "code"), 0o644);

        const launchers = await scanBundleLaunchers([root]);
        expect(launchers.has("code")).toBe(false);
    });

    test("gives a command to the app named after it, not to a fork that also ships it", async () => {
        // MEASURED on this machine: Cursor is a VS Code fork and ships `code` too,
        // so readdir order decided who owned it — picking "VS Code" opened Cursor.
        const root = await applications();
        await installBundle(root, "Cursor.app", "Contents/Resources/app/bin/cursor");
        await installBundle(root, "Cursor.app", "Contents/Resources/app/bin/code");
        const vscode = await installBundle(root, "Visual Studio Code.app", "Contents/Resources/app/bin/code");

        const launchers = await scanBundleLaunchers([root]);
        expect(launchers.get("code")).toBe(vscode);
        expect(launchers.get("cursor")).toBe(join(root, "Cursor.app/Contents/Resources/app/bin/cursor"));
    });

    test("keeps a fork's copy when the app it belongs to is not installed", async () => {
        // Better to open Cursor for "VS Code" than to report VS Code as missing
        // when something can open the folder.
        const root = await applications();
        const fork = await installBundle(root, "Cursor.app", "Contents/Resources/app/bin/code");

        const launchers = await scanBundleLaunchers([root]);
        expect(launchers.get("code")).toBe(fork);
    });

    test("prefers the first directory when an app is installed twice", async () => {
        const system = await applications();
        const user = await applications();
        const preferred = await installBundle(system, "Cursor.app", "Contents/Resources/app/bin/cursor");
        await installBundle(user, "Cursor.app", "Contents/Resources/app/bin/cursor");

        const launchers = await scanBundleLaunchers([system, user]);
        expect(launchers.get("cursor")).toBe(preferred);
    });

    test("ignores a directory that is not there", async () => {
        const root = await applications();
        await installBundle(root, "Zed.app", "Contents/MacOS/cli");

        const launchers = await scanBundleLaunchers([join(root, "nope"), root]);
        expect(launchers.has("cli")).toBe(true);
    });
});

describe("bundleLauncherNames", () => {
    test("looks for Zed's launcher under the name it actually has", async () => {
        // Zed's bundled CLI is `cli`, not `zed`.
        expect(bundleLauncherNames("zed")).toEqual(["zed", "cli"]);
    });

    test("leaves a command with no alias alone", async () => {
        expect(bundleLauncherNames("code")).toEqual(["code"]);
    });
});
