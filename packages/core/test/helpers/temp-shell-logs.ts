import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "bun:test";
import { setShellLogRootForTests } from "../../src/tools/utils/shell-logs";

/**
 * Give every test in the file its own folder for background shell logs. Setting
 * HOME would not do it: Bun's homedir() ignores runtime changes to it, so the
 * logs would land in the real ~/.loop/shells.
 */
export function useTempShellLogs(): void {
    let dir: string | null = null;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "loop-shells-"));
        setShellLogRootForTests(dir);
    });
    afterEach(() => {
        if (!dir) return;
        setShellLogRootForTests(null);
        rmSync(dir, { recursive: true, force: true });
        dir = null;
    });
}
