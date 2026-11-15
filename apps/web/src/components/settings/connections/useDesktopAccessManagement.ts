import type { AuthClientSession, AuthPairingLink, EnvironmentId } from "@loop/contracts";
import { useCallback, useMemo, useState } from "react";

import {
  revokeOtherServerClientSessions,
  revokeServerClientSession,
  revokeServerPairingLink,
  type ServerClientSessionRecord,
} from "~/environments/primary";
import { authEnvironment } from "~/state/auth";
import { useEnvironmentQuery } from "~/state/query";
import { toastManager } from "../../ui/toast";
import {
  sortDesktopClientSessions,
  sortDesktopPairingLinks,
  toDesktopClientSessionRecord,
  toDesktopPairingLinkRecord,
} from "./accessRecords";
import { errorMessage, showErrorToast } from "./connectionToasts";

type SetError = (message: string | null) => void;

function reportRevokeFailure(
  setMutationError: SetError,
  title: string,
  error: unknown,
  fallback: string,
) {
  const message = errorMessage(error, fallback);
  setMutationError(message);
  showErrorToast(title, message);
}

function useAccessRevocations(setMutationError: SetError) {
  const [revokingPairingLinkId, setRevokingPairingLinkId] = useState<string | null>(null);
  const [revokingClientSessionId, setRevokingClientSessionId] = useState<string | null>(null);

  const handleRevokePairingLink = useCallback(
    async (id: string) => {
      setRevokingPairingLinkId(id);
      setMutationError(null);
      try {
        await revokeServerPairingLink(id);
      } catch (error) {
        reportRevokeFailure(
          setMutationError,
          "Could not revoke pairing link",
          error,
          "Failed to revoke pairing link.",
        );
      } finally {
        setRevokingPairingLinkId(null);
      }
    },
    [setMutationError],
  );

  const handleRevokeClientSession = useCallback(
    async (sessionId: ServerClientSessionRecord["sessionId"]) => {
      setRevokingClientSessionId(sessionId);
      setMutationError(null);
      try {
        await revokeServerClientSession(sessionId);
      } catch (error) {
        reportRevokeFailure(
          setMutationError,
          "Could not revoke client access",
          error,
          "Failed to revoke client access.",
        );
      } finally {
        setRevokingClientSessionId(null);
      }
    },
    [setMutationError],
  );

  return {
    revokingPairingLinkId,
    revokingClientSessionId,
    handleRevokePairingLink,
    handleRevokeClientSession,
  };
}

function useRevokeOtherClients(setMutationError: SetError) {
  const [isRevokingOtherClients, setIsRevokingOtherClients] = useState(false);

  const handleRevokeOtherClients = useCallback(async () => {
    setIsRevokingOtherClients(true);
    setMutationError(null);
    try {
      const revokedCount = await revokeOtherServerClientSessions();
      toastManager.add({
        type: "success",
        title: revokedCount === 1 ? "Revoked 1 other client" : `Revoked ${revokedCount} clients`,
        description: "Other paired clients will need a new pairing link before reconnecting.",
      });
    } catch (error) {
      reportRevokeFailure(
        setMutationError,
        "Could not revoke other clients",
        error,
        "Failed to revoke other clients.",
      );
    } finally {
      setIsRevokingOtherClients(false);
    }
  }, [setMutationError]);

  return { isRevokingOtherClients, handleRevokeOtherClients };
}

/** Pairing links and client sessions of this backend, with the revoke actions. */
export function useDesktopAccessManagement(input: {
  readonly canManageLocalBackend: boolean;
  readonly primaryEnvironmentId: EnvironmentId | null;
}) {
  const { canManageLocalBackend, primaryEnvironmentId } = input;
  const [mutationError, setMutationError] = useState<string | null>(null);
  const authAccessChanges = useEnvironmentQuery(
    canManageLocalBackend && primaryEnvironmentId !== null
      ? authEnvironment.accessChanges({
          environmentId: primaryEnvironmentId,
          input: null,
        })
      : null,
  );
  const pairingLinks = useMemo(() => {
    const event = authAccessChanges.data;
    if (event?.type !== "snapshot") return [];
    return sortDesktopPairingLinks(
      event.payload.pairingLinks.map((pairingLink: AuthPairingLink) =>
        toDesktopPairingLinkRecord(pairingLink),
      ),
    );
  }, [authAccessChanges.data]);
  const clientSessions = useMemo(() => {
    const event = authAccessChanges.data;
    if (event?.type !== "snapshot") return [];
    return sortDesktopClientSessions(
      event.payload.clientSessions.map((clientSession: AuthClientSession) =>
        toDesktopClientSessionRecord(clientSession),
      ),
    );
  }, [authAccessChanges.data]);
  const revocations = useAccessRevocations(setMutationError);
  const revokeOthers = useRevokeOtherClients(setMutationError);
  return {
    error: mutationError ?? authAccessChanges.error,
    isLoading: authAccessChanges.isPending && authAccessChanges.data === null,
    pairingLinks,
    clientSessions,
    ...revocations,
    ...revokeOthers,
  };
}

export type DesktopAccessManagement = ReturnType<typeof useDesktopAccessManagement>;
