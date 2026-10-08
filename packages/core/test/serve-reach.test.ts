import { describe, expect, test } from "bun:test";

import { QrCode } from "../src/rpc/qr-code";
import { tailnetIdentity, terminalQr } from "../src/rpc/serve-reach";

const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

describe("terminalQr", () => {
    const url = "http://studio.tail1234.ts.net:5667/?token=abc123";

    test("draws every module of the code, two rows per line, inside a quiet zone", () => {
        const qr = QrCode.encodeText(url, QrCode.Ecc.LOW);
        const lines = strip(terminalQr(url)).split("\n");
        const quiet = 2;
        expect(lines).toHaveLength(Math.ceil((qr.size + quiet * 2) / 2));
        // Read the modules back out of the block characters.
        for (let y = 0; y < qr.size; y++) {
            for (let x = 0; x < qr.size; x++) {
                const row = y + quiet;
                const ch = lines[Math.floor(row / 2)]![x + quiet]!;
                const top = ch === "█" || ch === "▀";
                const bottom = ch === "█" || ch === "▄";
                expect(row % 2 === 0 ? top : bottom).toBe(qr.getModule(x, y));
            }
        }
    });

    test("is black on white whatever the terminal theme", () => {
        for (const line of terminalQr(url).split("\n")) {
            expect(line.startsWith("\x1b[30;47m")).toBe(true);
            expect(line.endsWith("\x1b[0m")).toBe(true);
        }
    });
});

describe("tailnetIdentity", () => {
    test("answers or declines, but never throws", () => {
        const identity = tailnetIdentity(500);
        if (identity !== null) expect(Array.isArray(identity.ips)).toBe(true);
    });
});
