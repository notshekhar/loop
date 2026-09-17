import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import { ProjectScriptIcon } from "./orchestration.ts";

/** File name of the checked-in Loop project file, resolved at the workspace root. */
export const LOOP_PROJECT_FILE_NAME = "loop.json";

/** App-relative URL of the JSON Schema for {@link LoopProjectFile}. */
export const LOOP_PROJECT_FILE_SCHEMA_URL = "/schema/loop.json";

const LOOP_PROJECT_FILE_PATH_MAX_LENGTH = 512;
const LOOP_PROJECT_FILE_MAX_SCRIPTS = 50;

// Annotations go on the encoded (string) side so they survive into the
// published JSON Schema; decoding still trims and re-validates non-emptiness.
const trimmedNonEmpty = (annotations: { readonly description: string }, maxLength?: number) => {
  const annotated = Schema.String.annotate(annotations);
  const encoded =
    maxLength === undefined
      ? annotated.check(Schema.isNonEmpty())
      : annotated.check(Schema.isNonEmpty(), Schema.isMaxLength(maxLength));
  return encoded.pipe(Schema.decodeTo(encoded, SchemaTransformation.trim()));
};

export const LoopProjectFileScript = Schema.Struct({
  name: trimmedNonEmpty({
    description: "Display name for the script, shown in the Loop scripts menu.",
  }),
  command: trimmedNonEmpty({
    description: "Shell command executed in a Loop terminal at the project root.",
  }),
  icon: Schema.optionalKey(
    ProjectScriptIcon.annotate({
      description: 'Icon shown next to the script in the scripts menu. Defaults to "play".',
    }),
  ),
  runOnWorktreeCreate: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "When true, the script runs automatically after a worktree is created for a new thread.",
    }),
  ),
  previewUrl: Schema.optionalKey(
    trimmedNonEmpty({
      description:
        "URL opened in the in-app browser preview when this script runs. Only honored on the desktop build.",
    }),
  ),
  autoOpenPreview: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "When true, automatically open the preview panel at `previewUrl` the moment the script starts.",
    }),
  ),
}).annotate({
  description: "A project script that team members can import into Loop.",
});
export type LoopProjectFileScript = typeof LoopProjectFileScript.Type;

export const LoopProjectFile = Schema.Struct({
  $schema: Schema.optionalKey(
    Schema.String.annotate({
      description: `URL of the JSON Schema for this file, typically "${LOOP_PROJECT_FILE_SCHEMA_URL}".`,
    }),
  ),
  iconPath: Schema.optionalKey(
    trimmedNonEmpty(
      {
        description:
          'Workspace-relative path to the project icon (e.g. "assets/logo.svg"). Checked before Loop\'s built-in icon locations.',
      },
      LOOP_PROJECT_FILE_PATH_MAX_LENGTH,
    ),
  ),
  scripts: Schema.optionalKey(
    Schema.Array(LoopProjectFileScript)
      .annotate({
        description: "Project scripts shared with everyone who opens this repository in Loop.",
      })
      .check(Schema.isMaxLength(LOOP_PROJECT_FILE_MAX_SCRIPTS)),
  ),
}).annotate({
  title: "Loop project file",
  description:
    "Checked-in project configuration for Loop (loop.json at the repository root). See https://github.com/notshekhar/loop for documentation.",
});
export type LoopProjectFile = typeof LoopProjectFile.Type;
