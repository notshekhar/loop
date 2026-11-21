//! loop's message box (ChatComposer): the text box with ↵ inside it, and
//! under it the model, thinking and agent pickers the next turn runs with.

use gpui::{
    AnyElement, App, AppContext, Context, Entity, EventEmitter, FocusHandle, Focusable,
    InteractiveElement, IntoElement, KeyBinding, ParentElement, Render, SharedString,
    StatefulInteractiveElement, Styled, Window, actions, anchored, deferred, div,
    prelude::FluentBuilder, px, relative,
};

use crate::agents::Agents;
use crate::assets::Icon;
use crate::catalog::{Catalog, short_name};
use crate::session::TurnChoices;
use crate::settings::Defaults;
use crate::theme::{ActiveTheme, PROSE_LINE_HEIGHT};
use crate::ui::controls::{menu, menu_button, menu_row, vertical_divider};
use crate::ui::effort::{effort_slider, level_label};
use crate::ui::icon::{icon, provider_icon};
use crate::ui::model_picker::{ModelPicker, PickerEvent};
use crate::ui::text_input::{InputEvent, TextInput};

actions!(composer, [CloseMenu, Stop]);

const CONTEXT: &str = "Composer";
/// The editor grows to 240px (loop's max-h-60) — about ten lines — then
/// scrolls.
const MAX_LINES: usize = 10;
/// A turn with no thinking setting anywhere: loop's own default.
const FALLBACK_THINKING: &str = "medium";
/// The agent every turn runs as unless another is picked.
const DEFAULT_AGENT: &str = "default";

pub fn bind_keys(cx: &mut App) {
    cx.bind_keys([KeyBinding::new("escape", CloseMenu, Some(CONTEXT)), KeyBinding::new("ctrl-c", Stop, Some(CONTEXT))]);
}

pub enum ComposerEvent {
    Send(String),
    Stop,
}

#[derive(Clone, Copy, PartialEq)]
enum Menu {
    Model,
    Thinking,
    Agent,
}

/// Owns no session; its owner turns its events into turns.
pub struct Composer {
    input: Entity<TextInput>,
    catalog: Entity<Catalog>,
    agents: Entity<Agents>,
    picker: Entity<ModelPicker>,
    model: Option<String>,
    thinking: &'static str,
    agent: Option<String>,
    running: bool,
    menu: Option<Menu>,
}

impl EventEmitter<ComposerEvent> for Composer {}

impl Composer {
    pub fn new(catalog: Entity<Catalog>, agents: Entity<Agents>, model: Option<String>, defaults: &Defaults, cx: &mut Context<Self>) -> Self {
        let input = cx.new(|cx| TextInput::new("Ask for follow-up changes or attach images", MAX_LINES, cx));
        cx.subscribe(&input, |composer, _, event: &InputEvent, cx| match event {
            InputEvent::Submit => composer.submit(cx),
            InputEvent::Changed => cx.notify(),
        })
        .detach();
        let picker = cx.new(|cx| ModelPicker::new(catalog.clone(), cx));
        cx.subscribe(&picker, |composer, _, PickerEvent::Picked(id), cx| {
            composer.model = Some(id.clone());
            composer.menu = None;
            cx.notify();
        })
        .detach();
        cx.observe(&catalog, |_, _, cx| cx.notify()).detach();
        cx.observe(&agents, |_, _, cx| cx.notify()).detach();
        Self {
            input,
            catalog,
            agents,
            picker,
            model,
            thinking: defaults.thinking.unwrap_or(FALLBACK_THINKING),
            agent: defaults.agent.clone(),
            running: false,
            menu: None,
        }
    }

    pub fn choices(&self) -> TurnChoices {
        TurnChoices { model: self.model.clone(), thinking: Some(self.thinking), agent: self.agent.clone() }
    }

    pub fn set_running(&mut self, running: bool, cx: &mut Context<Self>) {
        if self.running != running {
            self.running = running;
            cx.notify();
        }
    }

    pub fn set_model_if_unset(&mut self, model: Option<String>, cx: &mut Context<Self>) {
        if self.model.is_none() && model.is_some() {
            self.model = model;
            cx.notify();
        }
    }

    pub fn set_text(&mut self, text: String, cx: &mut Context<Self>) {
        self.input.update(cx, |input, cx| input.set_text(text, cx));
    }

    fn focus(&self, window: &mut Window, cx: &mut App) {
        window.focus(&self.input.focus_handle(cx), cx);
    }

    fn submit(&mut self, cx: &mut Context<Self>) {
        let text = self.input.read(cx).text().trim().to_string();
        if text.is_empty() {
            return;
        }
        self.input.update(cx, |input, cx| input.set_text("", cx));
        cx.emit(ComposerEvent::Send(text));
    }

    fn primary_action(&mut self, cx: &mut Context<Self>) {
        if self.running && self.input.read(cx).text().trim().is_empty() {
            cx.emit(ComposerEvent::Stop);
        } else {
            self.submit(cx);
        }
    }

    fn toggle_menu(&mut self, menu: Menu, window: &mut Window, cx: &mut Context<Self>) {
        self.menu = if self.menu == Some(menu) { None } else { Some(menu) };
        if self.menu == Some(Menu::Model) {
            let selected = self.model.clone();
            self.picker.update(cx, |picker, cx| picker.reset(selected, window, cx));
        } else {
            self.focus(window, cx);
        }
        cx.notify();
    }

    fn close_menu(&mut self, _: &CloseMenu, window: &mut Window, cx: &mut Context<Self>) {
        if self.menu.take().is_some() {
            self.focus(window, cx);
            cx.notify();
        }
    }

    fn stop(&mut self, _: &Stop, _: &mut Window, cx: &mut Context<Self>) {
        if self.running {
            cx.emit(ComposerEvent::Stop);
        }
    }

    /// Whether the chosen model can think; unknown (catalog still loading)
    /// counts as yes so the control does not flicker away.
    fn model_reasons(&self, cx: &App) -> bool {
        let catalog = self.catalog.read(cx);
        self.model.as_deref().and_then(|id| catalog.find(id)).is_none_or(|model| model.reasoning)
    }

    fn model_label(&self, cx: &App) -> String {
        let Some(id) = &self.model else { return "Pick a model".into() };
        self.catalog.read(cx).find(id).map_or_else(|| short_name(id).to_string(), |model| model.name.clone())
    }

    fn agent_name(&self) -> &str {
        self.agent.as_deref().unwrap_or(DEFAULT_AGENT)
    }

    fn render_box(&self, focused: bool, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        div()
            .w_full()
            .rounded(px(14.))
            .border_1()
            .border_color(if focused { theme.primary.opacity(0.55) } else { theme.border })
            .bg(theme.card)
            .child(
                div()
                    .px(px(14.))
                    .py_2()
                    .flex()
                    .items_end()
                    .gap_2()
                    .child(div().flex_1().min_w_0().py_0p5().text_sm().line_height(relative(PROSE_LINE_HEIGHT)).text_color(theme.text).child(self.input.clone()))
                    .child(div().mr(px(-6.)).pb(px(1.)).child(self.render_send(cx))),
            )
    }

    /// ↵ when there is text, a stop square while a turn runs, a faint ↵
    /// otherwise (loop's ComposerPrimaryActions).
    fn render_send(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let has_text = !self.input.read(cx).text().trim().is_empty();
        let stopping = self.running && !has_text;
        let filled = has_text || stopping;
        let glyph = if stopping {
            div().size(px(7.)).rounded(px(1.25)).bg(theme.background).into_any_element()
        } else {
            icon(Icon::CornerDownLeft, if filled { theme.background } else { theme.muted.opacity(0.6) }).size(px(13.)).into_any_element()
        };
        div()
            .id("send")
            .size(px(24.))
            .flex()
            .items_center()
            .justify_center()
            .rounded(px(8.))
            .when(filled, |button| button.bg(theme.text).cursor_pointer().hover(|button| button.bg(theme.text.opacity(0.85))))
            .child(glyph)
            .on_click(cx.listener(|composer, _, _, cx| composer.primary_action(cx)))
    }

    fn render_toolbar(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let provider = self.model.as_deref().and_then(|id| id.split('/').next()).unwrap_or_default();
        let logo = provider_icon(provider, px(14.), theme.muted.opacity(0.7)).map(IntoElement::into_any_element);
        let model = menu_button("model", logo, self.model_label(cx), self.menu == Some(Menu::Model), cx)
            .pl_0()
            .ml(px(-1.))
            .max_w(px(224.))
            .on_click(cx.listener(|composer, _, window, cx| composer.toggle_menu(Menu::Model, window, cx)));
        let thinking = self.model_reasons(cx).then(|| {
            menu_button("thinking", None, level_label(self.thinking), self.menu == Some(Menu::Thinking), cx)
                .on_click(cx.listener(|composer, _, window, cx| composer.toggle_menu(Menu::Thinking, window, cx)))
        });
        let agent_label = match self.agent_name() {
            DEFAULT_AGENT => "Agent".to_string(),
            name => name.to_string(),
        };
        let agent = (self.agents.read(cx).names.len() >= 2).then(|| {
            menu_button("agent", Some(icon(Icon::Bot, theme.muted.opacity(0.7)).size(px(14.)).into_any_element()), agent_label, self.menu == Some(Menu::Agent), cx)
                .on_click(cx.listener(|composer, _, window, cx| composer.toggle_menu(Menu::Agent, window, cx)))
        });
        div()
            .px_1()
            .pt_1p5()
            .flex()
            .items_center()
            .gap_1()
            .child(self.with_menu(Menu::Model, model, cx))
            .when_some(thinking, |row, thinking| row.child(vertical_divider(theme.border)).child(self.with_menu(Menu::Thinking, thinking, cx)))
            .when_some(agent, |row, agent| row.child(self.with_menu(Menu::Agent, agent, cx)))
    }

    /// A trigger, and its menu when open: above it, 4px up, left edges
    /// aligned (loop's `side="top" align="start"`).
    fn with_menu(&self, which: Menu, trigger: impl IntoElement, cx: &mut Context<Self>) -> AnyElement {
        let menu = (self.menu == Some(which)).then(|| match which {
            Menu::Model => self.picker.clone().into_any_element(),
            Menu::Thinking => self.render_thinking_menu(cx),
            Menu::Agent => self.render_agent_menu(cx),
        });
        div()
            .relative()
            .child(trigger)
            .when_some(menu, |anchor, menu| {
                anchor.child(div().absolute().top_0().left_0().child(deferred(anchored().anchor(gpui::Anchor::BottomLeft).child(div().mb_1().child(menu))).with_priority(1)))
            })
            .into_any_element()
    }

    fn render_thinking_menu(&self, cx: &mut Context<Self>) -> AnyElement {
        let composer = cx.entity().downgrade();
        effort_slider(self.thinking, cx, move |level, window, cx| {
            let _ = composer.update(cx, |composer, cx| {
                composer.thinking = level;
                composer.menu = None;
                composer.focus(window, cx);
                cx.notify();
            });
        })
        .into_any_element()
    }

    fn render_agent_menu(&self, cx: &mut Context<Self>) -> AnyElement {
        let current = self.agent_name().to_string();
        let names = self.agents.read(cx).names.clone();
        let composer = cx.entity().downgrade();
        menu(cx)
            .children(names.into_iter().map(|name| {
                let composer = composer.clone();
                let label = if name == DEFAULT_AGENT { "Default".to_string() } else { name.clone() };
                let picked = name.clone();
                menu_row(SharedString::from(format!("agent-{name}")), None, label, name == current, cx, move |_, window, cx| {
                    let picked = picked.clone();
                    let _ = composer.update(cx, |composer, cx| {
                        composer.agent = Some(picked);
                        composer.menu = None;
                        composer.focus(window, cx);
                        cx.notify();
                    });
                })
            }))
            .into_any_element()
    }
}

impl Focusable for Composer {
    fn focus_handle(&self, cx: &App) -> FocusHandle {
        self.input.focus_handle(cx)
    }
}

impl Render for Composer {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let focused = self.input.focus_handle(cx).is_focused(window);
        div()
            .key_context(CONTEXT)
            .on_action(cx.listener(Self::close_menu))
            .on_action(cx.listener(Self::stop))
            .w_full()
            .flex()
            .flex_col()
            .child(self.render_box(focused, cx))
            .child(self.render_toolbar(cx))
    }
}
