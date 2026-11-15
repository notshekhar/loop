import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import type {
  SourceControlCloneProtocol,
  SourceControlRepositoryVisibility,
} from "@loop/contracts";
import { ChevronDownIcon, GlobeIcon, LockIcon } from "lucide-react";
import { Input } from "~/components/ui/input";
import { RadioGroup } from "~/components/ui/radio-group";
import { Spinner } from "~/components/ui/spinner";
import { cn } from "~/lib/utils";
import type { PublishRepositoryWizard } from "./usePublishRepositoryWizard";

const VISIBILITY_OPTIONS = [
  {
    value: "private" as const,
    label: "Private",
    description: "Only invited people",
    Icon: LockIcon,
  },
  {
    value: "public" as const,
    label: "Public",
    description: "Anyone on the web",
    Icon: GlobeIcon,
  },
];

export function PublishRepositoryStep({ wizard }: { wizard: PublishRepositoryWizard }) {
  const { form, publishRepositoryAction } = wizard;
  const isPending = publishRepositoryAction.isPending;
  return (
    <div className={cn("space-y-5", form.publishWizardStep !== 1 && "hidden")}>
      <RepositoryPathField wizard={wizard} />
      <VisibilityField
        value={form.publishVisibility}
        onChange={form.setPublishVisibility}
        disabled={isPending}
      />
      <AdvancedOptions form={form} disabled={isPending} />

      {isPending ? (
        <div
          role="status"
          aria-live="polite"
          className="flex items-center gap-2 rounded-md border border-input bg-muted/40 px-3 py-2 text-xs text-muted-foreground dark:border-transparent dark:bg-white/[0.035]"
        >
          <Spinner className="size-3.5" aria-hidden />
          Publishing repository to {wizard.currentPublishProvider.label}...
        </div>
      ) : null}
      {form.publishError && !isPending ? (
        <div
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          <p className="font-medium">Publish failed</p>
          <p className="mt-0.5 text-destructive/90">{form.publishError}</p>
        </div>
      ) : null}
    </div>
  );
}

function RepositoryPathField({ wizard }: { wizard: PublishRepositoryWizard }) {
  const { currentPublishProvider } = wizard;
  return (
    <div className="space-y-2">
      <label htmlFor="publish-repository-path" className="text-xs font-medium text-foreground">
        Repository
      </label>
      <div className="flex items-stretch overflow-hidden rounded-md border border-input bg-background focus-within:outline-2 focus-within:-outline-offset-1 focus-within:outline-ring">
        <span className="flex shrink-0 items-center gap-1.5 border-r border-input bg-muted/50 px-2.5 font-mono text-xs text-muted-foreground">
          <currentPublishProvider.Icon className="size-3.5" />
          {currentPublishProvider.host}/
        </span>
        <input
          id="publish-repository-path"
          name="publish-repository-path"
          value={wizard.publishRepository}
          onChange={(event) => {
            wizard.form.setPublishRepositoryOverride(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              wizard.submitPublishRepository();
            }
          }}
          placeholder={currentPublishProvider.pathPlaceholder}
          disabled={wizard.publishRepositoryAction.isPending}
          className="w-full bg-transparent px-3 py-2 font-mono text-sm placeholder:text-muted-foreground/60 focus:outline-none"
        />
      </div>
    </div>
  );
}

function VisibilityField({
  value,
  onChange,
  disabled,
}: {
  value: SourceControlRepositoryVisibility;
  onChange: (value: SourceControlRepositoryVisibility) => void;
  disabled: boolean;
}) {
  return (
    <div className="space-y-2">
      <span id="publish-visibility-cards-label" className="text-xs font-medium text-foreground">
        Visibility
      </span>
      <RadioGroup
        value={value}
        onValueChange={(next) => onChange(next as SourceControlRepositoryVisibility)}
        aria-labelledby="publish-visibility-cards-label"
        disabled={disabled}
        className="grid grid-cols-2 gap-2.5"
      >
        {VISIBILITY_OPTIONS.map((option) => {
          const isSelected = value === option.value;
          return (
            <RadioPrimitive.Root
              key={option.value}
              value={option.value}
              className={cn(
                "relative flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 text-left outline-none transition-[background-color,border-color,box-shadow]",
                "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
                isSelected
                  ? "border-primary bg-background shadow-sm ring-2 ring-primary/35 dark:border-transparent dark:bg-primary/10 dark:shadow-none dark:ring-1 dark:ring-primary/30"
                  : "border-border bg-background hover:border-foreground/20 hover:bg-muted/50 dark:border-transparent dark:bg-white/[0.035] dark:hover:bg-accent",
              )}
            >
              <option.Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-foreground">{option.label}</span>
                <span className="block text-xs text-muted-foreground">{option.description}</span>
              </span>
            </RadioPrimitive.Root>
          );
        })}
      </RadioGroup>
    </div>
  );
}

function AdvancedOptions({
  form,
  disabled,
}: {
  form: PublishRepositoryWizard["form"];
  disabled: boolean;
}) {
  const { publishAdvancedOpen } = form;
  return (
    <div>
      <button
        type="button"
        onClick={() => form.setPublishAdvancedOpen((prev) => !prev)}
        aria-expanded={publishAdvancedOpen}
        className="flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronDownIcon
          className={cn("size-3.5 transition-transform", publishAdvancedOpen ? "" : "-rotate-90")}
        />
        Advanced
      </button>
      {publishAdvancedOpen ? (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="space-y-1.5" htmlFor="publish-remote-name">
            <span className="text-xs font-medium text-foreground">Remote</span>
            <Input
              id="publish-remote-name"
              value={form.publishRemoteName}
              onChange={(event) => form.setPublishRemoteName(event.target.value)}
              placeholder="origin"
              disabled={disabled}
            />
          </label>
          <ProtocolField
            value={form.publishProtocol}
            onChange={form.setPublishProtocol}
            disabled={disabled}
          />
        </div>
      ) : null}
    </div>
  );
}

function ProtocolField({
  value,
  onChange,
  disabled,
}: {
  value: SourceControlCloneProtocol;
  onChange: (value: SourceControlCloneProtocol) => void;
  disabled: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <span id="publish-protocol-label" className="text-xs font-medium text-foreground">
        Protocol
      </span>
      <RadioGroup
        value={value}
        onValueChange={(next) => onChange(next as SourceControlCloneProtocol)}
        aria-labelledby="publish-protocol-label"
        disabled={disabled}
        className="grid grid-cols-2 gap-2"
      >
        {(["ssh", "https"] as const).map((option) => {
          const isSelected = value === option;
          return (
            <RadioPrimitive.Root
              key={option}
              value={option}
              className={cn(
                "rounded-md border px-3 py-1.5 text-center text-sm font-medium outline-none transition",
                "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
                isSelected
                  ? "border-primary bg-background ring-2 ring-primary/35 text-foreground dark:border-transparent dark:bg-primary/10 dark:ring-1 dark:ring-primary/30"
                  : "border-border bg-background text-muted-foreground hover:border-foreground/20 hover:text-foreground dark:border-transparent dark:bg-white/[0.035]",
              )}
            >
              {option === "ssh" ? "SSH" : "HTTPS"}
            </RadioPrimitive.Root>
          );
        })}
      </RadioGroup>
    </div>
  );
}
