import { describe, expect, it } from "vite-plus/test";

import { OpenAiIcon } from "../LoopProviderIcons";
import { toInstanceId } from "../../loop/handlers/ids";
import { providerPresentation } from "../../loop/providers";
import { providerIconFor } from "./providerIconUtils";

describe("provider marks", () => {
  it("draws ChatGPT-plan sign-in with OpenAI's mark and calls it ChatGPT", () => {
    // Without a catalog entry it fell back to an "OC" lettermark labelled
    // "Openai Chatgpt" in the model picker and settings.
    expect(providerIconFor(toInstanceId("openai-chatgpt") as never)).toBe(OpenAiIcon);
    expect(providerPresentation("openai-chatgpt").label).toBe("ChatGPT");
  });
});
