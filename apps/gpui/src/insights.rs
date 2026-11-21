//! A thread's usage, as loop's SessionInsights reads it: how full the
//! context is (`context.report`) and what it has cost (`cost.session`).

use gpui::{App, AppContext, Entity, Task};
use serde::Deserialize;
use serde_json::json;

use crate::host::{LoopHost, request};

#[derive(Debug, Clone, Deserialize)]
pub struct ContextCategory {
    pub label: String,
    pub tokens: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextReport {
    pub model_id: String,
    /// 0 when loop's catalog does not know the model.
    pub context_window: u64,
    /// The fraction of the window at which loop compacts on its own.
    pub auto_compact_threshold: f64,
    pub categories: Vec<ContextCategory>,
    pub total_tokens: u64,
    pub tool_count: u64,
    pub mcp_tool_count: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCost {
    pub usd: f64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cached_input_tokens: u64,
    /// Part of the total is an estimate for an interrupted turn.
    #[serde(default)]
    pub estimated: bool,
}

#[derive(Debug, Clone, Default)]
pub struct Insights {
    pub context: Option<ContextReport>,
    pub cost: Option<SessionCost>,
}

impl ContextReport {
    /// How full the context is, or `None` when the window is unknown.
    pub fn fraction(&self) -> Option<f64> {
        (self.context_window > 0).then(|| (self.total_tokens as f64 / self.context_window as f64).min(1.))
    }

    /// Past the point where loop would compact.
    pub fn warn(&self) -> bool {
        self.fraction().is_some_and(|fraction| fraction >= self.auto_compact_threshold)
    }
}

/// Both reads at once; a failed read is just missing, as in loop.
pub fn fetch(host: &Entity<LoopHost>, session_id: &str, cx: &mut App) -> Task<Insights> {
    let context = request::<ContextReport>(host, "context.report", json!({ "sessionId": session_id }), cx);
    let cost = request::<SessionCost>(host, "cost.session", json!({ "sessionId": session_id }), cx);
    cx.background_spawn(async move {
        let (context, cost) = futures::join!(context, cost);
        // An all-zero cost is no cost at all: nothing has run yet.
        let cost = cost.ok().filter(|cost| !(cost.usd == 0. && cost.input_tokens == 0 && cost.output_tokens == 0 && cost.cached_input_tokens == 0));
        Insights { context: context.ok(), cost }
    })
}

/// loop's formatUsd: four decimals under a dollar, since a turn is often
/// $0.004; `~` when part is estimated.
pub fn format_usd(usd: f64, estimated: bool) -> String {
    let prefix = if estimated { "~" } else { "" };
    if usd < 1. { format!("{prefix}${usd:.4}") } else { format!("{prefix}${usd:.2}") }
}

/// loop's formatTokens: `940`, `9.4k`, `128k`, `1.2M`… Each tier ends at
/// 999.5 of its unit so 999,600 rolls over to `1.0M`, not `1000k`.
pub fn format_tokens(count: u64) -> String {
    let value = count as f64;
    const TIERS: [(f64, &str); 4] = [(1e3, "k"), (1e6, "M"), (1e9, "B"), (1e12, "T")];
    if value < 1e3 {
        return count.to_string();
    }
    for (unit, suffix) in TIERS {
        if value < unit * 10. {
            return format!("{:.1}{suffix}", value / unit);
        }
        if value < unit * 999.5 || suffix == "T" {
            return format!("{}{suffix}", (value / unit).round());
        }
    }
    unreachable!("the T tier always returns")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_read_like_loops() {
        assert_eq!(format_tokens(940), "940");
        assert_eq!(format_tokens(9_400), "9.4k");
        assert_eq!(format_tokens(128_400), "128k");
        assert_eq!(format_tokens(999_600), "1.0M");
        assert_eq!(format_tokens(12_000_000), "12M");
    }

    #[test]
    fn small_spend_keeps_four_decimals() {
        assert_eq!(format_usd(0.61724, true), "~$0.6172");
        assert_eq!(format_usd(3.5, false), "$3.50");
    }

    #[test]
    fn the_ring_warns_past_the_compaction_point() {
        let report = ContextReport { model_id: "m".into(), context_window: 200_000, auto_compact_threshold: 0.8, categories: Vec::new(), total_tokens: 170_000, tool_count: 0, mcp_tool_count: 0 };
        assert_eq!(report.fraction(), Some(0.85));
        assert!(report.warn());
        let unknown = ContextReport { context_window: 0, ..report };
        assert_eq!(unknown.fraction(), None);
        assert!(!unknown.warn());
    }
}
