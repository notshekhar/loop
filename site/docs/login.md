<!-- title: Signing in -->
<!-- order: 3 -->
<!-- blurb: Every provider loop supports, where to get the key, and how subscriptions, OAuth, and custom gateways work. -->

loop ships no models. You bring one — a subscription you already pay for, an API key, a local daemon, or your company's gateway. You can sign in to as many as you like and switch between them mid-session with `/model`.

## The short version

```
loop login
```

Picks a provider from a list, then walks you through it. Or name one directly:

```
loop login xai
loop login anthropic
loop login custom
```

Inside the TUI it's `/login`. `loop whoami` shows who you're signed in to and which provider is active; `loop logout [provider]` removes credentials.

## Sign in with a subscription you already have

Three providers bill against a plan instead of per token. No API key involved.

### xAI / SuperGrok

```
loop login xai
```

Choose **OAuth subscription**. A browser opens, you approve, and you're done. Requests bill to your SuperGrok plan. Grok is loop's default model (`xai/grok-build-0.1`), so this is the shortest path to a working setup.

### ChatGPT

```
loop login openai
```

Choose **Continue with ChatGPT**. The first time, ChatGPT asks you to approve loop for your account. After that, requests use your ChatGPT plan through OpenAI's official [Sign in with ChatGPT](https://developers.openai.com/siwc/token-sharing-open-source). The model list is whatever your plan offers.

Usage counts against your plan's limits. You can set a weekly limit for loop or disconnect it under ChatGPT → Settings → Usage. Signing out (`loop logout openai-chatgpt`) also ends the session on OpenAI's side. Signing in again reuses the same connection; pick **Use a different ChatGPT account** to add another account or workspace.

The other option on that menu is a pay-as-you-go `OPENAI_API_KEY`.

### GitHub Copilot

```
loop login github-copilot
```

Uses GitHub's device flow: loop prints a code, you paste it into the page that opens, and requests bill against your Copilot subscription.

## Sign in with an API key

Every other built-in provider takes a key. `loop login <provider>` prompts for it and stores it in `~/.loop/auth.json` (mode 600).

| Provider          | `loop login` id | Where the key comes from                                                                   |
| ----------------- | --------------- | ------------------------------------------------------------------------------------------ |
| xAI (Grok)        | `xai`           | [console.x.ai](https://console.x.ai) → API Keys                                            |
| Anthropic         | `anthropic`     | [console.anthropic.com](https://console.anthropic.com/settings/keys) → Settings → API Keys |
| OpenAI            | `openai`        | [platform.openai.com](https://platform.openai.com/api-keys) → API keys                     |
| Google Gemini     | `google`        | [aistudio.google.com](https://aistudio.google.com/apikey) → Get API key                    |
| OpenRouter        | `openrouter`    | [openrouter.ai](https://openrouter.ai/settings/keys) → Settings → Keys                     |
| DeepSeek          | `deepseek`      | [platform.deepseek.com](https://platform.deepseek.com/api_keys) → API keys                 |
| Mistral           | `mistral`       | [console.mistral.ai](https://console.mistral.ai/api-keys) → API Keys                       |
| Zhipu GLM         | `glm`           | [open.bigmodel.cn](https://open.bigmodel.cn) → 用户中心 / User Center → API Keys           |
| Z.AI              | `zai`           | [z.ai](https://z.ai) → API Keys (the international GLM endpoint)                           |
| Kimi (Moonshot)   | `kimi`          | [platform.moonshot.ai](https://platform.moonshot.ai) → Console → API Keys                  |
| Groq              | `groq`          | [console.groq.com](https://console.groq.com/keys) → API Keys                               |
| Cerebras          | `cerebras`      | [cloud.cerebras.ai](https://cloud.cerebras.ai) → API Keys                                  |
| ZenMux            | `zenmux`        | [zenmux.ai](https://zenmux.ai) → Settings → API Keys                                       |
| Vercel AI Gateway | `vercel`        | [vercel.com](https://vercel.com) → AI Gateway → API Keys                                   |

> A key you paste is stored on disk. If you'd rather it never be written down, use the environment-variable path below, or a custom provider with a key-helper command.

## Providers that need no login

### Ollama — local models, no key, no bill

Install [Ollama](https://ollama.com), pull a model, and leave the daemon running. loop detects it and lists your local models automatically.

```
ollama pull qwen3-coder
loop
```

Point loop at a non-default host with `LOOP_OLLAMA_BASE_URL`.

### AWS Bedrock

No `loop login` step. Bedrock is detected from whatever AWS credentials the machine already has — the `aws` CLI, environment variables, or an SSO session. If `aws sts get-caller-identity` works, Bedrock models show up in `/model`.

## Environment variables

If a provider has no stored credential, loop falls back to an environment variable at request time. Nothing is written to disk.

```
export ANTHROPIC_API_KEY=sk-ant-...
export OPENAI_API_KEY=sk-...
loop
```

The name is the provider id, uppercased, plus `_API_KEY`: `XAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`, `OPENROUTER_API_KEY`, `DEEPSEEK_API_KEY`, `MISTRAL_API_KEY`, `GLM_API_KEY`, `ZAI_API_KEY`, `KIMI_API_KEY`, `GROQ_API_KEY`, `CEREBRAS_API_KEY`, `ZENMUX_API_KEY`.

Vercel is the one exception: it reads **`AI_GATEWAY_API_KEY`**, Vercel's own name for gateway keys. `VERCEL_API_KEY` is deliberately not used — that name means a deploy token, which is not a gateway key.

This is the right path for CI: set the variable in the job environment and never run `loop login` at all.

## Custom providers and gateways

```
loop login custom
```

For anything speaking an OpenAI-, Anthropic-, or Google-compatible API — Bifrost, LiteLLM, an internal proxy, a self-hosted model server, a vendor not in the built-in list. The wizard asks for a name, a base URL, an API shape, an auth method, and a model list. The result is saved to `~/.loop/` and behaves exactly like a built-in provider.

### API shapes

- **Anthropic-compatible** — the Claude API shape (`/v1/messages`)
- **OpenAI-compatible** — chat completions (`/v1/chat/completions`)
- **Google-compatible** — the Gemini API shape (`/v1beta`)

### The six auth methods

| Method                   | What it does                                                                      | Use it for                           |
| ------------------------ | --------------------------------------------------------------------------------- | ------------------------------------ |
| **API key**              | Stored key, sent in the vendor header (`x-api-key` / `Bearer` / `x-goog-api-key`) | Ordinary keys                        |
| **Bearer token**         | Always `Authorization: Bearer`                                                    | Gateways with their own tokens       |
| **OAuth / SSO**          | Browser sign-in (PKCE); tokens refresh automatically                              | Corporate SSO in front of a gateway  |
| **Environment variable** | Read at request time, nothing stored                                              | CI, shared machines                  |
| **Command (key helper)** | Runs a shell command; stdout is the key                                           | Vault reads, short-lived SSO tokens  |
| **None / headers only**  | No credential                                                                     | mTLS, custom headers, open endpoints |

**OAuth** endpoints auto-discover from the base URL's `.well-known` metadata. If the server publishes none, the wizard asks for the authorization and token endpoints (and a client id, when the server doesn't support dynamic registration). Add the `offline_access` scope if the server needs it to issue refresh tokens.

**Key helpers** re-run on a 5-minute TTL and on any 401. If your command knows the real expiry, print JSON instead of a bare key and loop will use it:

```json
{ "key": "sk-...", "expiresAt": 1793107200000 }
```

`apiKey` and `token` work as aliases for `key`, and `expiresInMs` as an alias for `expiresAt`. Keys persist in `~/.loop/auth.json` across restarts until they actually expire.

Headers and values support `${env:VAR}` placeholders, resolved at connect time, so secrets stay out of the config file.

## Switching between them

Once you're signed in to more than one:

- `/model` — searchable picker across every provider you can use
- `/provider` — switch the active provider
- `Ctrl+P` — cycle recent models without opening a picker
- `/scoped-models` — pin a specific model per agent (a cheap one for subagents, an expensive one for the main loop)

A model missing from the picker usually means it's new. [Adding a model](configuration.html#adding-a-model) covers that.

## Signing out

```
loop logout              # every provider
loop logout anthropic    # just one
```

In the TUI, `/logout` offers the same, plus an "all providers" entry.
