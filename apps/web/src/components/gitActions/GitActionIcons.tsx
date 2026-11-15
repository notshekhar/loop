import { CloudUploadIcon, GitCommitIcon, InfoIcon } from "lucide-react";
import type { GitActionIconName, GitQuickAction } from "~/components/GitActionsControl.logic";
import type { getSourceControlPresentation } from "~/sourceControlPresentation";

export type SourceControlIconComponent = ReturnType<typeof getSourceControlPresentation>["Icon"];

export function GitActionItemIcon({
  icon,
  SourceControlIcon,
}: {
  icon: GitActionIconName;
  SourceControlIcon: SourceControlIconComponent;
}) {
  if (icon === "commit") return <GitCommitIcon />;
  if (icon === "push") return <CloudUploadIcon />;
  return <SourceControlIcon />;
}

export function GitQuickActionIcon({
  quickAction,
  SourceControlIcon,
}: {
  quickAction: GitQuickAction;
  SourceControlIcon: SourceControlIconComponent;
}) {
  const iconClassName = "size-3.5";
  if (quickAction.kind === "open_pr") return <SourceControlIcon className={iconClassName} />;
  if (quickAction.kind === "open_publish") return <CloudUploadIcon className={iconClassName} />;
  if (quickAction.kind === "run_pull") return <InfoIcon className={iconClassName} />;
  if (quickAction.kind === "run_action") {
    if (quickAction.action === "commit") return <GitCommitIcon className={iconClassName} />;
    if (quickAction.action === "push" || quickAction.action === "commit_push") {
      return <CloudUploadIcon className={iconClassName} />;
    }
    return <SourceControlIcon className={iconClassName} />;
  }
  if (quickAction.label === "Commit") return <GitCommitIcon className={iconClassName} />;
  return <InfoIcon className={iconClassName} />;
}
