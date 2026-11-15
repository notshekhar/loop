import type { RefObject } from "react";
import { SearchIcon } from "lucide-react";
import { ComboboxInput } from "../../ui/combobox";

export function ModelPickerSearchInput(props: {
  searchInputRef: RefObject<HTMLInputElement | null>;
  highlightedModelKeyRef: RefObject<string | null>;
  searchQuery: string;
  onSearchQueryChange: (query: string) => void;
  onRequestClose: (() => void) | undefined;
  onActivateItem: (modelKey: string) => void;
}) {
  const { highlightedModelKeyRef } = props;
  return (
    <div className="px-2 pt-2">
      <div className="border-b border-border/70 pb-2.5 transition-colors focus-within:border-ring">
        <ComboboxInput
          ref={props.searchInputRef}
          className="[&_input]:h-6.5 [&_input]:font-sans [&_input]:leading-6.5"
          inputClassName="rounded-none bg-transparent text-sm"
          placeholder="Search models..."
          showTrigger={false}
          startAddon={
            <SearchIcon className="-translate-x-0.5 size-4 shrink-0 text-muted-foreground opacity-70" />
          }
          value={props.searchQuery}
          onChange={(e) => props.onSearchQueryChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              props.onRequestClose?.();
              return;
            }
            if (e.key === "Enter" && highlightedModelKeyRef.current) {
              (e as typeof e & { preventBaseUIHandler?: () => void }).preventBaseUIHandler?.();
              e.preventDefault();
              e.stopPropagation();
              props.onActivateItem(highlightedModelKeyRef.current);
              return;
            }
            e.stopPropagation();
          }}
          onMouseDown={(e) => e.stopPropagation()}
          onTouchStart={(e) => e.stopPropagation()}
          size="sm"
          unstyled
        />
      </div>
    </div>
  );
}
