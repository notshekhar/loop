/**
 * `parent /` ahead of a `/btw` side thread's title: the way back to the chat
 * the question was asked in. Nothing for any other thread, or when the parent
 * is no longer listed (archived or deleted).
 */
import type { EnvironmentId, ThreadId } from "@loop/contracts";
import { memo, useMemo } from "react";

import { useThreadShell } from "../../state/entities";
import { ParentCrumb } from "./ParentCrumb";

export const SideThreadCrumb = memo(function SideThreadCrumb(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const here = useMemo(
    () => ({ environmentId: props.environmentId, threadId: props.threadId }),
    [props.environmentId, props.threadId],
  );
  const shell = useThreadShell(here);
  const parentId = shell?.sideThreadOf ?? null;
  const parent = useThreadShell(
    useMemo(
      () => (parentId === null ? null : { environmentId: props.environmentId, threadId: parentId }),
      [props.environmentId, parentId],
    ),
  );
  if (!parent) return null;
  return (
    <ParentCrumb
      environmentId={props.environmentId}
      threadId={parent.id}
      title={parent.title}
      hint="Back to where this was asked"
    />
  );
});
