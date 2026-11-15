import type { SourceControlPublishRepositoryResult } from "@loop/contracts";
import { CheckIcon, ExternalLinkIcon } from "lucide-react";
import { AnimatedHeight } from "~/components/AnimatedHeight";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Spinner } from "~/components/ui/spinner";
import { readLocalApi } from "~/localApi";
import { cn } from "~/lib/utils";
import { PublishProviderStep } from "./PublishProviderStep";
import { PublishRepositoryStep } from "./PublishRepositoryStep";
import type { PublishProviderOption } from "./publishProviders";
import {
  PUBLISH_WIZARD_STEPS,
  type PublishRepositoryDialogProps,
  type PublishRepositoryWizard,
  usePublishRepositoryWizard,
} from "./usePublishRepositoryWizard";

export function PublishRepositoryDialog(props: PublishRepositoryDialogProps) {
  const wizard = usePublishRepositoryWizard(props);
  const { form, currentPublishProvider } = wizard;
  const publishWizardStepSummaries = [
    currentPublishProvider.label,
    form.publishResult?.repository.nameWithOwner ?? null,
    null,
  ] as const;

  return (
    <Dialog open={props.open} onOpenChange={wizard.handleOpenChange}>
      <DialogPopup className="max-w-xl overflow-hidden">
        <div className="flex min-h-0 flex-col overflow-hidden border-foreground/10 bg-transparent">
          <DialogHeader className="border-b border-border/70 bg-foreground/[0.025] dark:border-transparent dark:bg-transparent">
            <DialogTitle>Publish repository</DialogTitle>
            <DialogDescription>
              Pick where to host it, then point us at a repo to push to.
            </DialogDescription>
            <PublishWizardStepper
              step={form.publishWizardStep}
              summaries={publishWizardStepSummaries}
              onStepChange={form.setPublishWizardStep}
            />
          </DialogHeader>

          <DialogPanel className="space-y-5 border-b border-border/70 bg-muted/20 px-6 py-5 dark:border-transparent dark:bg-transparent">
            <AnimatedHeight>
              <PublishProviderStep wizard={wizard} />
              <PublishRepositoryStep wizard={wizard} />
              <PublishResultStep
                hidden={form.publishWizardStep !== 2}
                publishResult={form.publishResult}
                provider={currentPublishProvider}
              />
            </AnimatedHeight>
          </DialogPanel>

          <PublishWizardFooter wizard={wizard} />
        </div>
      </DialogPopup>
    </Dialog>
  );
}

function PublishWizardStepper({
  step,
  summaries,
  onStepChange,
}: {
  step: number;
  summaries: readonly (string | null)[];
  onStepChange: (step: number) => void;
}) {
  return (
    <div className="grid grid-cols-3 gap-2">
      {PUBLISH_WIZARD_STEPS.map((label, index) => {
        const isComplete = index < step;
        const isClickable =
          step !== 2 && index < PUBLISH_WIZARD_STEPS.length - 1 && index <= step;
        return (
          <button
            key={label}
            type="button"
            onClick={isClickable ? () => onStepChange(index) : undefined}
            disabled={!isClickable}
            className={cn(
              "grid min-w-0 grid-cols-[1rem_minmax(0,1fr)] gap-x-2 rounded-lg border px-3 py-2 text-left",
              index === step
                ? "border-primary bg-primary/10 ring-1 ring-primary/25 dark:border-transparent"
                : isComplete
                  ? "border-border bg-background dark:border-transparent dark:bg-white/[0.05]"
                  : "border-border bg-muted/40 dark:border-transparent dark:bg-white/[0.025]",
              !isClickable && "cursor-default",
            )}
          >
            <span
              aria-hidden
              className={cn(
                "row-span-2 mt-0.5 grid size-4 place-items-center rounded-full border",
                isComplete
                  ? "border-primary bg-primary text-primary-foreground"
                  : index === step
                    ? "border-primary bg-background"
                    : "border-muted-foreground/35 bg-background",
              )}
            >
              {isComplete ? <CheckIcon className="size-3" /> : null}
            </span>
            <span className="text-[10px] font-medium uppercase text-muted-foreground">
              Step {index + 1}
            </span>
            <span className="truncate text-xs font-semibold text-foreground">
              {label}
              {isComplete && summaries[index] ? `: ${summaries[index]}` : ""}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function PublishResultStep({
  hidden,
  publishResult,
  provider,
}: {
  hidden: boolean;
  publishResult: SourceControlPublishRepositoryResult | null;
  provider: PublishProviderOption;
}) {
  return (
    <div className={cn("space-y-4", hidden && "hidden")}>
      {publishResult ? (
        <>
          <div className="flex flex-col items-center gap-2 py-1 text-center">
            <span className="grid size-8 place-items-center rounded-full bg-success/15 text-success">
              <CheckIcon className="size-4" aria-hidden />
            </span>
            <h3 className="text-sm font-semibold text-foreground">
              {publishResult.status === "pushed" ? "Repository published" : "Repository created"}
            </h3>
            <p className="max-w-xs text-pretty text-xs text-muted-foreground">
              {publishResult.status === "pushed"
                ? `${publishResult.branch} is now live on ${provider.label}.`
                : `Remote "${publishResult.remoteName}" is set up. Make a commit and push it to share your code.`}
            </p>
          </div>
          <div className="flex items-center gap-2 rounded-lg border border-input bg-muted/40 px-3 py-2 dark:border-transparent dark:bg-white/[0.035]">
            <provider.Icon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
              {publishResult.repository.nameWithOwner}
            </span>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            onClick={() => {
              const api = readLocalApi();
              if (!api) return;
              void api.shell.openExternal(publishResult.repository.url);
            }}
          >
            <ExternalLinkIcon className="size-3.5" aria-hidden />
            Open on {provider.label}
          </Button>
        </>
      ) : (
        <div className="rounded-md border border-input bg-background px-3 py-2 text-xs text-muted-foreground dark:border-transparent dark:bg-white/[0.035]">
          Publish result unavailable.
        </div>
      )}
    </div>
  );
}

function PublishWizardFooter({ wizard }: { wizard: PublishRepositoryWizard }) {
  const { form, publishRepositoryAction, handleOpenChange } = wizard;
  const step = form.publishWizardStep;
  return (
    <DialogFooter className="dark:border-transparent dark:bg-transparent">
      {step === 2 ? (
        <Button size="sm" onClick={() => handleOpenChange(false)}>
          Done
        </Button>
      ) : (
        <>
          <Button
            variant="outline"
            size="sm"
            disabled={publishRepositoryAction.isPending}
            onClick={() => {
              if (step === 0) {
                handleOpenChange(false);
                return;
              }
              form.setPublishWizardStep((current) => Math.max(0, current - 1));
            }}
          >
            {step === 0 ? "Cancel" : "Back"}
          </Button>
          {step < 1 ? (
            <Button
              size="sm"
              disabled={
                !wizard.hasReadyPublishProvider || !wizard.selectedPublishProviderReadiness.ready
              }
              onClick={() => form.setPublishWizardStep((current) => Math.min(1, current + 1))}
            >
              Next
            </Button>
          ) : (
            <Button
              size="sm"
              disabled={!wizard.canSubmitPublishRepository}
              onClick={wizard.submitPublishRepository}
            >
              {publishRepositoryAction.isPending ? (
                <>
                  <Spinner className="size-3.5" aria-hidden />
                  Publishing...
                </>
              ) : (
                "Publish"
              )}
            </Button>
          )}
        </>
      )}
    </DialogFooter>
  );
}
