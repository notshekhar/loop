import { RefreshCwIcon, SearchIcon } from "lucide-react";
import type { ComponentProps } from "react";

import { Switch } from "../ui/switch";
import { ComboboxEmpty, ComboboxInput, ComboboxPopup, ComboboxStatus } from "../ui/combobox";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { BranchPickerList } from "./BranchPickerList";

function BranchSearchInput({
  branchQuery,
  setBranchQuery,
}: {
  branchQuery: string;
  setBranchQuery: (query: string) => void;
}) {
  return (
    <div className="shrink-0 px-3 pt-2.5">
      <div className="relative -translate-y-px border-b border-border/70 pb-1.5 transition-colors focus-within:border-ring">
        <SearchIcon
          aria-hidden="true"
          className="pointer-events-none absolute top-1.5 left-0 size-4 shrink-0 text-muted-foreground/55"
        />
        <ComboboxInput
          className="[&_input]:h-6.5 [&_input]:ps-5 [&_input]:font-sans [&_input]:leading-6.5"
          inputClassName="rounded-none bg-transparent text-sm"
          placeholder="Search refs..."
          showTrigger={false}
          size="sm"
          unstyled
          value={branchQuery}
          onChange={(event) => setBranchQuery(event.target.value)}
        />
      </div>
    </div>
  );
}

interface StartFromOriginToggleProps {
  switchId: string;
  startFromOrigin: boolean;
  onStartFromOriginChange: (startFromOrigin: boolean) => void;
}

function StartFromOriginToggle({
  switchId,
  startFromOrigin,
  onStartFromOriginChange,
}: StartFromOriginToggleProps) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <label
            htmlFor={switchId}
            className="flex cursor-pointer items-center justify-between gap-3 border-t border-border/60 px-3 py-2 text-xs"
          >
            <span className="flex min-w-0 items-center gap-1.5 font-medium text-muted-foreground">
              <RefreshCwIcon aria-hidden="true" className="size-3 shrink-0 opacity-70" />
              <span className="truncate">Start from origin</span>
            </span>
            <Switch
              id={switchId}
              checked={startFromOrigin}
              className="[--thumb-size:--spacing(3.5)]"
              aria-label="Start worktree from origin"
              onCheckedChange={(checked) => onStartFromOriginChange(Boolean(checked))}
            />
          </label>
        }
      />
      <TooltipPopup side="top" className="max-w-72 whitespace-normal leading-tight">
        Creates the worktree from the latest matching branch on origin instead of your local
        branch.
      </TooltipPopup>
    </Tooltip>
  );
}

interface BranchPickerPopupProps {
  branchQuery: string;
  setBranchQuery: (query: string) => void;
  list: ComponentProps<typeof BranchPickerList>;
  startFromOriginToggle: StartFromOriginToggleProps | null;
  branchStatusText: string | null;
}

/** Search box, ref list, the worktree-base "start from origin" switch and paging status. */
export function BranchPickerPopup({
  branchQuery,
  setBranchQuery,
  list,
  startFromOriginToggle,
  branchStatusText,
}: BranchPickerPopupProps) {
  return (
    <ComboboxPopup align="end" side="top" className="flex w-80 flex-col">
      <BranchSearchInput branchQuery={branchQuery} setBranchQuery={setBranchQuery} />
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <ComboboxEmpty>No refs found.</ComboboxEmpty>
        <BranchPickerList {...list} />
        {startFromOriginToggle ? <StartFromOriginToggle {...startFromOriginToggle} /> : null}
        {branchStatusText ? <ComboboxStatus>{branchStatusText}</ComboboxStatus> : null}
      </div>
    </ComboboxPopup>
  );
}
