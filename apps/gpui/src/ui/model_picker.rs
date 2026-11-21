//! loop's model picker (ModelPickerContent): providers down a 44px sidebar,
//! a search box with a blue underline, and each model as its name over its
//! provider.

use gpui::{
    App, AppContext, Context, Entity, EventEmitter, FocusHandle, Focusable, FontWeight,
    InteractiveElement, IntoElement, ParentElement, Render, SharedString,
    StatefulInteractiveElement, Styled, Window, div, prelude::FluentBuilder, px, uniform_list,
};

use crate::assets::Icon;
use crate::catalog::{Catalog, provider_name};
use crate::theme::ActiveTheme;
use crate::ui::controls::popover;
use crate::ui::icon::{icon, provider_icon};
use crate::ui::text_input::{InputEvent, TextInput};

pub enum PickerEvent {
    Picked(String),
}

const WIDTH: gpui::Pixels = px(360.);
const HEIGHT: gpui::Pixels = px(346.);
const SIDEBAR_WIDTH: gpui::Pixels = px(44.);
/// A 53px row plus loop's 2px separator, so the list stays uniform.
const ROW_HEIGHT: gpui::Pixels = px(55.);

#[derive(Clone)]
struct Row {
    id: String,
    name: String,
    provider: String,
}

pub struct ModelPicker {
    catalog: Entity<Catalog>,
    search: Entity<TextInput>,
    selected: Option<String>,
    /// The provider whose models are listed; searching looks across all.
    provider: Option<String>,
}

impl EventEmitter<PickerEvent> for ModelPicker {}

impl ModelPicker {
    pub fn new(catalog: Entity<Catalog>, cx: &mut Context<Self>) -> Self {
        let search = cx.new(|cx| TextInput::new("Search models...", 1, cx));
        cx.subscribe(&search, |picker, _, event: &InputEvent, cx| match event {
            InputEvent::Changed => cx.notify(),
            InputEvent::Submit => picker.pick_first(cx),
        })
        .detach();
        cx.observe(&catalog, |_, _, cx| cx.notify()).detach();
        Self { catalog, search, selected: None, provider: None }
    }

    /// Opens on the selected model's provider, with an empty search.
    pub fn reset(&mut self, selected: Option<String>, window: &mut Window, cx: &mut Context<Self>) {
        self.provider = selected.as_deref().and_then(|id| self.catalog.read(cx).find(id)).map(|model| model.provider.clone());
        self.selected = selected;
        self.search.update(cx, |search, cx| search.set_text("", cx));
        window.focus(&self.search.focus_handle(cx), cx);
    }

    fn rows(&self, cx: &App) -> Vec<Row> {
        let query = self.search.read(cx).text().to_string();
        let searching = !query.trim().is_empty();
        self.catalog
            .read(cx)
            .search(&query)
            .into_iter()
            .filter(|model| searching || self.provider.as_ref().is_none_or(|provider| &model.provider == provider))
            .map(|model| Row { id: model.id.clone(), name: model.name.clone(), provider: model.provider.clone() })
            .collect()
    }

    /// Providers in the order the catalog lists them, once each.
    fn providers(&self, cx: &App) -> Vec<String> {
        let mut providers: Vec<String> = Vec::new();
        for model in &self.catalog.read(cx).models {
            if !providers.contains(&model.provider) {
                providers.push(model.provider.clone());
            }
        }
        providers
    }

    fn pick_first(&mut self, cx: &mut Context<Self>) {
        if let Some(row) = self.rows(cx).into_iter().next() {
            cx.emit(PickerEvent::Picked(row.id));
        }
    }

    fn render_sidebar(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        div()
            .id("provider-sidebar")
            .w(SIDEBAR_WIDTH)
            .h_full()
            .flex_none()
            .p_1()
            .flex()
            .flex_col()
            .gap_1()
            .bg(gpui::rgba(0xffffff04))
            .overflow_y_scroll()
            .children(self.providers(cx).into_iter().map(|provider| {
                let active = self.provider.as_deref() == Some(provider.as_str());
                let glyph = provider_icon(&provider, px(20.), if active { theme.text } else { theme.muted }).map_or_else(
                    || div().text_sm().text_color(theme.muted).child(provider.chars().next().unwrap_or('?').to_uppercase().to_string()).into_any_element(),
                    IntoElement::into_any_element,
                );
                let pick = provider.clone();
                div()
                    .id(SharedString::from(format!("provider-{provider}")))
                    .relative()
                    .size(px(36.))
                    .flex_none()
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded(px(8.))
                    .cursor_pointer()
                    .hover(|item| item.bg(theme.popover_hover))
                    .child(glyph)
                    // The active bar sits on the sidebar's right edge.
                    .when(active, |item| item.child(div().absolute().right(px(-4.)).top(px(8.)).w(px(3.)).h(px(20.)).rounded_l(px(2.)).bg(theme.primary)))
                    .on_click(cx.listener(move |picker, _, _, cx| {
                        picker.provider = Some(pick.clone());
                        cx.notify();
                    }))
            }))
    }

    fn render_search(&self, focused: bool, cx: &App) -> impl IntoElement {
        let theme = cx.theme();
        div().px_2().pt_2().child(
            div()
                .pb(px(10.))
                .flex()
                .items_center()
                .gap_2()
                .border_b_1()
                .border_color(if focused { theme.primary } else { gpui::rgba(0xffffff0c).into() })
                .child(div().ml(px(-2.)).child(icon(Icon::Search, theme.muted.opacity(0.7))))
                .child(div().flex_1().h(px(26.)).flex().items_center().text_sm().text_color(theme.text).child(self.search.clone())),
        )
    }
}

fn render_rows(rows: &[Row], selected: Option<&str>, cx: &mut Context<ModelPicker>) -> Vec<gpui::AnyElement> {
    let theme = cx.theme();
    rows.iter()
        .map(|row| {
            let id = row.id.clone();
            let is_selected = selected == Some(row.id.as_str());
            div().h(ROW_HEIGHT).pb_0p5().child(
                div()
                    .id(SharedString::from(format!("model-{}", row.id)))
                    .size_full()
                    .p_2()
                    .flex()
                    .flex_col()
                    .justify_center()
                    .gap_1()
                    .rounded(px(8.))
                    .cursor_pointer()
                    .when(is_selected, |item| item.bg(theme.checked))
                    .hover(|item| item.bg(theme.popover_hover))
                    .child(div().truncate().text_xs().line_height(px(16.5)).font_weight(FontWeight::MEDIUM).text_color(theme.text).child(row.name.clone()))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap_1p5()
                            .text_xs()
                            .text_color(theme.muted.opacity(0.7))
                            .children(provider_icon(&row.provider, px(12.), theme.muted.opacity(0.7)))
                            .child(provider_name(&row.provider)),
                    )
                    .on_click(cx.listener(move |_, _, _, cx| cx.emit(PickerEvent::Picked(id.clone())))),
            )
            .into_any_element()
        })
        .collect()
}

impl Focusable for ModelPicker {
    fn focus_handle(&self, cx: &App) -> FocusHandle {
        self.search.focus_handle(cx)
    }
}

impl Render for ModelPicker {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let rows = self.rows(cx);
        let loaded = self.catalog.read(cx).loaded;
        let selected = self.selected.clone();
        let empty = rows.is_empty();
        let focused = self.search.focus_handle(cx).is_focused(window);
        let list = uniform_list("models", rows.len(), cx.processor(move |_, range: std::ops::Range<usize>, _, cx| render_rows(&rows[range], selected.as_deref(), cx)))
            .flex_1()
            .min_h_0()
            .py_1p5()
            .px_2();
        popover(cx).w(WIDTH).h(HEIGHT).flex_row().child(self.render_sidebar(cx)).child(
            div()
                .flex_1()
                .min_w_0()
                .h_full()
                .flex()
                .flex_col()
                .bg(gpui::rgba(0xffffff05))
                .border_l_1()
                .border_color(gpui::rgba(0xffffff0c))
                .child(self.render_search(focused, cx))
                .map(|pane| if empty {
                    pane.child(div().py_6().text_xs().text_center().text_color(theme.muted).child(if loaded { "No models found" } else { "Loading models…" }))
                } else {
                    pane.child(list)
                }),
        )
    }
}
