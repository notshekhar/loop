/**
 * The Lua extension: VM fences, callback dispatch, and the auto-load contract.
 *
 * Every test runs against an isolated HOME so the suite can never read or write
 * the developer's own ~/.loop/lua — the scripts under test are meant to be
 * auto-loaded, and pointing that machinery at a real config directory would
 * both pollute it and make results depend on whatever the developer has there.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createLuaVm } from "../src/extensions/builtin/lua/vm";
import { LUA_PRELUDE } from "../src/extensions/builtin/lua/prelude";
import { cleanLuaError } from "../src/extensions/builtin/lua/loader";
import { toArray, toStringArray, asNumber, asString } from "../src/extensions/builtin/lua/marshal";

/** A VM with the prelude loaded and every host function stubbed out. */
async function preludeVm() {
    const lua = await createLuaVm();
    const HOST = [
        "version",
        "log",
        "cwd",
        "now",
        "redraw",
        "statusline_add",
        "cmd_register",
        "spawn",
        "run",
        "timer",
        "cancel",
        "setting_get",
        "setting_set",
    ];
    for (const name of HOST) lua.global.set(`__loop_host_${name}`, () => undefined);
    lua.doStringSync(LUA_PRELUDE);
    return lua;
}

describe("lua vm — sandbox", () => {
    test("io, os, package, debug and the chunk loaders are gone", async () => {
        const lua = await createLuaVm();
        lua.doStringSync(`
            probe = {}
            for _, n in ipairs({"io","os","package","debug","require","dofile","loadfile","load","loadstring"}) do
              if _G[n] ~= nil then probe[#probe+1] = n end
            end
        `);
        expect(toStringArray(lua.global.get("probe"))).toEqual([]);
        lua.global.close();
    });

    test("string, table, math and utf8 remain usable", async () => {
        const lua = await createLuaVm();
        expect(lua.doStringSync(`return ("ab"):rep(2) .. tostring(math.floor(2.7)) .. utf8.char(65)`)).toBe("abab2A");
        lua.global.close();
    });

    /**
     * wasmoon 1.16.0 binds the STRING library to the name `utf8`, so `utf8.len`
     * silently returns bytes and `utf8.char` rejects anything above 255. Any
     * script measuring the width of box-drawing characters then lays out its
     * box three times too wide, with no error. vm.ts opens the real library.
     */
    test("utf8 is the real library, not a second copy of string", async () => {
        const lua = await createLuaVm();
        expect(lua.doStringSync(`return utf8.len("████")`)).toBe(4);
        expect(lua.doStringSync(`return #"████"`)).toBe(12); // bytes, for contrast
        expect(lua.doStringSync(`return utf8.char(9608)`)).toBe("█");
        expect(lua.doStringSync(`return utf8.codepoint("█", 1)`)).toBe(9608);
        lua.global.close();
    });
});

describe("lua vm — fences", () => {
    test("an endless loop raises instead of hanging, and the VM survives", async () => {
        const lua = await createLuaVm();
        lua.doStringSync(`function spin() while true do end end`);
        const spin = lua.global.get("spin") as () => void;
        const started = Date.now();
        expect(() => spin()).toThrow();
        // The hook fires on an instruction count, so allow slack around the 250ms budget.
        expect(Date.now() - started).toBeLessThan(3000);
        expect(lua.doStringSync(`return "alive"`)).toBe("alive");
        lua.global.close();
    }, 10_000);

    /**
     * Asks for more than the whole ceiling in ONE allocation, so the request
     * cannot be satisfied on the first iteration.
     *
     * Both fences here are real and either one stops a runaway script, but this
     * test is about the memory one, and the original form raced them: filling a
     * 32 MB ceiling 8 KB at a time took ~4,000 iterations, which fits inside the
     * 250 ms call budget on a developer's Mac and did not on the slower Linux
     * CI runner — where it failed with "thread timeout exceeded" for two
     * months. A single oversized request settles it in about a millisecond, so
     * the clock is never in the running, on any machine.
     */
    test("runaway allocation hits the memory ceiling, and the VM survives", async () => {
        const lua = await createLuaVm();
        lua.doStringSync(`function hog() local t = {} while true do t[#t+1] = string.rep("x", 64 * 1024 * 1024) end end`);
        expect(() => (lua.global.get("hog") as () => void)()).toThrow(/not enough memory/i);
        expect(lua.doStringSync(`return "alive"`)).toBe("alive");
        lua.global.close();
    }, 10_000);

    test("a script error is catchable and does not poison later calls", async () => {
        const lua = await createLuaVm();
        lua.doStringSync(`function boom() error("kaboom") end`);
        expect(() => (lua.global.get("boom") as () => void)()).toThrow(/kaboom/);
        expect(lua.doStringSync(`return 1 + 1`)).toBe(2);
        lua.global.close();
    });
});

describe("lua prelude — callback dispatch", () => {
    /**
     * `function W:render(w)` and `function W.render(w)` produce indistinguishable
     * function values, and guessing wrong shifts every argument by one — silently.
     * All four declaration forms must see the same argument.
     */
    test("colon, dot, explicit-self and vararg methods all receive the real argument", async () => {
        const lua = await preludeVm();
        lua.doStringSync(`
            Colon = {};   function Colon:render(w) return w end
            Dot = {};     function Dot.render(w) return w end
            DotSelf = {}; function DotSelf.render(self, w) return w end
            Vararg = {};  function Vararg:render(...) local a = {...} return a[1] end
            H = {}
            for _, n in ipairs({"Colon","Dot","DotSelf","Vararg"}) do
              H[n] = __loop_internal.register(_G[n], "render")
            end
        `);
        const invoke = lua.global.get("__loop_invoke") as (h: number, ...a: unknown[]) => unknown;
        const handles = lua.global.get("H") as Record<string, number>;
        for (const [name, handle] of Object.entries(handles)) {
            expect([name, invoke(handle, 42)]).toEqual([name, 42]);
        }
        lua.global.close();
    });

    test("a bare function callback never receives a self argument", async () => {
        const lua = await preludeVm();
        lua.doStringSync(`
            function plain(a, b) return tostring(a) .. "/" .. tostring(b) end
            PH = __loop_internal.register(plain)
        `);
        const invoke = lua.global.get("__loop_invoke") as (h: number, ...a: unknown[]) => unknown;
        expect(invoke(lua.global.get("PH") as number, 1, 2)).toBe("1/2");
        lua.global.close();
    });

    test("invoking an unregistered handle returns nil rather than throwing", async () => {
        const lua = await preludeVm();
        const invoke = lua.global.get("__loop_invoke") as (h: number, ...a: unknown[]) => unknown;
        // Lua nil arrives as JS null, not undefined — callers must accept both.
        expect(invoke(9999)).toBeNull();
        lua.global.close();
    });
});

describe("lua marshalling", () => {
    test("a Lua sequence reads back in index order, not object order", async () => {
        const lua = await createLuaVm();
        // 10 before 2 lexically; the conversion must sort numerically.
        const seq = lua.doStringSync(`local t = {} for i = 1, 11 do t[i] = "v" .. i end return t`);
        expect(toStringArray(seq)[9]).toBe("v10");
        expect(toArray(seq).length).toBe(11);
        lua.global.close();
    });

    test("non-string entries are coerced or dropped", () => {
        expect(toStringArray({ 1: "a", 2: 3, 3: true })).toEqual(["a", "3"]);
        expect(asNumber("x")).toBeUndefined();
        expect(asString(7)).toBe("7");
    });
});

describe("lua errors", () => {
    test("the inlined chunk source is stripped from the message", () => {
        const raw = new Error(`[string "local x = 1\nlocal y = 2"]:3: attempt to index a nil value`);
        expect(cleanLuaError(raw)).toBe("line 3: attempt to index a nil value");
    });
});

describe("lua auto-load", () => {
    let home: string;
    let dir: string;

    beforeAll(() => {
        home = mkdtempSync(join(tmpdir(), "loop-lua-test-"));
        dir = join(home, ".loop", "lua");
        mkdirSync(join(dir, "mod"), { recursive: true });
    });
    afterAll(() => rmSync(home, { recursive: true, force: true }));

    test("init.lua runs first, require resolves a submodule, and one broken file does not stop the rest", async () => {
        const { installRequire, loadScripts } = await import("../src/extensions/builtin/lua/loader");
        writeFileSync(join(dir, "mod", "helper.lua"), `return { value = function() return "from-module" end }`);
        writeFileSync(join(dir, "init.lua"), `ORDER = "init"`);
        writeFileSync(join(dir, "later.lua"), `ORDER = ORDER .. ",later"\nVIA = require("mod.helper").value()`);
        writeFileSync(join(dir, "broken.lua"), `= = =`);

        const lua = await preludeVm();
        installRequire(lua, dir);
        const report = loadScripts(lua, dir);

        // broken.lua sorts first alphabetically; init.lua must still lead.
        expect(lua.global.get("ORDER")).toBe("init,later");
        expect(lua.global.get("VIA")).toBe("from-module");
        expect(report.loaded.map((s) => s.name).sort()).toEqual(["init.lua", "later.lua"]);
        expect(report.failures.length).toBe(1);
        expect(report.failures[0].path).toContain("broken.lua");
        lua.global.close();
    });

    test("require refuses to escape the lua directory", async () => {
        const { installRequire } = await import("../src/extensions/builtin/lua/loader");
        writeFileSync(join(home, "outside.lua"), `return "should not load"`);
        const lua = await preludeVm();
        installRequire(lua, dir);
        expect(() => lua.doStringSync(`return require("..outside")`)).toThrow(/not found/);
        lua.global.close();
    });
});

describe("lua widgets and keymaps", () => {
    /** A fake ExtensionAPI recording what the Lua side asked for. */
    function fakeApi() {
        const shown: {
            renderer: { render(w: number): string[]; handleInput?(d: string): boolean };
            options?: Record<string, unknown>;
        }[] = [];
        const hidden: boolean[] = [];
        const keys: { key: string; handler: () => boolean | void }[] = [];
        const docks: {
            renderer: { render(w: number): string[]; handleInput?(d: string): boolean };
            options?: Record<string, unknown>;
            closed: boolean;
            size?: unknown;
        }[] = [];
        const disposed: string[] = [];
        const api = {
            version: "0.3.1",
            extension: { dir: "", manifest: {}, log: () => {}, setStatus: () => {} },
            commands: { register: () => {}, unregister: () => {}, override: () => {} },
            settings: { getOwn: (_k: string, f: unknown) => f, setOwn: () => {} },
            statusLine: { add: () => {}, transform: () => {}, refresh: () => {} },
            widgets: {
                show(
                    renderer: { render(w: number): string[]; handleInput?(d: string): boolean },
                    options?: Record<string, unknown>,
                ) {
                    shown.push({ renderer, options });
                    let isHidden = false;
                    return {
                        hide: () => hidden.push(true),
                        setHidden: (h: boolean) => {
                            isHidden = h;
                        },
                        isHidden: () => isHidden,
                        focus: () => {},
                        unfocus: () => {},
                    };
                },
            },
            docks: {
                open(
                    renderer: { render(w: number): string[]; handleInput?(d: string): boolean },
                    options?: Record<string, unknown>,
                ) {
                    let isOpen = true;
                    let focused = false;
                    const entry = { renderer, options, closed: false, size: options?.size };
                    docks.push(entry);
                    return {
                        close: () => {
                            isOpen = false;
                            entry.closed = true;
                        },
                        setSize: (rows: number) => {
                            entry.size = rows;
                        },
                        isOpen: () => isOpen,
                        focus: () => {
                            focused = true;
                        },
                        unfocus: () => {
                            focused = false;
                        },
                        isFocused: () => focused,
                    };
                },
            },
            keymap: {
                set(key: string, handler: () => boolean | void) {
                    keys.push({ key, handler });
                    return () => disposed.push(key);
                },
            },
        };
        return { api, shown, hidden, keys, disposed, docks };
    }

    async function runtimeWith(script: string) {
        const { installHostFunctions, makeInvoke, createOwnership } =
            await import("../src/extensions/builtin/lua/surface");
        const lua = await createLuaVm();
        const f = fakeApi();
        const own = createOwnership();
        const invoke = makeInvoke(lua, () => {});
        installHostFunctions({
            api: f.api as never,
            lua,
            invoke,
            own,
            log: () => {},
            onError: () => {},
        });
        lua.doStringSync(LUA_PRELUDE);
        lua.doStringSync(script);
        return { lua, own, ...f };
    }

    test("a Lua table renders as a widget and its lines reach the host", async () => {
        const r = await runtimeWith(`
            W = { n = 7 }
            function W:render(width) return { "w=" .. width, "n=" .. self.n } end
            H = loop.widget.show(W)
        `);
        expect(r.shown.length).toBe(1);
        expect(r.shown[0].renderer.render(30)).toEqual(["w=30", "n=7"]);
        r.lua.global.close();
    });

    test("widget state survives between frames and on_key can mutate it", async () => {
        const r = await runtimeWith(`
            W = { count = 0 }
            function W:render(width) return { "count=" .. self.count } end
            function W:on_key(data)
              if data == "j" then self.count = self.count + 1 return true end
              return false
            end
            H = loop.widget.show(W)
        `);
        const { renderer } = r.shown[0];
        expect(renderer.render(10)).toEqual(["count=0"]);
        expect(renderer.handleInput?.("j")).toBe(true);
        expect(renderer.handleInput?.("j")).toBe(true);
        expect(renderer.handleInput?.("x")).toBe(false); // declined keys pass through
        expect(renderer.render(10)).toEqual(["count=2"]);
        r.lua.global.close();
    });

    test("a throwing render is contained and reported as no lines, not a crash", async () => {
        const r = await runtimeWith(`
            W = {}
            function W:render(width) error("bad widget") end
            H = loop.widget.show(W)
        `);
        // The Lua-side invoke swallows the error; the CLI adapter is what turns
        // it into a visible line. Either way it must not propagate.
        expect(() => r.shown[0].renderer.render(10)).not.toThrow();
        r.lua.global.close();
    });

    test("a keymap handler runs, and consumes the key unless it returns false", async () => {
        const r = await runtimeWith(`
            FIRED = 0
            loop.keymap.set("ctrl+g", function() FIRED = FIRED + 1 end)
            loop.keymap.set("ctrl+h", function() FIRED = FIRED + 1 return false end)
        `);
        expect(r.keys.map((k) => k.key)).toEqual(["ctrl+g", "ctrl+h"]);
        expect(r.keys[0].handler()).toBe(true); // nil return consumes
        expect(r.keys[1].handler()).toBe(false); // explicit false declines
        expect(r.lua.global.get("FIRED")).toBe(2);
        r.lua.global.close();
    });

    test("disposing the runtime takes widgets down and releases key bindings", async () => {
        const r = await runtimeWith(`
            W = {}
            function W:render(w) return { "x" } end
            loop.widget.show(W)
            loop.keymap.set("ctrl+g", function() end)
        `);
        expect(r.hidden.length).toBe(0);
        r.own.dispose();
        // Without this a /lua reload leaves a widget painted over the chat that
        // no script can reach any more, and a dead binding still eating keys.
        expect(r.hidden.length).toBe(1);
        expect(r.disposed).toEqual(["ctrl+g"]);
        r.lua.global.close();
    });

    test("placement options are translated from snake_case to the API shape", async () => {
        const r = await runtimeWith(`
            W = {}
            function W:render(w) return {} end
            H = loop.widget.show({
              render = W.render,
              anchor = "center", width = "50%", min_width = 20,
              max_height = 12, offset_x = 1, offset_y = -2, row = "25%", col = 4,
            })
        `);
        expect(r.shown[0].options).toEqual({
            anchor: "center",
            width: "50%",
            minWidth: 20,
            maxHeight: 12,
            offsetX: 1,
            offsetY: -2,
            row: "25%",
            col: 4,
            // Widgets do not steal focus unless the script opts in.
            nonCapturing: true,
        });
        r.lua.global.close();
    });

    test("non_capturing = false is honoured, so a widget can take focus", async () => {
        const r = await runtimeWith(`
            W = {}
            function W:render(w) return {} end
            loop.widget.show({ render = W.render, non_capturing = false })
        `);
        expect(r.shown[0].options?.nonCapturing).toBe(false);
        r.lua.global.close();
    });
});

describe("lua docks", () => {
    test("a dock renders, and its size and side reach the host", async () => {
        const { installHostFunctions, makeInvoke, createOwnership } =
            await import("../src/extensions/builtin/lua/surface");
        const lua = await createLuaVm();
        const own = createOwnership();
        const invoke = makeInvoke(lua, () => {});
        // Rebuild the fake API inline (the widget suite's helper is scoped there).
        const docks: { renderer: { render(w: number): string[] }; options?: Record<string, unknown> }[] = [];
        const api = {
            version: "0.3.1",
            extension: { dir: "", manifest: {}, log: () => {}, setStatus: () => {} },
            commands: { register: () => {}, unregister: () => {}, override: () => {} },
            settings: { getOwn: (_k: string, f: unknown) => f, setOwn: () => {} },
            statusLine: { add: () => {}, transform: () => {}, refresh: () => {} },
            widgets: { show: () => undefined },
            keymap: { set: () => () => {} },
            docks: {
                open(renderer: { render(w: number): string[] }, options?: Record<string, unknown>) {
                    docks.push({ renderer, options });
                    return {
                        close: () => {},
                        setSize: () => {},
                        isOpen: () => true,
                        focus: () => {},
                        unfocus: () => {},
                        isFocused: () => false,
                    };
                },
            },
        };
        installHostFunctions({ api: api as never, lua, invoke, own, log: () => {}, onError: () => {} });
        lua.doStringSync(LUA_PRELUDE);
        lua.doStringSync(`
            P = { size = 6, rows = { "a", "b" } }
            function P:render(width) return { "w=" .. width, self.rows[1], self.rows[2] } end
            D = loop.dock.open(P)
        `);
        expect(docks.length).toBe(1);
        expect(docks[0].options).toEqual({ size: 6, side: "bottom" });
        expect(docks[0].renderer.render(12)).toEqual(["w=12", "a", "b"]);
        lua.global.close();
    });

    test("disposing the runtime closes docks, so a reload cannot strand a panel", async () => {
        const { installHostFunctions, makeInvoke, createOwnership } =
            await import("../src/extensions/builtin/lua/surface");
        const lua = await createLuaVm();
        const own = createOwnership();
        const invoke = makeInvoke(lua, () => {});
        let closed = 0;
        const api = {
            version: "0.3.1",
            extension: { dir: "", manifest: {}, log: () => {}, setStatus: () => {} },
            commands: { register: () => {}, unregister: () => {}, override: () => {} },
            settings: { getOwn: (_k: string, f: unknown) => f, setOwn: () => {} },
            statusLine: { add: () => {}, transform: () => {}, refresh: () => {} },
            widgets: { show: () => undefined },
            keymap: { set: () => () => {} },
            docks: {
                open: () => ({
                    close: () => closed++,
                    setSize: () => {},
                    isOpen: () => true,
                    focus: () => {},
                    unfocus: () => {},
                    isFocused: () => false,
                }),
            },
        };
        installHostFunctions({ api: api as never, lua, invoke, own, log: () => {}, onError: () => {} });
        lua.doStringSync(LUA_PRELUDE);
        lua.doStringSync(`
            P = {}
            function P:render(w) return {} end
            loop.dock.open(P)
        `);
        expect(closed).toBe(0);
        own.dispose();
        expect(closed).toBe(1);
        lua.global.close();
    });
});

describe("lua mouse", () => {
    async function mouseRuntime(script: string) {
        const { installHostFunctions, makeInvoke, createOwnership } =
            await import("../src/extensions/builtin/lua/surface");
        const lua = await createLuaVm();
        const own = createOwnership();
        const invoke = makeInvoke(lua, () => {});
        let renderer: { handleMouse?(e: Record<string, unknown>): boolean } | undefined;
        const positions: { row: number; col: number }[] = [];
        const api = {
            version: "0.3.1",
            extension: { dir: "", manifest: {}, log: () => {}, setStatus: () => {} },
            commands: { register: () => {}, unregister: () => {}, override: () => {} },
            settings: { getOwn: (_k: string, f: unknown) => f, setOwn: () => {} },
            statusLine: { add: () => {}, transform: () => {}, refresh: () => {} },
            docks: { open: () => undefined },
            keymap: { set: () => () => {} },
            widgets: {
                show(r: { handleMouse?(e: Record<string, unknown>): boolean }) {
                    renderer = r;
                    return {
                        hide: () => {},
                        setHidden: () => {},
                        isHidden: () => false,
                        focus: () => {},
                        unfocus: () => {},
                        setPosition: (row: number, col: number) => positions.push({ row, col }),
                        getPosition: () => positions[positions.length - 1],
                    };
                },
            },
        };
        installHostFunctions({ api: api as never, lua, invoke, own, log: () => {}, onError: () => {} });
        lua.doStringSync(LUA_PRELUDE);
        lua.doStringSync(script);
        return {
            lua,
            get renderer() {
                return renderer;
            },
            positions,
        };
    }

    const event = (over: Record<string, unknown> = {}) => ({
        type: "press",
        button: 0,
        x: 0,
        y: 0,
        screenX: 0,
        screenY: 0,
        shift: false,
        alt: false,
        ctrl: false,
        ...over,
    });

    test("loop.screen() reports the terminal size a full-screen widget needs", async () => {
        const { installHostFunctions, makeInvoke, createOwnership } =
            await import("../src/extensions/builtin/lua/surface");
        const lua = await createLuaVm();
        const own = createOwnership();
        const invoke = makeInvoke(lua, () => {});
        const api = {
            version: "0.3.1",
            extension: { dir: "", manifest: {}, log: () => {}, setStatus: () => {} },
            commands: { register: () => {}, unregister: () => {}, override: () => {} },
            settings: { getOwn: (_k: string, f: unknown) => f, setOwn: () => {} },
            statusLine: { add: () => {}, transform: () => {}, refresh: () => {} },
            widgets: { show: () => undefined },
            docks: { open: () => undefined },
            keymap: { set: () => () => {} },
            // render(width) never receives a height, so anything drawing a full
            // screen has to ask for the row count.
            screen: () => ({ rows: 45, cols: 180 }),
        };
        installHostFunctions({ api: api as never, lua, invoke, own, log: () => {}, onError: () => {} });
        lua.doStringSync(LUA_PRELUDE);
        expect(lua.doStringSync(`local s = loop.screen() return s.rows * 1000 + s.cols`)).toBe(45180);
        lua.global.close();
    });

    test("a widget receives mouse events with local and screen coordinates", async () => {
        const r = await mouseRuntime(`
            SEEN = {}
            W = {}
            function W:render(w) return {} end
            function W:on_mouse(ev)
              SEEN = { type = ev.type, x = ev.x, y = ev.y, sx = ev.screen_x, sy = ev.screen_y, alt = ev.alt }
              return true
            end
            loop.widget.show(W)
        `);
        expect(r.renderer?.handleMouse?.(event({ type: "drag", x: 3, y: 1, screenX: 20, screenY: 9, alt: true }))).toBe(
            true,
        );
        expect(r.lua.global.get("SEEN")).toEqual({ type: "drag", x: 3, y: 1, sx: 20, sy: 9, alt: true });
        r.lua.global.close();
    });

    test("a widget declining an event lets it through to the terminal", async () => {
        const r = await mouseRuntime(`
            W = {}
            function W:render(w) return {} end
            function W:on_mouse(ev) return false end
            loop.widget.show(W)
        `);
        // False must survive the boundary as false — anything else would make a
        // widget swallow clicks it explicitly refused, breaking text selection.
        expect(r.renderer?.handleMouse?.(event())).toBe(false);
        r.lua.global.close();
    });

    test("a widget with no on_mouse gets no mouse handler at all", async () => {
        const r = await mouseRuntime(`
            W = {}
            function W:render(w) return {} end
            loop.widget.show(W)
        `);
        expect(r.renderer?.handleMouse).toBeUndefined();
        r.lua.global.close();
    });

    test("dragging: the grab offset turns pointer travel into a new position", async () => {
        const r = await mouseRuntime(`
            W = { grab = nil }
            function W:render(w) return {} end
            function W:on_mouse(ev)
              if ev.type == "press" then self.grab = { x = ev.x, y = ev.y } return true
              elseif ev.type == "drag" and self.grab then
                self.handle:set_pos(ev.screen_y - self.grab.y, ev.screen_x - self.grab.x)
                return true
              elseif ev.type == "release" then self.grab = nil return true end
              return false
            end
            loop.widget.show(W)
        `);
        // Grab 2 cells in and 1 down from the corner, then move the pointer to
        // (30, 12): the widget's corner must land at (12 - 1, 30 - 2).
        r.renderer?.handleMouse?.(event({ type: "press", x: 2, y: 1, screenX: 10, screenY: 5 }));
        r.renderer?.handleMouse?.(event({ type: "drag", x: 2, y: 1, screenX: 30, screenY: 12 }));
        expect(r.positions).toEqual([{ row: 11, col: 28 }]);

        // After release the grab is dropped, so stray motion moves nothing.
        r.renderer?.handleMouse?.(event({ type: "release", screenX: 30, screenY: 12 }));
        r.renderer?.handleMouse?.(event({ type: "drag", screenX: 60, screenY: 20 }));
        expect(r.positions.length).toBe(1);
        r.lua.global.close();
    });
});
