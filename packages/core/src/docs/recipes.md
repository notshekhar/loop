# Recipes

Recipes turn a session's workflow into editable Markdown that can be run again with different inputs. Available in the interactive terminal through `/recipe`.

## Save a workflow

After finishing a task:

```text
/recipe save add-endpoint
/recipe save add-endpoint vary the resource name and route
```

Loop asks what should vary when no focus is supplied, then uses the current model to extract a draft from the active conversation branch. The draft includes purpose, inputs, steps and verification. Review it, edit the steps or inputs if needed, and choose **save recipe**. Esc cancels without writing. Extraction is a model request and its usage is tracked; it does not execute the workflow.

Long conversations are excerpted to retain the opening task and recent outcome. Review the draft for missing details and check that it is suitable for reuse.

Recipes are personal files under `~/.loop/recipes/<name>.md`, available from any project. Names use lowercase letters, numbers and dashes, up to 64 characters. Saving refuses to overwrite an existing name; use `/recipe edit <name>` to change it.

## Run a recipe

```text
/recipe
/recipe add-endpoint users /api/users
/recipe add-endpoint resource=users route=/api/users
/recipe add-endpoint resource="user accounts"
```

The bare command opens a searchable recipe picker with run, view, edit and delete actions. Positional values follow the order in which placeholders first appear in the file. Named values may appear in any order; positional values fill the remaining inputs. Quote values that contain spaces. Missing or blank inputs are requested interactively; blank/Esc at an input prompt cancels the run. Unknown input names, duplicate named inputs and extra values are rejected.

The expanded workflow becomes a normal user message in the current session. It uses the current workspace, model, agent and permission rules. Loop inspects the current code and adapts the steps, rather than replaying old commands blindly. A saved workflow does not imply its next run will succeed; its verification steps must run again.

## Manage files

```text
/recipe list
/recipe show add-endpoint
/recipe edit add-endpoint
/recipe rm add-endpoint
/recipe help
```

You can also edit or share the Markdown file directly. Inputs use `{{resource}}` syntax: a letter followed by letters, numbers or underscores. Repeated placeholders use the same value. Substitution is one pass and never evaluates shell syntax.

Example file:

```markdown
# Add an endpoint
## Purpose
Add a resource endpoint using this repository's conventions.
## Inputs
- {{resource}}: the resource name
- {{route}}: the route to expose
## Steps
1. Inspect an existing endpoint and its tests.
2. Add {{resource}} at {{route}} using the same structure.
3. Add success, validation and failure cases.
## Verification
Run the relevant endpoint tests and the repository's typecheck.
```

For a recipe named after a subcommand, use the explicit form: `/recipe run list`. Recipes are read when invoked, so editing a file requires no reload.
