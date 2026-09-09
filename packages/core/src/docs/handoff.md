# Session handoff

`/handoff` carries the current task into a fresh terminal session through a reviewed brief. Use it when a conversation has become crowded or another model or agent should take over.

```text
/handoff
/handoff focus on the remaining validation failures
```

The current model drafts a brief from the active conversation branch and a read-only Git status snapshot. It covers the objective, constraints and decisions, completed work and changed files, verification, failed approaches, open issues and next steps. Long conversations are excerpted, retaining the opening task and recent outcome; review the brief for missing details.

The review menu offers:

- **Open a fresh session**: pick a model and agent, save the brief in a new session, and wait for your next prompt.
- **Open and continue**: pick a model and agent, then start one normal agent turn on the next unfinished step.
- **Edit brief**: revise the Markdown and return to review.
- **Cancel**: stay in the original session.

The model picker starts with your current model and includes the available catalog. The agent picker starts with your current agent. Keeping the current agent preserves an active read-only plan-mode gate; choosing the plan agent also enables that gate in the destination. Other agent choices use their normal tool restrictions. Destination choices apply to the live session; they do not change your saved global defaults.

Cancelling any picker or failing to generate a brief creates no destination session. Brief generation is a model request, recorded against the source session. A completed destination is saved atomically with its brief and source link before Loop switches to it, so it can be reopened through `/resume` or `loop --session <id>`.

The new session contains the reviewed brief, not a copy of the entire conversation. Its message includes the source session ID, source entry, workspace and a command to return to the original conversation. The original transcript remains intact. Both sessions use the same workspace; handoff does not create a worktree or copy files. Current Git changes may include your own edits and are not automatically attributed to the agent.

Session-owned background shells, goal automation and approvals stay with the source session. The brief can describe unfinished work, but those running processes and automation states are not transferred. The receiving agent must inspect current files and verify outcomes again where needed.

Use `/recipe save <name>` for a workflow to repeat with different inputs. Use `/handoff` to continue this particular task with its current state.
