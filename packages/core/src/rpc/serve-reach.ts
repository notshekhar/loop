/**
 * How another device reaches `loop serve`, and how a person hands it the link.
 *
 * The pairing link is the URL serve prints (see serve-pairing.ts). The best
 * one to hand a phone is the tailnet name when this machine is on Tailscale —
 * it works from anywhere and survives a change of Wi-Fi — then a LAN address,
 * then loopback. `loop serve` prints the best as a QR code.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

import { QrCode } from "./qr-code";

/** Where the CLI lives when Tailscale is the macOS app rather than a package. */
const MAC_APP_CLI = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

export interface TailnetIdentity {
    /** MagicDNS name without the trailing dot (`studio.tail1234.ts.net`). */
    readonly dnsName: string | null;
    readonly ips: readonly string[];
}

/**
 * This machine on its tailnet, or null when Tailscale is absent, stopped, or
 * slow to answer. Never throws: reachability is a nicety on top of serve.
 */
export function tailnetIdentity(timeoutMs = 1500): TailnetIdentity | null {
    for (const bin of ["tailscale", ...(existsSync(MAC_APP_CLI) ? [MAC_APP_CLI] : [])]) {
        try {
            const result = spawnSync(bin, ["status", "--json"], { encoding: "utf8", timeout: timeoutMs });
            if (result.status !== 0 || !result.stdout) continue;
            const status = JSON.parse(result.stdout) as {
                BackendState?: string;
                Self?: { DNSName?: string; TailscaleIPs?: string[] };
            };
            if (status.BackendState !== "Running" || !status.Self) return null;
            const dnsName = status.Self.DNSName?.replace(/\.$/, "") || null;
            return { dnsName, ips: status.Self.TailscaleIPs ?? [] };
        } catch {
            // Not installed, or not JSON: try the next binary.
        }
    }
    return null;
}

/**
 * A QR code as terminal text: two modules per character row (▀ ▄ █) inside
 * the spec's quiet zone, in explicit black on white so it scans the same on a
 * light or a dark terminal theme — cameras do not reliably read an inverted
 * code, which is what drawing with the theme's own colours produces.
 */
export function terminalQr(text: string): string {
    const qr = QrCode.encodeText(text, QrCode.Ecc.LOW);
    const quiet = 2;
    const dark = (x: number, y: number) =>
        x >= 0 && y >= 0 && x < qr.size && y < qr.size && qr.getModule(x, y);
    const lines: string[] = [];
    for (let y = -quiet; y < qr.size + quiet; y += 2) {
        let line = "";
        for (let x = -quiet; x < qr.size + quiet; x++) {
            const top = dark(x, y);
            const bottom = dark(x, y + 1);
            line += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
        }
        // Black foreground (the modules) on a white background (the paper).
        lines.push(`\x1b[30;47m${line}\x1b[0m`);
    }
    return lines.join("\n");
}
