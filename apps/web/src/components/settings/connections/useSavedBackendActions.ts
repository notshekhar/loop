import type { EnvironmentId } from "@loop/contracts";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@loop/runtime/state/runtime";
import { useCallback, useState } from "react";

import { environmentCatalog } from "~/connection/catalog";
import { useAtomCommand } from "../../../state/use-atom-command";
import { errorMessage, showErrorToast } from "./connectionToasts";

type SetError = (message: string | null) => void;

function reportCommandFailure<A, E>(
  result: AtomCommandResult<A, E>,
  setError: SetError,
  title: string,
  fallback: string,
) {
  if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
    const message = errorMessage(squashAtomCommandFailure(result), fallback);
    setError(message);
    showErrorToast(title, message);
  }
}

/** Connect / disconnect / remove for rows of already-saved environments. */
export function useSavedBackendActions(setSavedBackendError: SetError) {
  const removeEnvironment = useAtomCommand(environmentCatalog.remove, { reportFailure: false });
  const retryEnvironment = useAtomCommand(environmentCatalog.retryNow, { reportFailure: false });
  const [removingEnvironmentId, setRemovingEnvironmentId] = useState<EnvironmentId | null>(null);

  const handleConnect = useCallback(
    async (environmentId: EnvironmentId) => {
      setSavedBackendError(null);
      const result = await retryEnvironment(environmentId);
      reportCommandFailure(
        result,
        setSavedBackendError,
        "Could not connect backend",
        "Failed to connect backend.",
      );
    },
    [retryEnvironment],
  );

  const handleRemove = useCallback(
    async (environmentId: EnvironmentId) => {
      setRemovingEnvironmentId(environmentId);
      setSavedBackendError(null);
      const result = await removeEnvironment(environmentId);
      setRemovingEnvironmentId(null);
      reportCommandFailure(
        result,
        setSavedBackendError,
        "Could not remove backend",
        "Failed to remove backend.",
      );
    },
    [removeEnvironment],
  );

  return { removingEnvironmentId, handleConnect, handleRemove };
}
