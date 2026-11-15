import { Spinner } from "../../ui/spinner";

/** Spinner plus progress text for a confirm button whose action restarts the backend. */
export function BusyLabel({ children }: { readonly children: string }) {
  return (
    <>
      <Spinner className="size-3.5" />
      {children}
    </>
  );
}
