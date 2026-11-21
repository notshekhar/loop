mod frame;
mod message;
mod rows;
mod status;
mod todos;

use std::collections::HashSet;
use std::time::{Duration, Instant};

use gpui::{
    App, AppContext, Context, Entity, EventEmitter, FocusHandle, Focusable, FollowMode, IntoElement,
    ListAlignment, ListState, ParentElement, Render, SharedString, Styled, Subscription, Task, Window, div,
    list, px,
};
use serde::Deserialize;
use serde_json::json;

use crate::agents::Agents;
use crate::catalog::Catalog;
use crate::host::{LoopHost, request};
use crate::session::{LoadState, Session, SessionEvent, TurnChoices};
use crate::settings::Defaults;
use crate::theme::ActiveTheme;
use crate::ui::ask_panel::{Answered, AskPanel};
use crate::ui::composer::{Composer, ComposerEvent};

/// Raised when a draft's first message created its thread.
pub struct ThreadCreated(pub SharedString);

/// How far past the viewport the transcript list renders ahead.
const OVERDRAW: gpui::Pixels = px(1200.);

/// A thread on screen: its transcript, questions, todos and the composer.
/// Starts as a draft (no session yet) when the user opens a new thread; the
/// first message creates it.
pub struct ConversationView {
    host: Entity<LoopHost>,
    session: Option<Entity<Session>>,
    cwd: String,
    composer: Entity<Composer>,
    ask_panel: Option<Entity<AskPanel>>,
    list: ListState,
    /// Tool rows, runs and thoughts the user opened.
    expanded: HashSet<SharedString>,
    error: Option<SharedString>,
    /// When the running turn started, for the working line's timer.
    turn_started: Option<Instant>,
    /// Repaints the working line every second while a turn runs.
    _ticker: Option<Task<()>>,
    /// The copy button that just copied, showing its check.
    copied: Option<SharedString>,
    _session_subscriptions: Vec<Subscription>,
}

/// The working line's timer moves once a second.
const TICK: Duration = Duration::from_secs(1);
/// A copy button shows its check this long.
const COPIED_FOR: Duration = Duration::from_secs(1);

impl EventEmitter<ThreadCreated> for ConversationView {}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Created {
    session_id: String,
}

/// What every conversation shares with the workspace.
#[derive(Clone)]
pub struct Services {
    pub host: Entity<LoopHost>,
    pub catalog: Entity<Catalog>,
    pub agents: Entity<Agents>,
    pub defaults: Defaults,
}

impl ConversationView {
    pub fn new(
        services: Services,
        session: Option<Entity<Session>>,
        cwd: String,
        model: Option<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let Services { host, catalog, agents, defaults } = services;
        let composer = cx.new(|cx| Composer::new(catalog, agents, model, &defaults, cx));
        cx.subscribe_in(&composer, window, |view, _, event: &ComposerEvent, window, cx| match event {
            ComposerEvent::Send(text) => view.send(text.clone(), window, cx),
            ComposerEvent::Stop => view.stop(cx),
        })
        .detach();
        let list = ListState::new(0, ListAlignment::Top, OVERDRAW);
        list.set_follow_mode(FollowMode::Tail);
        // Re-render on scroll so "Scroll to end" shows and hides.
        let this = cx.entity().downgrade();
        list.set_scroll_handler(move |_, _, cx| {
            let _ = this.update(cx, |_, cx| cx.notify());
        });
        let mut view = Self {
            host,
            session: None,
            cwd,
            composer,
            ask_panel: None,
            list,
            expanded: HashSet::new(),
            error: None,
            turn_started: None,
            _ticker: None,
            copied: None,
            _session_subscriptions: Vec::new(),
        };
        if let Some(session) = session {
            view.attach(session, window, cx);
        }
        window.focus(&view.composer.focus_handle(cx), cx);
        view
    }

    fn attach(&mut self, session: Entity<Session>, window: &mut Window, cx: &mut Context<Self>) {
        self._session_subscriptions = vec![
            cx.subscribe_in(&session, window, |view, session, event: &SessionEvent, window, cx| view.on_session_event(session, event, window, cx)),
            cx.observe_in(&session, window, |view, session, window, cx| view.sync_with(&session, window, cx)),
        ];
        self.list.reset(session.read(cx).transcript.messages.len());
        self.session = Some(session.clone());
        self.sync_with(&session, window, cx);
    }

    fn on_session_event(&mut self, session: &Entity<Session>, event: &SessionEvent, _: &mut Window, cx: &mut Context<Self>) {
        let count = session.read(cx).transcript.messages.len();
        match event {
            SessionEvent::Reset => {
                self.list.reset(count);
                self.list.scroll_to_end();
            }
            SessionEvent::TailChanged if count > 0 => self.list.splice(count - 1..count, 1),
            SessionEvent::TailChanged => {}
            SessionEvent::Error(error) => self.error = Some(error.clone()),
        }
        cx.notify();
    }

    /// Mirrors what the session says into the composer and question panel.
    fn sync_with(&mut self, session: &Entity<Session>, window: &mut Window, cx: &mut Context<Self>) {
        let (running, ask, model, cwd) = {
            let session = session.read(cx);
            (session.running(), session.ask.clone(), session.model.clone(), session.cwd.clone())
        };
        if !cwd.is_empty() {
            self.cwd = cwd;
        }
        self.track_turn(running, cx);
        self.composer.update(cx, |composer, cx| {
            composer.set_running(running, cx);
            composer.set_model_if_unset(model, cx);
        });
        let showing = self.ask_panel.as_ref().map(|panel| panel.read(cx).ask_id().to_string());
        match ask {
            Some(ask) if showing.as_deref() != Some(ask.id.as_str()) => {
                let panel = cx.new(|cx| AskPanel::new(ask, window, cx));
                cx.subscribe_in(&panel, window, |view, _, Answered(answers), window, cx| {
                    if let Some(session) = &view.session {
                        session.update(cx, |session, cx| session.answer(answers.clone(), cx));
                    }
                    view.ask_panel = None;
                    window.focus(&view.composer.focus_handle(cx), cx);
                    cx.notify();
                })
                .detach();
                self.ask_panel = Some(panel);
            }
            None if showing.is_some() => self.ask_panel = None,
            _ => {}
        }
        cx.notify();
    }

    /// Starts the working line's clock when a turn starts, stops it when
    /// the turn ends.
    fn track_turn(&mut self, running: bool, cx: &mut Context<Self>) {
        if running == self.turn_started.is_some() {
            return;
        }
        if !running {
            self.turn_started = None;
            self._ticker = None;
            return;
        }
        self.turn_started = Some(Instant::now());
        self._ticker = Some(cx.spawn(async move |view, cx| {
            loop {
                cx.background_executor().timer(TICK).await;
                if view.update(cx, |_, cx| cx.notify()).is_err() {
                    break;
                }
            }
        }));
    }

    fn show_copied(&mut self, id: SharedString, cx: &mut Context<Self>) {
        self.copied = Some(id.clone());
        cx.notify();
        cx.spawn(async move |view, cx| {
            cx.background_executor().timer(COPIED_FOR).await;
            view.update(cx, |view, cx| {
                if view.copied.as_ref() == Some(&id) {
                    view.copied = None;
                    cx.notify();
                }
            })
        })
        .detach();
    }

    fn send(&mut self, text: String, window: &mut Window, cx: &mut Context<Self>) {
        self.error = None;
        let choices = self.composer.read(cx).choices();
        if let Some(session) = &self.session {
            session.update(cx, |session, cx| session.send(text, choices, cx));
            return;
        }
        self.create_then_send(text, choices, window, cx);
    }

    /// A draft's first message: create the thread in this folder, open it,
    /// then send.
    fn create_then_send(&mut self, text: String, choices: TurnChoices, window: &mut Window, cx: &mut Context<Self>) {
        let mut params = json!({ "cwd": self.cwd });
        if let Some(model) = &choices.model {
            params["model"] = json!(model);
            params["provider"] = json!(model.split('/').next().unwrap_or_default());
        }
        let created = request::<Created>(&self.host, "session.create", params, cx);
        let host = self.host.clone();
        cx.spawn_in(window, async move |view, cx| {
            let created = created.await;
            view.update_in(cx, |view, window, cx| match created {
                Ok(Created { session_id }) => {
                    let session = Session::open(session_id.clone(), host, cx);
                    session.update(cx, |session, cx| session.send(text, choices, cx));
                    view.attach(session, window, cx);
                    cx.emit(ThreadCreated(session_id.into()));
                }
                Err(error) => {
                    view.error = Some(format!("Couldn't start the thread: {error:#}").into());
                    cx.notify();
                }
            })
        })
        .detach();
    }

    fn stop(&mut self, cx: &mut Context<Self>) {
        if let Some(session) = &self.session {
            session.update(cx, |session, cx| session.cancel(cx));
        }
    }

    pub fn cwd(&self) -> &str {
        &self.cwd
    }

    pub fn session_id(&self, cx: &App) -> Option<String> {
        self.session.as_ref().map(|session| session.read(cx).id.clone())
    }

    /// Puts `text` in the composer, ready to edit and send.
    pub fn set_draft(&mut self, text: String, cx: &mut Context<Self>) {
        self.composer.update(cx, |composer, cx| composer.set_text(text, cx));
    }

    pub fn session(&self) -> Option<&Entity<Session>> {
        self.session.as_ref()
    }

    fn toggle(&mut self, key: SharedString, cx: &mut Context<Self>) {
        if !self.expanded.remove(&key) {
            self.expanded.insert(key);
        }
        // Rows change height when they open; every visible one re-measures.
        self.list.remeasure();
        cx.notify();
    }

    fn running(&self, cx: &App) -> bool {
        self.session.as_ref().is_some_and(|session| session.read(cx).running())
    }

    fn render_transcript(&mut self, cx: &mut Context<Self>) -> gpui::AnyElement {
        let view = cx.entity().downgrade();
        list(self.list.clone(), move |ix, _, cx| {
            view.upgrade()
                .and_then(|view| {
                    view.update(cx, |view, cx| {
                        let session = view.session.clone()?;
                        let session = session.read(cx);
                        let count = session.transcript.messages.len();
                        let message = session.transcript.messages.get(ix)?.clone();
                        Some(view.render_message(&message, ix + 1 == count, cx))
                    })
                })
                .unwrap_or_else(|| div().into_any_element())
        })
        .flex_1()
        .min_h_0()
        .into_any_element()
    }
}

/// Focusing a conversation puts the cursor in its composer.
impl Focusable for ConversationView {
    fn focus_handle(&self, cx: &App) -> FocusHandle {
        self.composer.focus_handle(cx)
    }
}

impl Render for ConversationView {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let load = self.session.as_ref().map(|session| session.read(cx).load.clone());
        let empty = self.session.as_ref().is_none_or(|session| session.read(cx).transcript.messages.is_empty());
        let base = div().size_full().flex().flex_col().bg(theme.background);
        match load {
            Some(LoadState::Failed(error)) => base
                .items_center()
                .justify_center()
                .text_sm()
                .text_color(theme.error)
                .child(format!("Couldn't open this thread: {error}")),
            Some(LoadState::Loading) => base.items_center().justify_center().text_sm().text_color(theme.muted).child("Loading…"),
            // A draft: the headline over the composer, centred on the page.
            _ if empty => base.justify_center().children(self.render_error_banner(cx)).child(self.render_draft_hero(cx)).child(self.render_dock(false, cx)),
            _ => base
                .children(self.render_error_banner(cx))
                .child(div().h(px(16.)))
                .child(self.render_transcript(cx))
                .child(self.render_dock(true, cx)),
        }
    }
}
