//! loop's SessionTreeDialog ("Branches"): every entry of the session as a
//! tree. "Go here" moves this session's leaf back to an entry; "Fork"
//! copies the branch into a new session.

use gpui::{
    AnyElement, App, AppContext, Context, Entity, EventEmitter, FocusHandle, Focusable,
    FontWeight, InteractiveElement, IntoElement, ParentElement, Render, SharedString,
    StatefulInteractiveElement, Styled, Window, div, prelude::FluentBuilder, px, uniform_list,
};
use serde::Deserialize;
use serde_json::json;

use crate::assets::Icon;
use crate::session::Session;
use crate::theme::ActiveTheme;
use crate::tree::{FilterMode, TreeRow, TreeView, filter_rows, row_summary, tree_summary};
use crate::ui::controls::tooltip;
use crate::ui::format::clock;
use crate::ui::icon::icon;
use crate::ui::text_input::{InputEvent, TextInput};

const WIDTH: f32 = 768.;
const INDENT_STEP: f32 = 18.;
/// Two lines (13px summary, 11px meta) plus padding: uniform, so the list
/// can be virtualised.
const ROW_HEIGHT: f32 = 44.;
const LIST_HEIGHT: f32 = 440.;

pub enum TreeDialogEvent {
    Close,
    /// How many branch points the tree has, for the header's count.
    Loaded(usize),
    /// A fork was made: open it, with this prompt back in its composer.
    Forked { session_id: String, prompt: Option<String> },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ForkReply {
    session_id: String,
    #[serde(default)]
    text: Option<String>,
}

pub struct TreeDialog {
    session: Entity<Session>,
    cwd: String,
    view: Option<TreeView>,
    loading: bool,
    mode: FilterMode,
    search: Entity<TextInput>,
    busy: bool,
    error: Option<SharedString>,
}

impl EventEmitter<TreeDialogEvent> for TreeDialog {}

impl TreeDialog {
    pub fn new(session: Entity<Session>, cwd: String, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let search = cx.new(|cx| TextInput::new("Search prompts, replies, commands…", 1, cx));
        cx.subscribe(&search, |_, _, _: &InputEvent, cx| cx.notify()).detach();
        window.focus(&search.focus_handle(cx), cx);
        let mut dialog = Self { session, cwd, view: None, loading: true, mode: FilterMode::Default, search, busy: false, error: None };
        dialog.load(cx);
        dialog
    }

    fn load(&mut self, cx: &mut Context<Self>) {
        self.loading = true;
        let task = self.session.read(cx).request::<TreeView>("session.tree", json!({}), cx);
        cx.spawn(async move |this, cx| {
            let view = task.await.ok();
            this.update(cx, |dialog, cx| {
                cx.emit(TreeDialogEvent::Loaded(view.as_ref().map_or(0, |view| view.branch_point_ids.len())));
                dialog.view = view;
                dialog.loading = false;
                cx.notify();
            })
        })
        .detach();
    }

    fn go_to(&mut self, entry: String, cx: &mut Context<Self>) {
        self.busy = true;
        self.error = None;
        let task = self.session.read(cx).request::<serde_json::Value>("session.branch", json!({ "entryId": entry }), cx);
        let session = self.session.clone();
        cx.spawn(async move |this, cx| {
            let result = task.await;
            this.update(cx, |dialog, cx| {
                dialog.busy = false;
                match result {
                    Ok(_) => {
                        session.update(cx, |session, cx| session.reload(cx));
                        cx.emit(TreeDialogEvent::Close);
                    }
                    Err(error) => {
                        dialog.error = Some(format!("{error:#}").into());
                        dialog.load(cx);
                    }
                }
                cx.notify();
            })
        })
        .detach();
    }

    /// Forks before a prompt (its text goes back in the composer), at
    /// anything else.
    fn fork(&mut self, row: &TreeRow, cx: &mut Context<Self>) {
        self.busy = true;
        self.error = None;
        let position = if row.role.as_deref() == Some("user") { "before" } else { "at" };
        let task = self.session.read(cx).request::<ForkReply>("session.fork", json!({ "entryId": row.id, "position": position }), cx);
        cx.spawn(async move |this, cx| {
            let result = task.await;
            this.update(cx, |dialog, cx| {
                dialog.busy = false;
                match result {
                    Ok(forked) => cx.emit(TreeDialogEvent::Forked { session_id: forked.session_id, prompt: forked.text }),
                    Err(error) => dialog.error = Some(format!("{error:#}").into()),
                }
                cx.notify();
            })
        })
        .detach();
    }

    fn render_toolbar(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let search = div()
            .flex_1()
            .min_w(px(192.))
            .h(px(32.))
            .px_2p5()
            .flex()
            .items_center()
            .gap_2()
            .rounded(px(8.))
            .border_1()
            .border_color(theme.input_border)
            .bg(gpui::rgba(0xffffff0a))
            .text_sm()
            .child(icon(Icon::Search, theme.muted.opacity(0.6)).size(px(14.)))
            .child(div().flex_1().child(self.search.clone()));
        let pills = FilterMode::ALL.map(|mode| {
            let active = mode == self.mode;
            div()
                .id(mode.label())
                .px_2p5()
                .py_1()
                .rounded_full()
                .border_1()
                .text_size(px(11.))
                .cursor_pointer()
                .map(|pill| if active { pill.border_color(theme.border).bg(theme.hover).text_color(theme.text) } else { pill.border_color(gpui::transparent_black()).text_color(theme.muted).hover(|pill| pill.bg(gpui::rgba(0xffffff07)).text_color(theme.text)) })
                .child(mode.label())
                .tooltip(tooltip(mode.hint()))
                .on_click(cx.listener(move |dialog, _, _, cx| {
                    dialog.mode = mode;
                    cx.notify();
                }))
        });
        div().pt_1().flex().flex_wrap().items_center().gap_2().child(search).child(div().flex_none().flex().items_center().gap_1().children(pills))
    }

    fn render_rows(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme();
        let Some(view) = &self.view else {
            let note = if self.loading { "Reading the tree…" } else { "This loop does not report a session tree." };
            return div().py_6().text_center().text_sm().text_color(theme.muted).child(note).into_any_element();
        };
        let query = self.search.read(cx).text().to_string();
        let rows = filter_rows(view, self.mode, &query);
        if rows.is_empty() {
            let note = if query.trim().is_empty() { "Nothing here yet — send a message first." } else { "No matches." };
            return div().py_6().text_center().text_sm().text_color(theme.muted).child(note).into_any_element();
        }
        let leaf = view.leaf_id.clone();
        let running = self.session.read(cx).running();
        uniform_list("tree-rows", rows.len(), cx.processor(move |dialog, range: std::ops::Range<usize>, _, cx| {
            rows[range].iter().map(|row| dialog.render_row(row, leaf.as_deref() == Some(row.id.as_str()), running, cx)).collect()
        }))
        .h(px(LIST_HEIGHT))
        .into_any_element()
    }

    fn render_row(&self, row: &TreeRow, is_leaf: bool, running: bool, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme();
        let glyph = match (row.kind.as_str(), row.role.as_deref()) {
            ("compact", _) => Icon::Scissors,
            ("branch-summary", _) => Icon::Sparkles,
            (_, Some("user")) => Icon::User,
            (_, Some("tool")) => Icon::Wrench,
            _ => Icon::MessageSquare,
        };
        let group: SharedString = format!("tree-{}", row.id).into();
        let mut meta = format!("{} · {}", row.role.clone().unwrap_or_else(|| row.kind.clone()), clock(row.ts));
        if row.child_count > 1 {
            meta.push_str(&format!(" · forks {} ways", row.child_count));
        }
        if row.interrupted {
            meta.push_str(" · interrupted");
        }
        let (entry, forked) = (row.id.clone(), row.clone());
        let action = |id: String, glyph: Icon, label: &'static str, hint: &'static str| {
            div()
                .id(SharedString::from(id))
                .h(px(28.))
                .px_2()
                .flex()
                .items_center()
                .gap_1p5()
                .rounded(px(8.))
                .text_xs()
                .text_color(theme.text)
                .cursor_pointer()
                .hover(|button| button.bg(theme.hover))
                .child(icon(glyph, theme.text).size(px(14.)))
                .child(label)
                .tooltip(tooltip(hint))
        };
        let can_go = !is_leaf && !running && !self.busy;
        div().h(px(ROW_HEIGHT)).py_0p5().child(
            div()
                .id(SharedString::from(format!("tree-row-{}", row.id)))
                .group(group.clone())
                .h_full()
                .ml(px(row.indent as f32 * INDENT_STEP))
                .pl_2()
                .pr_1()
                .flex()
                .items_center()
                .gap_2()
                .rounded(px(8.))
                .map(|line| if is_leaf { line.bg(gpui::rgba(0xffffff09)) } else { line.hover(|line| line.bg(gpui::rgba(0xffffff04))) })
                .child(div().w_2().h_full().flex_none().when(row.branch_start, |rail| rail.border_l_1().border_color(theme.border.opacity(0.7))))
                .child(icon(glyph, if row.on_path { theme.muted.opacity(0.8) } else { theme.muted.opacity(0.35) }).size(px(14.)))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .text_size(px(13.))
                                .text_color(if row.on_path { theme.text.opacity(0.9) } else { theme.muted.opacity(0.6) })
                                .when_some(row.label.clone(), |line, label| line.child(div().mr_1p5().px_1().rounded(px(4.)).bg(theme.warning.opacity(0.15)).text_size(px(10.)).text_color(theme.warning).child(label)))
                                .child(div().truncate().child(row_summary(row, &self.cwd))),
                        )
                        .child(div().text_size(px(11.)).text_color(theme.muted.opacity(0.5)).child(meta)),
                )
                .when(is_leaf, |line| line.child(div().pr_1().flex().items_center().gap_1().text_size(px(11.)).text_color(theme.muted.opacity(0.7)).child(icon(Icon::Check, theme.muted.opacity(0.7)).size(px(12.))).child("here")))
                .child(
                    div()
                        .flex_none()
                        .flex()
                        .items_center()
                        .gap_1()
                        .invisible()
                        .group_hover(group, |actions| actions.visible())
                        .when(can_go, |actions| {
                            actions.child(action(format!("go-{}", row.id), Icon::CornerUpLeft, "Go here", "Move this conversation back to here").on_click(cx.listener(move |dialog, _, _, cx| dialog.go_to(entry.clone(), cx))))
                        })
                        .when(!self.busy, |actions| {
                            actions.child(action(format!("fork-{}", row.id), Icon::GitBranch, "Fork", "Copy this branch into a new session").on_click(cx.listener(move |dialog, _, _, cx| dialog.fork(&forked, cx))))
                        }),
                ),
        )
        .into_any_element()
    }

    fn render_footer(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let summary = if self.session.read(cx).running() {
            "A turn is running — finish or stop it before moving the branch.".to_string()
        } else {
            self.view.as_ref().map(|view| {
                let shown = filter_rows(view, self.mode, self.search.read(cx).text()).len();
                let mut summary = tree_summary(view);
                if shown != view.rows.len() {
                    summary.push_str(&format!(" · showing {shown}"));
                }
                summary
            }).unwrap_or_default()
        };
        div()
            .px_6()
            .py_4()
            .flex()
            .items_center()
            .justify_between()
            .border_t_1()
            .border_color(theme.border)
            .child(div().text_xs().text_color(theme.muted.opacity(0.7)).child(summary))
            .child(
                div()
                    .id("tree-close")
                    .h(px(28.))
                    .px_3()
                    .flex()
                    .items_center()
                    .rounded(px(8.))
                    .border_1()
                    .border_color(theme.input_border)
                    .bg(gpui::rgba(0xffffff0a))
                    .text_sm()
                    .text_color(theme.text)
                    .cursor_pointer()
                    .hover(|button| button.bg(gpui::rgba(0xffffff14)))
                    .child("Close")
                    .on_click(cx.listener(|_, _, _, cx| cx.emit(TreeDialogEvent::Close))),
            )
    }
}

impl Focusable for TreeDialog {
    fn focus_handle(&self, cx: &App) -> FocusHandle {
        self.search.focus_handle(cx)
    }
}

impl Render for TreeDialog {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        div()
            .id("tree-dialog")
            .w(px(WIDTH))
            .max_w_full()
            .flex()
            .flex_col()
            .rounded(px(16.))
            .border_1()
            .border_color(theme.border)
            .bg(theme.card)
            .shadow_lg()
            .overflow_hidden()
            .on_mouse_down(gpui::MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .child(
                div()
                    .px_6()
                    .pt_6()
                    .pb_3()
                    .flex()
                    .flex_col()
                    .gap_2()
                    .child(div().text_lg().font_weight(FontWeight::SEMIBOLD).text_color(theme.text).child("Branches"))
                    .child(div().text_sm().text_color(theme.muted).child(
                        "Go here moves this conversation back to that point — everything after it stays, it just stops being what the model sees. Fork copies the branch into a new session and leaves this one alone.",
                    ))
                    .child(self.render_toolbar(cx)),
            )
            .child(div().px_6().pb_2().child(self.render_rows(cx)).when_some(self.error.clone(), |panel, error| panel.child(div().pt_2().text_xs().text_color(theme.error).child(error))))
            .child(self.render_footer(cx))
    }
}
