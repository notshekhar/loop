import { cn } from "../../../lib/utils";
import { ITEM_ROW_CLASSNAME } from "../itemRows";

const ENDPOINT_ROW_CLASSNAME = "rounded-xl px-3 py-2.5 sm:px-4";

export type AccessSectionPresentation = "current" | "endpoint-rail";

export function accessRowClassName(_presentation: AccessSectionPresentation) {
  return ITEM_ROW_CLASSNAME;
}

export function endpointRowClassName(
  presentation: AccessSectionPresentation,
  isAvailable: boolean,
) {
  if (presentation === "endpoint-rail") {
    return cn("relative rounded-xl px-3 py-3 sm:px-4", !isAvailable && "bg-muted/15");
  }

  return cn(ENDPOINT_ROW_CLASSNAME, !isAvailable && "bg-muted/24");
}

const accessTimestampFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

export function formatAccessTimestamp(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return accessTimestampFormatter.format(parsed);
}
