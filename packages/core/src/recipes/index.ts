/** Personal, editable workflows. Values are prompt text, never shell substitutions. */
import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getConfigDir } from "../brand";

export interface Recipe {
    name: string;
    body: string;
    inputs: string[];
    path: string;
}

export function recipeInputs(body: string): string[] {
    return [...new Set([...body.matchAll(/\{\{([a-zA-Z][a-zA-Z0-9_]*)\}\}/g)].map((m) => m[1]))];
}

export function validateRecipeName(name: string): void {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) {
        throw new Error("Recipe names use lowercase letters, numbers and dashes (1–64 characters).");
    }
}

export class RecipeStore {
    constructor(readonly directory = join(getConfigDir(), "recipes")) {}

    path(name: string): string {
        validateRecipeName(name);
        return join(this.directory, `${name}.md`);
    }

    read(name: string): Recipe {
        const path = this.path(name);
        const body = readFileSync(path, "utf8").trim();
        if (!body) throw new Error(`Recipe "${name}" is empty — edit ${path}.`);
        return { name, body, inputs: recipeInputs(body), path };
    }

    names(): string[] {
        try {
            return readdirSync(this.directory, { withFileTypes: true })
                .filter((e) => e.isFile() && /^[a-z0-9][a-z0-9-]{0,63}\.md$/.test(e.name))
                .map((e) => e.name.slice(0, -3))
                .sort();
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
            throw error;
        }
    }

    save(name: string, body: string, replace = false): Recipe {
        const path = this.path(name);
        if (!body.trim()) throw new Error("A recipe cannot be empty.");
        mkdirSync(this.directory, { recursive: true });
        if (!replace) {
            writeFileSync(path, `${body.trim()}\n`, { flag: "wx", mode: 0o600 });
        } else {
            const temporary = `${path}.${randomUUID()}.tmp`;
            try {
                writeFileSync(temporary, `${body.trim()}\n`, { flag: "wx", mode: 0o600 });
                renameSync(temporary, path);
            } finally {
                try {
                    unlinkSync(temporary);
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
                }
            }
        }
        return this.read(name);
    }

    remove(name: string): void {
        unlinkSync(this.path(name));
    }
}

/** Quotes group values; nothing here evaluates shell syntax. */
export function parseRecipeArgs(raw: string): string[] {
    const args: string[] = [];
    let value = "";
    let quote = "";
    let started = false;
    for (let i = 0; i < raw.length; i++) {
        const c = raw[i];
        if (c === "\\" && quote !== "'" && i + 1 < raw.length && /[\s'"\\]/.test(raw[i + 1])) {
            value += raw[++i];
            started = true;
        } else if (quote) {
            if (c === quote) quote = "";
            else value += c;
        } else if (c === '"' || c === "'") {
            quote = c;
            started = true;
        } else if (/\s/.test(c)) {
            if (started) args.push(value);
            value = "";
            started = false;
        } else {
            value += c;
            started = true;
        }
    }
    if (quote) throw new Error("Unclosed quote in recipe arguments.");
    if (started) args.push(value);
    return args;
}

/** Positional values follow placeholder order; name=value can arrive in any order. */
export function bindRecipeInputs(recipe: Recipe, args: string[]): Record<string, string> {
    const values: Record<string, string> = Object.create(null);
    const positional: string[] = [];
    for (const arg of args) {
        const match = /^([a-zA-Z][a-zA-Z0-9_]*)=([\s\S]*)$/.exec(arg);
        if (!match) {
            positional.push(arg);
            continue;
        }
        const [, key, value] = match;
        if (!recipe.inputs.includes(key))
            throw new Error(`Unknown input "${key}". Inputs: ${recipe.inputs.join(", ") || "none"}.`);
        if (Object.hasOwn(values, key)) throw new Error(`Input "${key}" was supplied twice.`);
        values[key] = value;
    }
    const remaining = recipe.inputs.filter((key) => !Object.hasOwn(values, key));
    if (positional.length > remaining.length)
        throw new Error(`Too many values. Inputs: ${recipe.inputs.join(", ") || "none"}.`);
    positional.forEach((value, i) => {
        values[remaining[i]] = value;
    });
    return values;
}

export function renderRecipe(recipe: Recipe, values: Record<string, string>): string {
    const missing = recipe.inputs.filter((key) => !Object.hasOwn(values, key) || !values[key].trim());
    if (missing.length) throw new Error(`Missing recipe inputs: ${missing.join(", ")}.`);
    // One pass: a value containing {{another_input}} stays literal.
    const body = recipe.body.replace(/\{\{([a-zA-Z][a-zA-Z0-9_]*)\}\}/g, (_, key: string) => values[key]);
    return `Run the saved recipe "${recipe.name}" in the current workspace. Inspect the current code before adapting its steps. Follow workspace instructions and the active agent's permissions. Check the stated success criteria and report what was verified.\n\n${body}`;
}

export { generateRecipe, recipeConversation } from "./generate";
