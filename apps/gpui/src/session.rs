use gpui::{App, AppContext, Context, Entity, EventEmitter, SharedString};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::host::{LoopHost, request};
use crate::insights::{self, Insights};
use crate::transcript::model::{message_from_json, todos_from_json};
use crate::transcript::reduce::apply_event;
use crate::transcript::Transcript;
use crate::ui::format::now_millis;

/// One option of a question the agent asked.
#[derive(Debug, Clone, Deserialize)]
pub struct AskOption {
    pub label: String,
    #[serde(default)]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AskQuestion {
    pub question: String,
    #[serde(default)]
    pub header: String,
    #[serde(default)]
    pub options: Vec<AskOption>,
    #[serde(default)]
    pub multi_select: bool,
}

/// The `ask` tool waiting on the user (`ask` event → `session.answer`).
#[derive(Debug, Clone)]
pub struct PendingAsk {
    pub id: String,
    pub questions: Vec<AskQuestion>,
}

#[derive(Debug, Clone)]
pub enum LoadState {
    Loading,
    Ready,
    Failed(SharedString),
}

/// How the transcript changed, so the view re-measures only what it must.
pub enum SessionEvent {
    /// Messages were added or removed.
    Reset,
    /// Only the last message changed (a reply streaming).
    TailChanged,
    /// A turn failed to start or a request was refused.
    Error(SharedString),
}

/// What the composer chose for a turn; `None` leaves it to the session.
#[derive(Clone, Default)]
pub struct TurnChoices {
    pub model: Option<String>,
    pub thinking: Option<&'static str>,
    pub agent: Option<String>,
}

/// One open conversation: its transcript, kept live from `session.event`.
pub struct Session {
    pub id: String,
    host: Entity<LoopHost>,
    pub transcript: Transcript,
    pub load: LoadState,
    pub ask: Option<PendingAsk>,
    pub model: Option<String>,
    pub cwd: String,
    /// How full the context is and what the thread has cost.
    pub insights: Insights,
    /// A compaction the user asked for is running.
    pub compacting: bool,
    /// Why the last compaction did nothing or failed.
    pub compact_note: Option<SharedString>,
    /// The last event applied; events at or below it are already in.
    seq: u64,
}

impl EventEmitter<SessionEvent> for Session {}

#[derive(Deserialize)]
struct MessagesReply {
    messages: Vec<Value>,
    todos: Value,
    running: bool,
    seq: u64,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    info: Value,
}

#[derive(Deserialize)]
struct CompactReply {
    #[serde(default)]
    summary: String,
}

#[derive(Deserialize)]
struct AttachReply {
    #[serde(default)]
    resync: bool,
}

impl Session {
    pub fn open(id: String, host: Entity<LoopHost>, cx: &mut App) -> Entity<Self> {
        let session = cx.new(|_| Self {
            id: id.clone(),
            host: host.clone(),
            transcript: Transcript::default(),
            load: LoadState::Loading,
            ask: None,
            model: None,
            cwd: String::new(),
            insights: Insights::default(),
            compacting: false,
            compact_note: None,
            seq: 0,
        });
        host.update(cx, |host, _| host.register(&id, &session));
        session.update(cx, |session, cx| session.load(cx));
        session
    }

    /// Reads the whole transcript, then subscribes from the event it is good
    /// to — the order loop's protocol asks for, so no event applies twice.
    fn load(&mut self, cx: &mut Context<Self>) {
        let messages = request::<MessagesReply>(&self.host, "session.messages", json!({ "sessionId": self.id }), cx);
        let host = self.host.clone();
        let id = self.id.clone();
        cx.spawn(async move |this, cx| {
            let reply = messages.await;
            let seq = this.update(cx, |session, cx| session.loaded(reply, cx))?;
            let Some(seq) = seq else { return anyhow::Ok(()) };
            let attach = cx.update(|cx| request::<AttachReply>(&host, "session.attach", json!({ "sessionId": id, "afterSeq": seq }), cx));
            if attach.await.is_ok_and(|reply| reply.resync) {
                this.update(cx, |session, cx| session.load(cx))?;
            }
            Ok(())
        })
        .detach();
    }

    fn loaded(&mut self, reply: anyhow::Result<MessagesReply>, cx: &mut Context<Self>) -> Option<u64> {
        let reply = match reply {
            Ok(reply) => reply,
            Err(error) => {
                self.load = LoadState::Failed(format!("{error:#}").into());
                cx.notify();
                return None;
            }
        };
        self.transcript = Transcript {
            messages: reply.messages.iter().filter_map(message_from_json).collect(),
            running: reply.running,
            todos: todos_from_json(&reply.todos),
        };
        self.seq = reply.seq;
        self.model = reply.model;
        self.cwd = reply.info["cwd"].as_str().unwrap_or_default().to_string();
        self.load = LoadState::Ready;
        self.refresh_insights(cx);
        cx.emit(SessionEvent::Reset);
        cx.notify();
        Some(reply.seq)
    }

    pub fn apply(&mut self, seq: u64, kind: &str, data: &Value, cx: &mut Context<Self>) {
        if seq != 0 && seq <= self.seq {
            return;
        }
        self.seq = seq.max(self.seq);
        match kind {
            "ask" => self.ask = parse_ask(data),
            "tool-result" | "tool-error" if data["toolName"] == "ask" => self.ask = None,
            "session-running" if data["running"] == false => self.ask = None,
            _ => {}
        }
        if kind == "session-running" && data["running"] == false {
            self.refresh_insights(cx);
        }
        let before = self.transcript.messages.len();
        apply_event(&mut self.transcript, kind, data, now_millis());
        cx.emit(if self.transcript.messages.len() == before { SessionEvent::TailChanged } else { SessionEvent::Reset });
        cx.notify();
    }

    pub fn send(&mut self, input: String, choices: TurnChoices, cx: &mut Context<Self>) {
        let mut params = json!({ "sessionId": self.id, "input": input });
        if let Some(model) = choices.model {
            self.model = Some(model.clone());
            params["model"] = json!(model);
        }
        if let Some(thinking) = choices.thinking {
            params["thinking"] = json!(thinking);
        }
        if let Some(agent) = choices.agent {
            params["agent"] = json!(agent);
        }
        self.call("session.send", params, cx);
    }

    pub fn cancel(&mut self, cx: &mut Context<Self>) {
        self.call("session.cancel", json!({ "sessionId": self.id }), cx);
    }

    /// `answers[i]` answers question `i`; an empty one declines it.
    pub fn answer(&mut self, answers: Vec<Vec<String>>, cx: &mut Context<Self>) {
        let Some(ask) = self.ask.take() else { return };
        let answers: Vec<Value> = answers
            .into_iter()
            .map(|picked| if picked.is_empty() { json!({ "answers": [], "declined": true }) } else { json!({ "answers": picked }) })
            .collect();
        self.call("session.answer", json!({ "sessionId": self.id, "askId": ask.id, "answers": answers }), cx);
        cx.notify();
    }

    /// Fire-and-forget: the effect arrives on the event stream; only a
    /// refusal needs saying.
    fn call(&mut self, method: &'static str, params: Value, cx: &mut Context<Self>) {
        let task = request::<Value>(&self.host, method, params, cx);
        cx.spawn(async move |this, cx| {
            if let Err(error) = task.await {
                this.update(cx, |_, cx| cx.emit(SessionEvent::Error(format!("{error:#}").into())))?;
            }
            anyhow::Ok(())
        })
        .detach();
    }

    /// A request about this session: `sessionId` is added to `params`.
    pub fn request<T: serde::de::DeserializeOwned + Send + 'static>(&self, method: &'static str, mut params: Value, cx: &App) -> gpui::Task<anyhow::Result<T>> {
        params["sessionId"] = json!(self.id);
        request(&self.host, method, params, cx)
    }

    /// Reads the transcript again, after something moved it (a branch).
    pub fn reload(&mut self, cx: &mut Context<Self>) {
        self.load(cx);
    }

    /// Re-reads usage; loop only does this between turns, since the
    /// numbers move constantly while one runs.
    fn refresh_insights(&mut self, cx: &mut Context<Self>) {
        let insights = insights::fetch(&self.host, &self.id, cx);
        cx.spawn(async move |this, cx| {
            let insights = insights.await;
            this.update(cx, |session, cx| {
                session.insights = insights;
                cx.notify();
            })
        })
        .detach();
    }

    /// Summarises the older conversation now (`session.compact`).
    pub fn compact(&mut self, cx: &mut Context<Self>) {
        if self.compacting || self.running() {
            return;
        }
        self.compacting = true;
        self.compact_note = None;
        cx.notify();
        let task = request::<CompactReply>(&self.host, "session.compact", json!({ "sessionId": self.id }), cx);
        cx.spawn(async move |this, cx| {
            let result = task.await;
            this.update(cx, |session, cx| {
                session.compacting = false;
                session.compact_note = match result {
                    Ok(reply) if reply.summary.is_empty() => Some("Nothing to compact yet.".into()),
                    Ok(_) => None,
                    Err(error) => Some(format!("{error:#}").into()),
                };
                session.refresh_insights(cx);
                cx.notify();
            })
        })
        .detach();
    }

    pub fn running(&self) -> bool {
        self.transcript.running
    }
}

fn parse_ask(data: &Value) -> Option<PendingAsk> {
    Some(PendingAsk {
        id: data["askId"].as_str()?.to_string(),
        questions: serde_json::from_value(data["questions"].clone()).ok()?,
    })
}
