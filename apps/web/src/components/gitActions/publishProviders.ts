import type {
  SourceControlProviderDiscoveryItem,
  SourceControlProviderKind,
} from "@loop/contracts";
import * as Option from "effect/Option";
import { AzureDevOpsIcon, BitbucketIcon, GitHubIcon, GitLabIcon } from "~/components/Icons";

export type PublishProviderKind = Extract<
  SourceControlProviderKind,
  "github" | "gitlab" | "bitbucket" | "azure-devops"
>;

export interface PublishProviderReadiness {
  readonly ready: boolean;
  readonly hint: string | null;
}

export const PUBLISH_PROVIDER_OPTIONS = [
  {
    value: "github",
    label: "GitHub",
    description: "github.com",
    host: "github.com",
    pathPlaceholder: "owner/repo",
    Icon: GitHubIcon,
  },
  {
    value: "gitlab",
    label: "GitLab",
    description: "gitlab.com",
    host: "gitlab.com",
    pathPlaceholder: "group/project",
    Icon: GitLabIcon,
  },
  {
    value: "bitbucket",
    label: "Bitbucket",
    description: "bitbucket.org",
    host: "bitbucket.org",
    pathPlaceholder: "workspace/repository",
    Icon: BitbucketIcon,
  },
  {
    value: "azure-devops",
    label: "Azure DevOps",
    description: "dev.azure.com",
    host: "dev.azure.com",
    pathPlaceholder: "project/repository",
    Icon: AzureDevOpsIcon,
  },
] as const satisfies ReadonlyArray<{
  readonly value: PublishProviderKind;
  readonly label: string;
  readonly description: string;
  readonly host: string;
  readonly pathPlaceholder: string;
  readonly Icon: typeof GitHubIcon;
}>;

export type PublishProviderOption = (typeof PUBLISH_PROVIDER_OPTIONS)[number];

export function publishProviderOption(provider: PublishProviderKind) {
  return (
    PUBLISH_PROVIDER_OPTIONS.find((option) => option.value === provider) ??
    PUBLISH_PROVIDER_OPTIONS[0]
  );
}

function isPublishProviderKind(
  provider: SourceControlProviderKind,
): provider is PublishProviderKind {
  return PUBLISH_PROVIDER_OPTIONS.some((option) => option.value === provider);
}

function getPublishProviderReadiness(input: {
  provider: PublishProviderKind;
  sourceControlProviders: ReadonlyArray<SourceControlProviderDiscoveryItem>;
}): PublishProviderReadiness {
  const discovered = input.sourceControlProviders.find(
    (provider) => provider.kind === input.provider,
  );
  if (!discovered) {
    return {
      ready: false,
      hint: "Provider status unavailable. Open Settings -> Source Control and rescan.",
    };
  }
  if (discovered.status !== "available") {
    return { ready: false, hint: discovered.installHint };
  }
  if (discovered.auth.status === "unauthenticated") {
    return {
      ready: false,
      hint:
        Option.getOrNull(discovered.auth.detail) ??
        `${discovered.label} is not authenticated. Open Settings -> Source Control for setup guidance.`,
    };
  }
  return { ready: true, hint: null };
}

export function buildPublishAccountByProvider(
  sourceControlProviders: ReadonlyArray<SourceControlProviderDiscoveryItem>,
): Record<PublishProviderKind, string | null> {
  const accounts: Record<PublishProviderKind, string | null> = {
    github: null,
    gitlab: null,
    bitbucket: null,
    "azure-devops": null,
  };
  for (const provider of sourceControlProviders) {
    if (isPublishProviderKind(provider.kind)) {
      accounts[provider.kind] = Option.getOrNull(provider.auth.account);
    }
  }
  return accounts;
}

export function buildPublishProviderReadiness(
  sourceControlProviders: ReadonlyArray<SourceControlProviderDiscoveryItem>,
): Record<PublishProviderKind, PublishProviderReadiness> {
  return Object.fromEntries(
    PUBLISH_PROVIDER_OPTIONS.map((option) => [
      option.value,
      getPublishProviderReadiness({
        provider: option.value,
        sourceControlProviders,
      }),
    ]),
  ) as Record<PublishProviderKind, PublishProviderReadiness>;
}

/** Ready providers first, then alphabetical. */
export function sortPublishProviderOptions(
  readiness: Record<PublishProviderKind, PublishProviderReadiness>,
) {
  return PUBLISH_PROVIDER_OPTIONS.toSorted((left, right) => {
    const leftReady = readiness[left.value].ready;
    const rightReady = readiness[right.value].ready;
    if (leftReady !== rightReady) {
      return leftReady ? -1 : 1;
    }
    return left.label.localeCompare(right.label);
  });
}

/** A repository path needs both an owner and a name: `owner/name`. */
export function isCompleteRepositoryPath(repository: string): boolean {
  const repositoryParts = repository.trim().split("/");
  const owner = repositoryParts[0]?.trim() ?? "";
  const rest = repositoryParts.slice(1);
  const name = rest.join("/").trim();
  return owner.length > 0 && name.length > 0;
}
