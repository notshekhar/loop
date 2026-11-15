import { type ScopedThreadRef } from "@loop/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@loop/runtime/state/runtime";
import type {
  SourceControlCloneProtocol,
  SourceControlPublishRepositoryResult,
  SourceControlRepositoryVisibility,
} from "@loop/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";
import { flushSync } from "react-dom";
import { useSourceControlPublishRepositoryAction } from "~/lib/sourceControlActions";
import { useEnvironmentQuery } from "~/state/query";
import { sourceControlEnvironment } from "~/state/sourceControl";
import {
  buildPublishAccountByProvider,
  buildPublishProviderReadiness,
  isCompleteRepositoryPath,
  PUBLISH_PROVIDER_OPTIONS,
  publishProviderOption,
  type PublishProviderKind,
  type PublishProviderOption,
  type PublishProviderReadiness,
  sortPublishProviderOptions,
} from "./publishProviders";

export interface PublishRepositoryDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: ScopedThreadRef["environmentId"] | null;
  readonly gitCwd: string;
}

export const PUBLISH_WIZARD_STEPS = ["Provider", "Repository", "Summary"] as const;

function usePublishProviderCatalog(environmentId: ScopedThreadRef["environmentId"] | null) {
  const sourceControlDiscovery = useEnvironmentQuery(
    environmentId === null
      ? null
      : sourceControlEnvironment.discovery({
          environmentId,
          input: {},
        }),
  );
  const publishAccountByProvider = useMemo(
    () => buildPublishAccountByProvider(sourceControlDiscovery.data?.sourceControlProviders ?? []),
    [sourceControlDiscovery.data],
  );
  const publishProviderReadiness = useMemo(
    () => buildPublishProviderReadiness(sourceControlDiscovery.data?.sourceControlProviders ?? []),
    [sourceControlDiscovery.data],
  );
  const hasReadyPublishProvider = useMemo(
    () => PUBLISH_PROVIDER_OPTIONS.some((option) => publishProviderReadiness[option.value].ready),
    [publishProviderReadiness],
  );
  const sortedPublishProviderOptions = useMemo(
    () => sortPublishProviderOptions(publishProviderReadiness),
    [publishProviderReadiness],
  );
  return {
    publishAccountByProvider,
    publishProviderReadiness,
    hasReadyPublishProvider,
    sortedPublishProviderOptions,
  };
}

function usePublishRepositoryFormState() {
  const [selectedPublishProvider, setSelectedPublishProvider] =
    useState<PublishProviderKind | null>(null);
  const [publishRepositoryOverride, setPublishRepositoryOverride] = useState<string | null>(null);
  const [publishVisibility, setPublishVisibility] =
    useState<SourceControlRepositoryVisibility>("private");
  const [publishRemoteName, setPublishRemoteName] = useState("origin");
  const [publishProtocol, setPublishProtocol] = useState<SourceControlCloneProtocol>("ssh");
  const [publishWizardStep, setPublishWizardStep] = useState(0);
  const [publishAdvancedOpen, setPublishAdvancedOpen] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [publishResult, setPublishResult] = useState<SourceControlPublishRepositoryResult | null>(
    null,
  );
  const resetState = useCallback(() => {
    setPublishRemoteName("origin");
    setPublishRepositoryOverride(null);
    setPublishWizardStep(0);
    setPublishAdvancedOpen(false);
    setPublishError(null);
    setPublishResult(null);
  }, []);
  return {
    selectedPublishProvider,
    setSelectedPublishProvider,
    publishRepositoryOverride,
    setPublishRepositoryOverride,
    publishVisibility,
    setPublishVisibility,
    publishRemoteName,
    setPublishRemoteName,
    publishProtocol,
    setPublishProtocol,
    publishWizardStep,
    setPublishWizardStep,
    publishAdvancedOpen,
    setPublishAdvancedOpen,
    publishError,
    setPublishError,
    publishResult,
    setPublishResult,
    resetState,
  };
}

export type PublishRepositoryFormState = ReturnType<typeof usePublishRepositoryFormState>;

/**
 * The provider actually used: the user's pick while it stays ready, otherwise the
 * first ready one, so a provider that lost auth never stays selected.
 */
function resolvePublishProvider(
  selectedPublishProvider: PublishProviderKind | null,
  publishProviderReadiness: Record<PublishProviderKind, PublishProviderReadiness>,
  sortedPublishProviderOptions: ReadonlyArray<PublishProviderOption>,
): PublishProviderKind {
  const firstReadyPublishProvider = sortedPublishProviderOptions.find(
    (option) => publishProviderReadiness[option.value].ready,
  )?.value;
  return selectedPublishProvider !== null && publishProviderReadiness[selectedPublishProvider].ready
    ? selectedPublishProvider
    : (firstReadyPublishProvider ?? selectedPublishProvider ?? "github");
}

interface PublishRepositorySubmitInput {
  readonly props: PublishRepositoryDialogProps;
  readonly form: PublishRepositoryFormState;
  readonly publishProvider: PublishProviderKind;
  readonly publishRepository: string;
  readonly selectedPublishProviderReadiness: PublishProviderReadiness;
  readonly publishRepositoryAction: ReturnType<typeof useSourceControlPublishRepositoryAction>;
}

function usePublishRepositorySubmit({
  props,
  form,
  publishProvider,
  publishRepository,
  selectedPublishProviderReadiness,
  publishRepositoryAction,
}: PublishRepositorySubmitInput) {
  const { publishVisibility, publishRemoteName, publishProtocol } = form;
  const { setPublishError, setPublishResult, setPublishWizardStep } = form;
  const canSubmitPublishRepository = useMemo(() => {
    if (!selectedPublishProviderReadiness.ready) return false;
    if (publishRepositoryAction.isPending) return false;
    return isCompleteRepositoryPath(publishRepository);
  }, [publishRepository, publishRepositoryAction.isPending, selectedPublishProviderReadiness]);

  const submitPublishRepository = useCallback(() => {
    if (!canSubmitPublishRepository) {
      return;
    }

    setPublishError(null);

    void (async () => {
      const result = await publishRepositoryAction.run({
        provider: publishProvider,
        repository: publishRepository.trim(),
        visibility: publishVisibility,
        remoteName: publishRemoteName.trim() || "origin",
        protocol: publishProtocol,
      });

      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          setPublishError(error instanceof Error ? error.message : "An error occurred.");
        }
        return;
      }

      flushSync(() => {
        setPublishResult(result.value);
        setPublishWizardStep(2);
      });
    })();
  }, [
    canSubmitPublishRepository,
    props.environmentId,
    props.gitCwd,
    publishProtocol,
    publishProvider,
    publishRemoteName,
    publishRepository,
    publishRepositoryAction,
    publishVisibility,
  ]);
  return { canSubmitPublishRepository, submitPublishRepository };
}

function usePublishDialogClosing(props: PublishRepositoryDialogProps, resetState: () => void) {
  const navigate = useNavigate();
  const handleOpenChange = useCallback(
    (open: boolean) => {
      props.onOpenChange(open);
      if (!open) {
        resetState();
      }
    },
    [props, resetState],
  );

  const openSourceControlSettings = useCallback(() => {
    handleOpenChange(false);
    void navigate({ to: "/settings/source-control" });
  }, [handleOpenChange, navigate]);
  return { handleOpenChange, openSourceControlSettings };
}

export function usePublishRepositoryWizard(props: PublishRepositoryDialogProps) {
  const catalog = usePublishProviderCatalog(props.environmentId);
  const form = usePublishRepositoryFormState();
  const sourceControlScope = useMemo(
    () => ({
      environmentId: props.environmentId,
      cwd: props.gitCwd,
    }),
    [props.environmentId, props.gitCwd],
  );
  const publishRepositoryAction = useSourceControlPublishRepositoryAction(sourceControlScope);
  const publishProvider = resolvePublishProvider(
    form.selectedPublishProvider,
    catalog.publishProviderReadiness,
    catalog.sortedPublishProviderOptions,
  );
  const selectedPublishProviderReadiness = catalog.publishProviderReadiness[publishProvider];
  const publishRepositoryPrefill = catalog.publishAccountByProvider[publishProvider]
    ? `${catalog.publishAccountByProvider[publishProvider]}/`
    : "";
  const publishRepository = form.publishRepositoryOverride ?? publishRepositoryPrefill;
  const currentPublishProvider = publishProviderOption(publishProvider);
  const { canSubmitPublishRepository, submitPublishRepository } = usePublishRepositorySubmit({
    props,
    form,
    publishProvider,
    publishRepository,
    selectedPublishProviderReadiness,
    publishRepositoryAction,
  });
  const { handleOpenChange, openSourceControlSettings } = usePublishDialogClosing(
    props,
    form.resetState,
  );
  return {
    ...catalog,
    form,
    publishRepositoryAction,
    publishProvider,
    selectedPublishProviderReadiness,
    publishRepository,
    currentPublishProvider,
    canSubmitPublishRepository,
    submitPublishRepository,
    handleOpenChange,
    openSourceControlSettings,
  };
}

export type PublishRepositoryWizard = ReturnType<typeof usePublishRepositoryWizard>;
