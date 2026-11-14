/**
 * Field caps for what loop sends to the terminals that watch it (cmux, Orca).
 * They store what we send, so a 3MB tool result must not ride the wire.
 */

/** Cap on any single serialized field. */
export const MAX_FIELD_BYTES = 8_000;

/** JSON-safe, and no bigger than `maxBytes` once serialized. */
export function bounded(value: unknown, maxBytes = MAX_FIELD_BYTES): unknown {
    if (value === undefined || value === null) return value;
    let json: string;
    try {
        json = JSON.stringify(value) ?? "";
    } catch {
        return undefined; // circular / unserializable — the field is optional
    }
    if (json.length <= maxBytes) return value;
    if (typeof value === "string") return `${value.slice(0, maxBytes)}… [truncated by loop]`;
    return { truncated: true, bytes: json.length, preview: `${json.slice(0, 1_000)}…` };
}
