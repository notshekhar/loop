/**
 * Which computer the sidebar shows: all of them, this one, or one added host.
 *
 * With a host added, the sidebar mixes both machines' projects, and nothing
 * said which one a new chat would run on or let you go back to just this one.
 * The scope narrows the sidebar — and so the projects a new chat picks from —
 * to one computer.
 */
import type { EnvironmentId } from "@loop/contracts";

export interface ComputerOption {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly isThisComputer: boolean;
}

/** This computer first, then the added hosts by name. */
export function computerOptions(input: {
  readonly environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
  }>;
  readonly primaryEnvironmentId: EnvironmentId | null;
}): ComputerOption[] {
  return input.environments
    .map((environment) => {
      const isThisComputer = environment.environmentId === input.primaryEnvironmentId;
      return {
        environmentId: environment.environmentId,
        // This computer's own label ("This machine") — the name the project
        // switcher already shows beside its projects.
        label: environment.label,
        isThisComputer,
      };
    })
    .toSorted((a, b) =>
      a.isThisComputer !== b.isThisComputer
        ? a.isThisComputer
          ? -1
          : 1
        : a.label.localeCompare(b.label),
    );
}

/** The stored choice, or null (all computers) once that computer is gone. */
export function resolveComputerScope(
  stored: string | null,
  options: ReadonlyArray<ComputerOption>,
): EnvironmentId | null {
  if (stored === null || options.length < 2) return null;
  return options.find((option) => option.environmentId === stored)?.environmentId ?? null;
}
