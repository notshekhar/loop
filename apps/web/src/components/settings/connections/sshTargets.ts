import type { DesktopSshEnvironmentTarget } from "@loop/contracts";

export function formatDesktopSshTarget(target: DesktopSshEnvironmentTarget): string {
  const authority = target.username ? `${target.username}@${target.hostname}` : target.hostname;
  return target.port ? `${authority}:${target.port}` : authority;
}

function splitInlineHostPort(hostname: string): { hostname: string; port: number | null } {
  const bracketedHostMatch = /^\[([^\]]+)\](?::(\d+))?$/u.exec(hostname);
  if (bracketedHostMatch) {
    return {
      hostname: bracketedHostMatch[1]!.trim(),
      port: bracketedHostMatch[2] ? Number.parseInt(bracketedHostMatch[2], 10) : null,
    };
  }
  const colonSegments = hostname.split(":");
  if (colonSegments.length === 2 && /^\d+$/u.test(colonSegments[1] ?? "")) {
    return { hostname: colonSegments[0]!.trim(), port: Number.parseInt(colonSegments[1]!, 10) };
  }
  return { hostname, port: null };
}

export function parseManualDesktopSshTarget(input: {
  readonly host: string;
  readonly username: string;
  readonly port: string;
}): DesktopSshEnvironmentTarget {
  const rawHost = input.host.trim();
  if (rawHost.length === 0) {
    throw new Error("SSH host or alias is required.");
  }

  let hostname = rawHost;
  let username = input.username.trim() || null;

  const atIndex = hostname.lastIndexOf("@");
  if (atIndex > 0) {
    const inlineUsername = hostname.slice(0, atIndex).trim();
    hostname = hostname.slice(atIndex + 1).trim();
    if (!username && inlineUsername.length > 0) {
      username = inlineUsername;
    }
  }

  const inline = splitInlineHostPort(hostname);
  hostname = inline.hostname;
  let port = inline.port;

  const rawPort = input.port.trim();
  if (rawPort.length > 0) {
    port = Number.parseInt(rawPort, 10);
  }

  if (hostname.length === 0) {
    throw new Error("SSH host or alias is required.");
  }

  if (port !== null && (!Number.isInteger(port) || port <= 0 || port > 65_535)) {
    throw new Error("SSH port must be between 1 and 65535.");
  }

  return {
    alias: hostname,
    hostname,
    username,
    port,
  };
}

export function formatDesktopSshConnectionError(error: unknown): string {
  const fallback = "Failed to connect SSH host.";
  const rawMessage = error instanceof Error ? error.message : fallback;
  const withoutIpcPrefix = rawMessage.replace(
    /^Error invoking remote method 'desktop:ensure-ssh-environment':\s*/u,
    "",
  );
  const withoutTaggedErrorPrefix = withoutIpcPrefix.replace(/^Ssh[A-Za-z]+Error:\s*/u, "");
  return withoutTaggedErrorPrefix.trim() || fallback;
}
