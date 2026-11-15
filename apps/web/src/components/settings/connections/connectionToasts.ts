import { stackedThreadToast, toastManager } from "../../ui/toast";

export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function showErrorToast(title: string, description: string): void {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description,
    }),
  );
}
