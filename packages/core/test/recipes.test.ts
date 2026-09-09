import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    bindRecipeInputs,
    parseRecipeArgs,
    recipeConversation,
    recipeInputs,
    RecipeStore,
    renderRecipe,
} from "../src/recipes";
import type { Entry } from "../src/types";

const dirs: string[] = [];
afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function store() {
    const dir = mkdtempSync(join(tmpdir(), "loop-recipes-test-"));
    dirs.push(dir);
    return new RecipeStore(join(dir, "recipes"));
}

describe("recipe storage and inputs", () => {
    test("persists editable Markdown, refuses overwrite, edits and deletes", () => {
        const s = store();
        expect(s.names()).toEqual([]);
        const saved = s.save("add-endpoint", "# Endpoint\nAdd {{resource}} at {{route}}. Test {{resource}}.");
        expect(saved.inputs).toEqual(["resource", "route"]);
        expect(readFileSync(saved.path, "utf8")).toBe(saved.body + "\n");
        expect(new RecipeStore(s.directory).read(saved.name)).toEqual(saved);
        expect(() => s.save(saved.name, "overwrite")).toThrow();
        expect(s.read(saved.name).body).toBe(saved.body);
        s.save(saved.name, "changed", true);
        expect(s.read(saved.name).body).toBe("changed");
        s.remove(saved.name);
        expect(s.names()).toEqual([]);
    });

    test("rejects unsafe names and empty recipes without writing", () => {
        const s = store();
        for (const name of ["../escape", "/tmp/escape", "a/b", "a\\b", ".", "", "a".repeat(65)]) {
            expect(() => s.save(name, "steps")).toThrow();
            expect(() => s.read(name)).toThrow();
            expect(() => s.remove(name)).toThrow();
        }
        expect(() => s.save("empty", "  ")).toThrow();
        expect(s.names()).toEqual([]);
    });

    test("binds mixed named and positional arguments, preserving literal values", () => {
        const recipe = store().save("endpoint", "Create {{resource}} at {{route}}. Test {{resource}}.");
        const args = parseRecipeArgs('route="/api/user accounts" users');
        const values = bindRecipeInputs(recipe, args);
        expect(renderRecipe(recipe, values)).toContain("Create users at /api/user accounts. Test users.");
        expect(renderRecipe(recipe, { resource: "{{route}} $&", route: "/api" })).toContain(
            "Create {{route}} $& at /api",
        );
        expect(parseRecipeArgs("'two words' C:\\work\\repo '$(touch /tmp/nope)' \"\"")).toEqual([
            "two words",
            "C:\\work\\repo",
            "$(touch /tmp/nope)",
            "",
        ]);
    });

    test("refuses ambiguous or incomplete inputs", () => {
        const recipe = store().save("endpoint", "{{resource}} {{route}}");
        expect(() => parseRecipeArgs('"unclosed')).toThrow("Unclosed quote");
        expect(() => bindRecipeInputs(recipe, ["wrong=users"])).toThrow("Unknown input");
        expect(() => bindRecipeInputs(recipe, ["resource=a", "resource=b"])).toThrow("twice");
        expect(() => bindRecipeInputs(recipe, ["a", "b", "c"])).toThrow("Too many");
        expect(() => renderRecipe(recipe, { resource: "a" })).toThrow("route");
        expect(() => renderRecipe(recipe, { resource: "a", route: " " })).toThrow("route");
        expect(recipeInputs("{{resource}} {{resource}} {{valid_2}} {{not-valid}}")).toEqual(["resource", "valid_2"]);
    });

    test("input names matching Object properties work without prototype lookup", () => {
        const recipe = store().save("edge", "{{constructor}} {{toString}}");
        expect(() => renderRecipe(recipe, {})).toThrow("Missing");
        expect(renderRecipe(recipe, bindRecipeInputs(recipe, ["constructor=one", "toString=two"]))).toContain(
            "one two",
        );
    });

    test("large extraction context retains the opening task and final outcome", () => {
        const message = (content: string): Entry => ({ type: "message", role: "user", content }) as Entry;
        const entries = [
            message("original task"),
            ...Array.from({ length: 40 }, () => message("x".repeat(20_000))),
            message("final verification passed"),
        ];
        const text = recipeConversation(entries);
        expect(text.length).toBeLessThanOrEqual(60_000);
        expect(text).toContain("original task");
        expect(text).toContain("final verification passed");
        expect(text).toContain("omitted");
    });
});
