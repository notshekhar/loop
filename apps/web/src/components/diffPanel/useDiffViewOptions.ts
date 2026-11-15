import { useState } from "react";

export type DiffRenderMode = "stacked" | "split";

/** The toolbar's view toggles, seeded from the user's settings. */
export function useDiffViewOptions(settings: {
  readonly wordWrap: boolean;
  readonly diffIgnoreWhitespace: boolean;
}) {
  const [diffRenderMode, setDiffRenderMode] = useState<DiffRenderMode>("stacked");
  const [wordWrap, setWordWrap] = useState(settings.wordWrap);
  const [diffIgnoreWhitespace, setDiffIgnoreWhitespace] = useState(settings.diffIgnoreWhitespace);
  return {
    diffRenderMode,
    setDiffRenderMode,
    wordWrap,
    setWordWrap,
    diffIgnoreWhitespace,
    setDiffIgnoreWhitespace,
  };
}

export type DiffViewOptions = ReturnType<typeof useDiffViewOptions>;
