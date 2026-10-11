import { WorkerPoolContext, useWorkerPool } from "@pierre/diffs/react";
import { getOrCreateWorkerPoolSingleton, terminateWorkerPoolSingleton } from "@pierre/diffs/worker";
import DiffsWorker from "@pierre/diffs/worker/worker.js?worker";
import * as Schema from "effect/Schema";
import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { useTheme } from "../hooks/useTheme";
import { resolveDiffThemeName, type DiffThemeName } from "../lib/diffRendering";
import { DiffPoolReadyContext, useDiffDemand } from "./diffWorkerDemand";

export class DiffWorkerError extends Schema.TaggedError<DiffWorkerError>()("DiffWorkerError", {
  operation: Schema.Literals(["create-worker", "get-render-options", "set-render-options"]),
  themeName: Schema.Literals(["pierre-light", "pierre-dark"]),
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Diff worker operation ${this.operation} failed for theme ${this.themeName}.`;
  }
}

function DiffWorkerThemeSync({ themeName }: { themeName: DiffThemeName }) {
  const workerPool = useWorkerPool();

  useEffect(() => {
    if (!workerPool) {
      return;
    }

    let operation: DiffWorkerError["operation"] = "get-render-options";
    void (async () => {
      try {
        const current = workerPool.getDiffRenderOptions();
        if (current.theme === themeName) {
          return;
        }

        operation = "set-render-options";
        await workerPool.setRenderOptions({
          ...current,
          theme: themeName,
        });
      } catch (cause) {
        console.error(new DiffWorkerError({ operation, themeName, cause }));
      }
    })();
  }, [themeName, workerPool]);

  return null;
}

export function DiffWorkerPoolProvider({ children }: { children?: ReactNode }) {
  const { resolvedTheme } = useTheme();
  const diffThemeName = resolveDiffThemeName(resolvedTheme);
  const wanted = useDiffDemand();
  // Two is plenty: diffs are opened one panel at a time, and each worker
  // carries its own copy of every grammar it has loaded.
  const workerPoolSize = useMemo(() => {
    const cores =
      typeof navigator === "undefined" ? 2 : Math.max(1, navigator.hardwareConcurrency || 2);
    return Math.max(1, Math.min(2, Math.floor(cores / 2)));
  }, []);
  const themeRef = useRef(diffThemeName);
  themeRef.current = diffThemeName;

  // The context is provided directly rather than through the library's
  // provider, which creates the pool on mount: here it exists only while
  // wanted, and the subtree never remounts when it comes or goes.
  const pool = useMemo(() => {
    if (!wanted || typeof window === "undefined") return undefined;
    return getOrCreateWorkerPoolSingleton({
      poolOptions: {
        workerFactory: () => {
          try {
            return new DiffsWorker();
          } catch (cause) {
            throw new DiffWorkerError({
              operation: "create-worker",
              themeName: themeRef.current,
              cause,
            });
          }
        },
        poolSize: workerPoolSize,
        totalASTLRUCacheSize: 240,
      },
      highlighterOptions: {
        theme: themeRef.current,
        tokenizeMaxLineLength: 1_000,
        useTokenTransformer: true,
      },
    });
  }, [wanted, workerPoolSize]);

  useEffect(() => {
    if (pool === undefined) return;
    return () => terminateWorkerPoolSingleton();
  }, [pool]);

  return (
    <DiffPoolReadyContext.Provider value={pool !== undefined}>
      <WorkerPoolContext.Provider value={pool}>
        <DiffWorkerThemeSync themeName={diffThemeName} />
        {children}
      </WorkerPoolContext.Provider>
    </DiffPoolReadyContext.Provider>
  );
}
