use gpui::{Context, Entity};
use serde::Deserialize;
use serde_json::json;

use crate::host::{LoopHost, request};

#[derive(Deserialize)]
struct Listed {
    name: String,
}

/// The named agents a turn can run as (`agent.list`), loaded once.
pub struct Agents {
    pub names: Vec<String>,
}

impl Agents {
    pub fn new(host: Entity<LoopHost>, cx: &mut Context<Self>) -> Self {
        let task = request::<Vec<Listed>>(&host, "agent.list", json!({}), cx);
        cx.spawn(async move |this, cx| {
            let listed = task.await.unwrap_or_default();
            this.update(cx, |agents, cx| {
                agents.names = listed.into_iter().map(|agent| agent.name).collect();
                cx.notify();
            })
        })
        .detach();
        Self { names: Vec::new() }
    }
}
