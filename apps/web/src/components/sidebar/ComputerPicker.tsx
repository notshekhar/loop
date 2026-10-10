/**
 * The sidebar's computer picker — All computers, This machine, or one added host —
 * and the narrowed project and thread lists every sidebar style reads.
 *
 * The choice is kept in localStorage, so it survives a restart and all three
 * sidebar styles (and the landing page) agree on it. See computerScope.ts.
 */
import { useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { ChevronDownIcon, MonitorIcon, ServerIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useProjects, useThreadShells } from "../../state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";
import { SidebarMenuButton } from "../ui/sidebar";
import { computerOptions, resolveComputerScope, type ComputerOption } from "./computerScope";

const STORAGE_KEY = "loop:sidebar:computer";
const StoredComputer = Schema.NullOr(Schema.String);

export function useComputerScope() {
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const computers = useMemo(
    () => computerOptions({ environments, primaryEnvironmentId }),
    [environments, primaryEnvironmentId],
  );
  const [stored, setStored] = useLocalStorage(STORAGE_KEY, null, StoredComputer);
  const scope = resolveComputerScope(stored, computers);
  return {
    computers,
    scope,
    current: computers.find((computer) => computer.environmentId === scope) ?? null,
    setScope: (environmentId: string | null) => setStored(environmentId),
  };
}

/** The projects and threads on the chosen computer (all of them for "All"). */
export function useScopedSidebarEntities() {
  const { scope } = useComputerScope();
  const projects = useProjects();
  const threads = useThreadShells();
  return useMemo(
    () =>
      scope === null
        ? { projects, threads }
        : {
            projects: projects.filter((project) => project.environmentId === scope),
            threads: threads.filter((thread) => thread.environmentId === scope),
          },
    [projects, scope, threads],
  );
}

const ITEM_CLASS =
  "h-8 min-h-8 px-1 py-0 text-sm font-medium [&>span:last-child]:flex [&>span:last-child]:min-w-0 [&>span:last-child]:items-center [&>span:last-child]:gap-2";

function ComputerIcon({ computer }: { computer: ComputerOption | null }) {
  return computer === null || computer.isThisComputer ? (
    <MonitorIcon className="size-4 shrink-0" />
  ) : (
    <ServerIcon className="size-4 shrink-0" />
  );
}

/** Nothing until a second computer is added; then the picker. */
export function ComputerPicker() {
  const { computers, scope, current, setScope } = useComputerScope();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  if (computers.length < 2) return null;
  return (
    <Menu open={open} onOpenChange={setOpen}>
      <MenuTrigger
        render={
          <SidebarMenuButton
            aria-label="Choose which computer to show"
            className="min-w-0 focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar"
          />
        }
      >
        <ComputerIcon computer={current} />
        <span className="min-w-0 flex-1 truncate">{current?.label ?? "All computers"}</span>
        <ChevronDownIcon className="-mr-px size-4 shrink-0 opacity-60" />
      </MenuTrigger>
      <MenuPopup align="start" className="w-(--anchor-width)">
        <MenuRadioGroup
          value={scope ?? "all"}
          onValueChange={(value) => {
            const next = value === "all" ? null : String(value);
            if (next === scope) return;
            setScope(next);
            // Leave a thread on the computer you just switched away from; the
            // landing page opens a new chat on the chosen one.
            if (next !== null) void navigate({ to: "/" });
          }}
        >
          <MenuRadioItem value="all" closeOnClick className={ITEM_CLASS}>
            <ComputerIcon computer={null} />
            <span className="min-w-0 truncate text-sm">All computers</span>
          </MenuRadioItem>
          {computers.map((computer) => (
            <MenuRadioItem
              key={computer.environmentId}
              value={computer.environmentId}
              closeOnClick
              className={ITEM_CLASS}
            >
              <ComputerIcon computer={computer} />
              <span className="min-w-0 truncate text-sm">{computer.label}</span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}
