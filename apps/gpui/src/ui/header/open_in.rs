//! loop's OpenInPicker: "Open" in the preferred editor, and a chevron
//! listing every installed one. Whichever is used becomes the preference.

use gpui::{
    AnyElement, Context, InteractiveElement, IntoElement, ParentElement, SharedString,
    StatefulInteractiveElement, Styled, div, prelude::FluentBuilder, px,
};

use super::{Header, Menu};
use crate::assets::Icon;
use crate::editors::Editor;
use crate::prefs;
use crate::theme::ActiveTheme;
use crate::ui::controls::{menu, menu_row, tooltip};
use crate::ui::icon::icon;

/// Outline control fills: loop's `input/32`, and `input/64` on hover.
pub(super) const OUTLINE_FILL: u32 = 0xffffff0a;
pub(super) const OUTLINE_HOVER: u32 = 0xffffff14;

fn editor_icon(editor: &Editor, cx: &Context<Header>) -> gpui::Svg {
    let theme = cx.theme();
    if editor.id == "file-manager" { icon(Icon::FolderClosed, theme.muted) } else { icon(Icon::Box, theme.text) }
}

impl Header {
    fn preferred(&self) -> Option<&'static Editor> {
        self.editors.preferred(self.prefs.last_editor.as_deref())
    }

    /// Opens the folder on screen in `editor` and remembers the choice.
    fn open_in(&mut self, editor: &'static Editor, cx: &mut Context<Self>) {
        self.menu = None;
        let Some(cwd) = self.cwd(cx) else { return };
        if let Err(error) = self.editors.launch(editor, &cwd) {
            eprintln!("loop-gpui: couldn't open {cwd} in {}: {error}", editor.label);
            return;
        }
        self.prefs.last_editor = Some(editor.id.to_string());
        if let Some(path) = prefs::default_path() {
            let _ = self.prefs.save(&path);
        }
        cx.notify();
    }

    /// ⌘O.
    pub fn open_preferred(&mut self, cx: &mut Context<Self>) {
        if let Some(editor) = self.preferred() {
            self.open_in(editor, cx);
        }
    }

    pub(super) fn render_open_in(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        self.cwd(cx)?;
        let theme = cx.theme();
        let preferred = self.preferred();
        let main = div()
            .id("open-in")
            .h_full()
            .pl(px(8.5))
            .pr_2()
            .flex()
            .items_center()
            .gap_1()
            .text_xs()
            .text_color(theme.text)
            .map(|button| match preferred {
                Some(editor) => button
                    .cursor_pointer()
                    .hover(|button| button.bg(gpui::rgba(OUTLINE_HOVER)))
                    .tooltip(tooltip(format!("Open in {} (⌘O)", editor.label)))
                    .child(editor_icon(editor, cx).size(px(14.)))
                    .on_click(cx.listener(move |header, _, _, cx| header.open_in(editor, cx))),
                None => button.opacity(0.64).child(icon(Icon::Box, theme.text).size(px(14.))),
            })
            .child("Open");
        let chevron = div()
            .id("open-in-menu")
            .size(px(24.))
            .flex()
            .items_center()
            .justify_center()
            .border_l_1()
            .border_color(theme.input_border)
            .cursor_pointer()
            .hover(|button| button.bg(gpui::rgba(OUTLINE_HOVER)))
            .child(icon(Icon::ChevronDown, theme.text).size(px(16.)))
            .on_click(cx.listener(|header, _, _, cx| header.toggle_menu(Menu::OpenIn, cx)));
        let group = div()
            .h(px(24.))
            .flex()
            .overflow_hidden()
            .rounded(px(8.))
            .border_1()
            .border_color(theme.input_border)
            .bg(gpui::rgba(OUTLINE_FILL))
            .child(main)
            .child(chevron);
        let popover = (self.menu == Some(Menu::OpenIn)).then(|| self.render_open_in_menu(cx));
        Some(super::actions::anchor_below_end(group, popover))
    }

    fn render_open_in_menu(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme();
        let preferred = self.preferred().map(|editor| editor.id);
        let header = cx.entity().downgrade();
        let rows: Vec<AnyElement> = self
            .editors
            .editors()
            .map(|editor| {
                let shortcut = (Some(editor.id) == preferred).then(|| div().text_xs().text_color(theme.muted).child("⌘O"));
                let header = header.clone();
                menu_row(SharedString::from(format!("open-with-{}", editor.id)), Some(editor_icon(editor, cx).size(px(16.)).into_any_element()), editor.label, false, cx, move |_, _, cx| {
                    let _ = header.update(cx, |header, cx| header.open_in(editor, cx));
                })
                .children(shortcut)
                .into_any_element()
            })
            .collect();
        menu(cx)
            .w(px(200.))
            .on_mouse_down_out(cx.listener(|header, _, _, cx| header.dismiss_menu(cx)))
            .map(|card| if rows.is_empty() { card.child(div().px_2().py_1().text_sm().text_color(theme.muted).child("No installed editors found")) } else { card.children(rows) })
            .into_any_element()
    }
}
