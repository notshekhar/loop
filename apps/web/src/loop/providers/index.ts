/**
 * loop's providers, as the UI sees them.
 *
 * Two halves, deliberately kept apart:
 *
 *   - **What exists and what is connected** comes from loop at runtime
 *     (`auth.providers`). loop is the only thing that knows which providers
 *     this build ships, which have credentials, and which gateways the user
 *     added — so nothing here hard-codes that.
 *   - **How a provider looks and what its login asks for** comes from
 *     `catalog.json`. Presentation is a UI concern and has no business
 *     round-tripping through an RPC.
 *
 * A provider loop reports that this file has never heard of still renders: it
 * falls back to a lettermark and a generic API-key form. That is the whole
 * point of the split — adding a provider to loop must not require a UI change
 * to make it usable.
 */
import { ClaudeCodeIcon, CursorIcon, type Icon } from "../../components/Icons";
import {
  AnthropicIcon,
  BedrockIcon,
  CerebrasIcon,
  CopilotIcon,
  DeepSeekIcon,
  GoogleAiIcon,
  GroqIcon,
  MistralIcon,
  MoonshotIcon,
  OllamaIcon,
  OpenAiIcon,
  OpenRouterIcon,
  VercelIcon,
  XaiIcon,
  ZenMuxIcon,
  ZhipuIcon,
} from "../../components/LoopProviderIcons";
import {
  customProviderName,
  customProviderShape,
  providerPresentation as basePresentation,
  type CustomProviderShape,
  type LoopProviderPresentation as BasePresentation,
} from "./presentation.ts";

export {
  customProviderName,
  customProviderShape,
  loginMethodsFor,
  providerInitials,
  rememberCustomProviderShapes,
  type CustomProviderShape,
  type LoopAuthMethod,
  type LoopLoginMethod,
} from "./presentation.ts";

export interface LoopProviderPresentation extends BasePresentation {
  readonly icon?: Icon;
}

const ICONS: Record<string, Icon> = {
  anthropic: AnthropicIcon,
  openai: OpenAiIcon,
  google: GoogleAiIcon,
  xai: XaiIcon,
  openrouter: OpenRouterIcon,
  "github-copilot": CopilotIcon,
  deepseek: DeepSeekIcon,
  mistral: MistralIcon,
  // loop's `glm` (China) and `zai` (international) are two endpoints in front
  // of the same Zhipu models, and models.dev serves them a byte-identical
  // mark — so one component backs both catalog entries.
  zhipuai: ZhipuIcon,
  zai: ZhipuIcon,
  moonshotai: MoonshotIcon,
  groq: GroqIcon,
  cerebras: CerebrasIcon,
  zenmux: ZenMuxIcon,
  vercel: VercelIcon,
  "amazon-bedrock": BedrockIcon,
  ollama: OllamaIcon,
  // Native agents: loop drives the user's own CLI, so the mark is the
  // product's, not the model vendor's.
  "claude-code": ClaudeCodeIcon,
  "cursor-agent": CursorIcon,
};

/**
 * The mark for a gateway is the mark of the API it SPEAKS.
 *
 * A custom provider has no brand of its own — bifrost, LiteLLM and a hand-
 * rolled proxy are all just an endpoint — so the only honest thing to draw is
 * the shape it is compatible with. The gateway's own identity rides as the
 * initials badge over the corner of it (`ProviderInstanceIcon`), which is what
 * keeps two Anthropic-compatible gateways apart.
 */
const SHAPE_ICONS: Record<CustomProviderShape, Icon> = {
  anthropic: AnthropicIcon,
  openai: OpenAiIcon,
  "openai-compatible": OpenAiIcon,
  google: GoogleAiIcon,
};

/**
 * Decorated once per known provider, so a known id keeps returning the same
 * object — callers that memoize on it see no change between renders.
 */
const DECORATED = new Map<string, LoopProviderPresentation>();

/**
 * Presentation for one loop provider id, with its brand mark. Never returns
 * undefined — see `presentation.ts` for the fallbacks.
 */
export function providerPresentation(loopProviderId: string): LoopProviderPresentation {
  const cached = DECORATED.get(loopProviderId);
  if (cached) return cached;
  const base = basePresentation(loopProviderId);
  const custom = customProviderName(loopProviderId);
  if (custom !== null) {
    // Before loop has reported the shape there is nothing true to draw, so
    // the lettermark stands in rather than a guessed brand. Not cached: the
    // shape is runtime data and can arrive later.
    const shape = customProviderShape(custom);
    return shape === undefined ? base : { ...base, icon: SHAPE_ICONS[shape] };
  }
  const icon = base.iconKey === undefined ? undefined : ICONS[base.iconKey];
  const decorated = icon === undefined ? base : { ...base, icon };
  DECORATED.set(loopProviderId, decorated);
  return decorated;
}
