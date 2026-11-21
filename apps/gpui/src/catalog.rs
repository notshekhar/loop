use gpui::{Context, Entity};
use serde::Deserialize;
use serde_json::json;

use crate::host::{LoopHost, request};

/// One model the host can run (`catalog.list`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Model {
    pub id: String,
    pub provider: String,
    pub name: String,
    #[serde(default)]
    pub reasoning: bool,
    /// Its provider is signed in.
    #[serde(default)]
    pub available: bool,
}

/// loop's thinking levels (packages/core/src/agent/thinking.ts).
pub const THINKING_LEVELS: [&str; 6] = ["off", "minimal", "low", "medium", "high", "xhigh"];

/// Every model the signed-in providers offer. `catalog.list` can take many
/// seconds (it refreshes models.dev), so it loads once in the background.
pub struct Catalog {
    pub models: Vec<Model>,
    pub loaded: bool,
}

impl Catalog {
    pub fn new(host: Entity<LoopHost>, cx: &mut Context<Self>) -> Self {
        let task = request::<Vec<Model>>(&host, "catalog.list", json!({}), cx);
        cx.spawn(async move |this, cx| {
            let models = task.await.unwrap_or_default();
            this.update(cx, |catalog, cx| {
                catalog.models = models.into_iter().filter(|model| model.available).collect();
                catalog.loaded = true;
                cx.notify();
            })
        })
        .detach();
        Self { models: Vec::new(), loaded: false }
    }

    pub fn find(&self, id: &str) -> Option<&Model> {
        self.models.iter().find(|model| model.id == id)
    }

    /// Models whose name, id or provider contains every word of `query`.
    pub fn search(&self, query: &str) -> Vec<&Model> {
        let words: Vec<String> = query.split_whitespace().map(str::to_lowercase).collect();
        self.models
            .iter()
            .filter(|model| {
                let haystack = format!("{} {} {}", model.name, model.id, model.provider).to_lowercase();
                words.iter().all(|word| haystack.contains(word))
            })
            .collect()
    }
}

/// A model id's short display name when the catalog has not loaded yet:
/// `xai/grok-4.7` → `grok-4.7`.
pub fn short_name(id: &str) -> &str {
    id.rsplit('/').next().unwrap_or(id)
}

/// How loop names a provider in its pickers.
pub fn provider_name(provider: &str) -> String {
    let known = match provider {
        "xai" => "xAI",
        "anthropic" => "Anthropic",
        "claude-code" => "Claude Code",
        "openai" => "OpenAI",
        "openai-chatgpt" => "ChatGPT",
        "openai-codex" => "Codex",
        "google" => "Google",
        "deepseek" => "DeepSeek",
        "kimi" => "Kimi",
        "glm" | "zai" => "Z.ai",
        "mistral" => "Mistral",
        "groq" => "Groq",
        "openrouter" => "OpenRouter",
        "vercel" => "Vercel",
        "inception" => "Inception",
        _ => return provider.to_string(),
    };
    known.to_string()
}
