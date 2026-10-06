import type { ComponentProps } from "react";
import { ChevronDownIcon, type LucideIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
// The same `xs` size as the run-context controls (checkout, branch) sharing
// the toolbar under the input box, so the whole row reads at one size.
const composerControlClassName =
  "gap-1.5 px-2 text-muted-foreground/70 transition-none hover:text-foreground/80 [&_svg[data-composer-control-icon]]:mx-0 [&_svg[data-composer-control-chevron]]:-mx-0.5";

export function ComposerControl({
  className,
  size = "xs",
  variant = "ghost",
  ...props
}: ComponentProps<typeof Button>) {
  return (
    <Button
      className={cn(composerControlClassName, className)}
      size={size}
      variant={variant}
      {...props}
    />
  );
}

export function ComposerControlIcon({
  icon: Icon,
  className,
  opticalSize = "default",
}: {
  icon: LucideIcon;
  className?: string | undefined;
  opticalSize?: "default" | "large";
}) {
  return (
    <Icon
      aria-hidden="true"
      className={cn("shrink-0", opticalSize === "large" ? "size-4" : "size-3.5", className)}
      data-composer-control-icon
    />
  );
}

export function ComposerControlChevron() {
  return (
    <ChevronDownIcon
      aria-hidden="true"
      className="-mx-0.5 size-3 shrink-0 text-muted-foreground opacity-70"
      data-composer-control-chevron
      strokeWidth={2.25}
    />
  );
}
