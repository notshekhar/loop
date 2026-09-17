import * as Schema from "effect/Schema";

import { LoopProjectFile, LOOP_PROJECT_FILE_SCHEMA_URL } from "@loop/contracts";

import { fromLenientJson } from "./schemaJson.ts";

/**
 * Codec between the raw `loop.json` file contents (lenient JSONC string) and the
 * decoded {@link LoopProjectFile}.
 */
export const LoopProjectFileFromJson = fromLenientJson(LoopProjectFile);

/**
 * Build the publishable JSON Schema document for `loop.json` (draft 2020-12).
 *
 * Served by the web app at {@link LOOP_PROJECT_FILE_SCHEMA_URL} so
 * editors get LSP support via a `$schema` reference.
 */
export function buildLoopProjectFileJsonSchema(): Record<string, unknown> {
  const document = Schema.toJsonSchemaDocument(LoopProjectFile);
  const jsonSchema: Record<string, unknown> = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: LOOP_PROJECT_FILE_SCHEMA_URL,
    ...document.schema,
  };
  if (document.definitions && Object.keys(document.definitions).length > 0) {
    jsonSchema.$defs = document.definitions;
  }
  return jsonSchema;
}
