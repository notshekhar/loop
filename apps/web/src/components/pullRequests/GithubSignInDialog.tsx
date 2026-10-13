/**
 * Sign `gh` in on the machine running loop, without a terminal.
 *
 * Browser: the host starts `gh auth login --web`, this dialog shows the
 * one-time code and opens github.com/login/device here — on this device, so a
 * client paired with a remote host signs that host in. It then asks the host
 * every two seconds, and only while open, whether the user has finished.
 *
 * Token: a personal access token handed to `gh auth login --with-token`; `gh`
 * checks it and keeps it in the system keyring. loop stores nothing.
 */
import type { EnvironmentId } from "@loop/contracts";
import { isAtomCommandInterrupted, squashAtomCommandFailure } from "@loop/runtime/state/runtime";
import { CheckIcon, CopyIcon, ExternalLinkIcon, KeyRoundIcon, LogInIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { sourceControlEnvironment } from "../../state/sourceControl";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { openExternalUrl } from "./usePullRequests";

const STATUS_INTERVAL_MS = 2_000;
const TOKEN_URL =
  "https://github.com/settings/tokens/new?scopes=repo,read:org,workflow&description=loop";

type Mode = "browser" | "token";

function failureText(result: Parameters<typeof squashAtomCommandFailure>[0]): string {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : String(error);
}

export function GithubSignInDialog(props: {
  readonly open: boolean;
  readonly environmentId: EnvironmentId;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSignedIn: () => void;
}) {
  const { open, environmentId, onOpenChange, onSignedIn } = props;
  const start = useAtomCommand(sourceControlEnvironment.githubLoginStart, { reportFailure: false });
  const status = useAtomCommand(sourceControlEnvironment.githubLoginStatus, { reportFailure: false });
  const cancel = useAtomCommand(sourceControlEnvironment.githubLoginCancel, { reportFailure: false });
  const withToken = useAtomCommand(sourceControlEnvironment.githubLoginWithToken, {
    reportFailure: false,
  });

  const [mode, setMode] = useState<Mode>("browser");
  const [login, setLogin] = useState<{ id: string; code: string; url: string } | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState("");
  const [savingToken, setSavingToken] = useState(false);
  const [copied, setCopied] = useState(false);
  const loginRef = useRef(login);
  loginRef.current = login;

  const finish = useCallback(() => {
    setLogin(null);
    setToken("");
    toastManager.add({ type: "success", title: "Signed in to GitHub" });
    onSignedIn();
    onOpenChange(false);
  }, [onOpenChange, onSignedIn]);

  // Closing abandons a browser sign-in, so `gh` is not left waiting on the host.
  const close = useCallback(
    (next: boolean) => {
      if (!next && loginRef.current) {
        void cancel({ environmentId, input: { id: loginRef.current.id } });
        setLogin(null);
      }
      if (!next) {
        setError(null);
        setStarting(false);
      }
      onOpenChange(next);
    },
    [cancel, environmentId, onOpenChange],
  );

  const beginBrowser = useCallback(async () => {
    setError(null);
    setStarting(true);
    const result = await start({ environmentId, input: {} });
    setStarting(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) setError(failureText(result));
      return;
    }
    setLogin(result.value);
    openExternalUrl(result.value.url);
  }, [environmentId, start]);

  useEffect(() => {
    if (!open || !login) return;
    let stopped = false;
    const timer = setInterval(async () => {
      const result = await status({ environmentId, input: { id: login.id } });
      if (stopped) return;
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) setError(failureText(result));
        setLogin(null);
        return;
      }
      if (result.value.state === "done") finish();
      else if (result.value.state === "failed") {
        setError(result.value.error ?? "Sign-in did not complete.");
        setLogin(null);
      }
    }, STATUS_INTERVAL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [environmentId, finish, login, open, status]);

  const submitToken = useCallback(async () => {
    setError(null);
    setSavingToken(true);
    const result = await withToken({ environmentId, input: { token } });
    setSavingToken(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) setError(failureText(result));
      return;
    }
    finish();
  }, [environmentId, finish, token, withToken]);

  const copyCode = useCallback(() => {
    if (!login) return;
    void navigator.clipboard?.writeText(login.code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [login]);

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Sign in to GitHub</DialogTitle>
          <DialogDescription>
            Pull requests go through the GitHub CLI on the machine running loop. Sign it in here —
            the login stays in that machine's keychain.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <div className="flex gap-1 rounded-lg bg-muted/60 p-1">
            {(["browser", "token"] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => {
                  setMode(value);
                  setError(null);
                }}
                className={
                  mode === value
                    ? "flex-1 cursor-pointer rounded-md bg-background px-2 py-1 text-xs font-medium text-foreground shadow-xs"
                    : "flex-1 cursor-pointer rounded-md px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
                }
              >
                {value === "browser" ? "Browser" : "Access token"}
              </button>
            ))}
          </div>

          {mode === "browser" ? (
            login ? (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  Enter this code on the GitHub page that just opened:
                </p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 rounded-lg border border-border bg-muted/40 px-3 py-2 text-center font-mono text-xl tracking-[0.2em] text-foreground select-all">
                    {login.code}
                  </code>
                  <Button variant="outline" size="icon" aria-label="Copy code" onClick={copyCode}>
                    {copied ? <CheckIcon /> : <CopyIcon />}
                  </Button>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Spinner className="size-3" /> Waiting for GitHub…
                  </span>
                  <Button variant="ghost" size="sm" onClick={() => openExternalUrl(login.url)}>
                    <ExternalLinkIcon /> Open the page again
                  </Button>
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                You'll get a one-time code to enter at github.com. Works from any device paired
                with this machine.
              </p>
            )
          ) : (
            <div className="space-y-2">
              <Input
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder="ghp_… or github_pat_…"
                value={token}
                onChange={(event) => setToken(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && token.trim() && !savingToken) void submitToken();
                }}
              />
              <p className="text-xs text-muted-foreground">
                Needs the <code>repo</code> and <code>read:org</code> scopes.{" "}
                <button
                  type="button"
                  className="cursor-pointer text-foreground underline underline-offset-2"
                  onClick={() => openExternalUrl(TOKEN_URL)}
                >
                  Create one on GitHub
                </button>
              </p>
            </div>
          )}

          {error ? (
            <p className="rounded-md bg-destructive/8 px-3 py-2 text-xs text-destructive-foreground">
              {error}
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" onClick={() => close(false)}>
            Cancel
          </Button>
          {mode === "browser" ? (
            <Button disabled={starting || login !== null} onClick={() => void beginBrowser()}>
              {starting ? <Spinner className="size-3.5" /> : <LogInIcon />}
              {login ? "Waiting…" : "Sign in with browser"}
            </Button>
          ) : (
            <Button disabled={savingToken || !token.trim()} onClick={() => void submitToken()}>
              {savingToken ? <Spinner className="size-3.5" /> : <KeyRoundIcon />}
              Save token
            </Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
