//! A multi-line, wrapping text field for the composer. Grown from gpui's
//! `examples/input.rs` (Apache-2.0): same input-handler plumbing (IME,
//! marked text, UTF-16 ranges), extended to wrapped lines, vertical motion
//! and auto-height.

use std::ops::Range;

use gpui::{
    App, AvailableSpace, Bounds, ClipboardItem, Context, CursorStyle, ElementId, ElementInputHandler,
    Entity, EntityInputHandler, EventEmitter, FocusHandle, Focusable, GlobalElementId, KeyBinding,
    LayoutId, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, PaintQuad, Pixels, Point,
    SharedString, Size, Style, TextRun, UTF16Selection, UnderlineStyle, Window, WrappedLine, actions,
    div, fill, point, prelude::*, px, size,
};
use unicode_segmentation::UnicodeSegmentation;

use crate::theme::ActiveTheme;

actions!(
    text_input,
    [
        Backspace,
        DeleteWordLeft,
        DeleteToLineStart,
        Delete,
        Left,
        Right,
        Up,
        Down,
        WordLeft,
        WordRight,
        SelectLeft,
        SelectRight,
        SelectUp,
        SelectDown,
        SelectAll,
        Home,
        End,
        Newline,
        Submit,
        ShowCharacterPalette,
        Paste,
        Cut,
        Copy,
    ]
);

const CONTEXT: &str = "TextInput";

pub fn bind_keys(cx: &mut App) {
    let context = Some(CONTEXT);
    cx.bind_keys([
        KeyBinding::new("backspace", Backspace, context),
        KeyBinding::new("alt-backspace", DeleteWordLeft, context),
        KeyBinding::new("cmd-backspace", DeleteToLineStart, context),
        KeyBinding::new("delete", Delete, context),
        KeyBinding::new("left", Left, context),
        KeyBinding::new("right", Right, context),
        KeyBinding::new("up", Up, context),
        KeyBinding::new("down", Down, context),
        KeyBinding::new("alt-left", WordLeft, context),
        KeyBinding::new("alt-right", WordRight, context),
        KeyBinding::new("shift-left", SelectLeft, context),
        KeyBinding::new("shift-right", SelectRight, context),
        KeyBinding::new("shift-up", SelectUp, context),
        KeyBinding::new("shift-down", SelectDown, context),
        KeyBinding::new("cmd-a", SelectAll, context),
        KeyBinding::new("cmd-left", Home, context),
        KeyBinding::new("home", Home, context),
        KeyBinding::new("cmd-right", End, context),
        KeyBinding::new("end", End, context),
        KeyBinding::new("enter", Submit, context),
        KeyBinding::new("shift-enter", Newline, context),
        KeyBinding::new("alt-enter", Newline, context),
        KeyBinding::new("ctrl-cmd-space", ShowCharacterPalette, context),
        KeyBinding::new("cmd-v", Paste, context),
        KeyBinding::new("cmd-c", Copy, context),
        KeyBinding::new("cmd-x", Cut, context),
    ]);
}

pub enum InputEvent {
    Changed,
    /// Enter: the owner decides what sending means.
    Submit,
}

/// The shaped text from the last paint, for hit-testing and motion.
struct InputLayout {
    lines: Vec<WrappedLine>,
    /// Byte offset where each hard line starts in the content.
    starts: Vec<usize>,
    /// Y of each hard line's top, relative to the text origin.
    tops: Vec<Pixels>,
    line_height: Pixels,
    bounds: Bounds<Pixels>,
}

impl InputLayout {
    fn line_of(&self, offset: usize) -> usize {
        self.starts.partition_point(|start| *start <= offset).saturating_sub(1)
    }

    /// Where `offset` is drawn, relative to the text origin.
    fn position(&self, offset: usize) -> Point<Pixels> {
        let line = self.line_of(offset);
        let local = offset - self.starts[line];
        let within = self.lines[line].position_for_index(local, self.line_height).unwrap_or_else(|| {
            let size = self.lines[line].size(self.line_height);
            point(self.lines[line].width().min(size.width), size.height - self.line_height)
        });
        point(within.x, self.tops[line] + within.y)
    }

    /// The offset nearest a point relative to the text origin.
    fn offset(&self, position: Point<Pixels>) -> usize {
        let line = self.tops.partition_point(|top| *top <= position.y).saturating_sub(1);
        let local = point(position.x, position.y - self.tops[line]);
        let index = match self.lines[line].closest_index_for_position(local, self.line_height) {
            Ok(index) | Err(index) => index,
        };
        self.starts[line] + index.min(self.lines[line].len())
    }

    fn height(&self) -> Pixels {
        self.lines.last().map_or(self.line_height, |last| *self.tops.last().unwrap() + last.size(self.line_height).height)
    }
}

pub struct TextInput {
    focus_handle: FocusHandle,
    content: String,
    placeholder: SharedString,
    selected_range: Range<usize>,
    selection_reversed: bool,
    marked_range: Option<Range<usize>>,
    layout: Option<InputLayout>,
    is_selecting: bool,
    /// Keeps the cursor's column across up/down through shorter lines.
    goal_x: Option<Pixels>,
    scroll_y: Pixels,
    max_lines: usize,
}

impl EventEmitter<InputEvent> for TextInput {}

impl TextInput {
    pub fn new(placeholder: impl Into<SharedString>, max_lines: usize, cx: &mut Context<Self>) -> Self {
        Self {
            focus_handle: cx.focus_handle(),
            content: String::new(),
            placeholder: placeholder.into(),
            selected_range: 0..0,
            selection_reversed: false,
            marked_range: None,
            layout: None,
            is_selecting: false,
            goal_x: None,
            scroll_y: px(0.),
            max_lines,
        }
    }

    pub fn text(&self) -> &str {
        &self.content
    }

    pub fn set_text(&mut self, text: impl Into<String>, cx: &mut Context<Self>) {
        self.content = text.into();
        let end = self.content.len();
        self.selected_range = end..end;
        self.marked_range = None;
        self.goal_x = None;
        cx.emit(InputEvent::Changed);
        cx.notify();
    }

    fn cursor_offset(&self) -> usize {
        if self.selection_reversed { self.selected_range.start } else { self.selected_range.end }
    }

    fn move_to(&mut self, offset: usize, window: &Window, cx: &mut Context<Self>) {
        self.selected_range = offset..offset;
        self.selection_reversed = false;
        window.notify_text_selection_changed(&self.focus_handle);
        cx.notify();
    }

    fn select_to(&mut self, offset: usize, window: &Window, cx: &mut Context<Self>) {
        if self.selection_reversed {
            self.selected_range.start = offset;
        } else {
            self.selected_range.end = offset;
        }
        if self.selected_range.end < self.selected_range.start {
            self.selection_reversed = !self.selection_reversed;
            self.selected_range = self.selected_range.end..self.selected_range.start;
        }
        window.notify_text_selection_changed(&self.focus_handle);
        cx.notify();
    }

    fn previous_boundary(&self, offset: usize) -> usize {
        self.content.grapheme_indices(true).rev().find_map(|(ix, _)| (ix < offset).then_some(ix)).unwrap_or(0)
    }

    fn next_boundary(&self, offset: usize) -> usize {
        self.content.grapheme_indices(true).find_map(|(ix, _)| (ix > offset).then_some(ix)).unwrap_or(self.content.len())
    }

    fn previous_word(&self, offset: usize) -> usize {
        self.content.unicode_word_indices().rev().find_map(|(ix, _)| (ix < offset).then_some(ix)).unwrap_or(0)
    }

    fn next_word(&self, offset: usize) -> usize {
        self.content
            .unicode_word_indices()
            .find_map(|(ix, word)| (ix + word.len() > offset).then_some(ix + word.len()))
            .unwrap_or(self.content.len())
    }

    fn line_start(&self, offset: usize) -> usize {
        self.content[..offset].rfind('\n').map_or(0, |ix| ix + 1)
    }

    fn line_end(&self, offset: usize) -> usize {
        self.content[offset..].find('\n').map_or(self.content.len(), |ix| offset + ix)
    }

    /// The offset one visual row above (`-1`) or below (`1`) the cursor.
    fn vertical(&mut self, rows: f32) -> usize {
        let cursor = self.cursor_offset();
        let Some(layout) = &self.layout else { return cursor };
        let here = layout.position(cursor);
        let x = *self.goal_x.get_or_insert(here.x);
        let y = here.y + layout.line_height * rows + layout.line_height / 2.;
        if y < px(0.) {
            return 0;
        }
        if y > layout.height() {
            return self.content.len();
        }
        layout.offset(point(x, y))
    }

    fn left(&mut self, _: &Left, window: &mut Window, cx: &mut Context<Self>) {
        self.goal_x = None;
        let target = if self.selected_range.is_empty() { self.previous_boundary(self.cursor_offset()) } else { self.selected_range.start };
        self.move_to(target, window, cx);
    }

    fn right(&mut self, _: &Right, window: &mut Window, cx: &mut Context<Self>) {
        self.goal_x = None;
        let target = if self.selected_range.is_empty() { self.next_boundary(self.cursor_offset()) } else { self.selected_range.end };
        self.move_to(target, window, cx);
    }

    fn up(&mut self, _: &Up, window: &mut Window, cx: &mut Context<Self>) {
        let target = self.vertical(-1.);
        self.move_to(target, window, cx);
    }

    fn down(&mut self, _: &Down, window: &mut Window, cx: &mut Context<Self>) {
        let target = self.vertical(1.);
        self.move_to(target, window, cx);
    }

    fn word_left(&mut self, _: &WordLeft, window: &mut Window, cx: &mut Context<Self>) {
        self.goal_x = None;
        let target = self.previous_word(self.cursor_offset());
        self.move_to(target, window, cx);
    }

    fn word_right(&mut self, _: &WordRight, window: &mut Window, cx: &mut Context<Self>) {
        self.goal_x = None;
        let target = self.next_word(self.cursor_offset());
        self.move_to(target, window, cx);
    }

    fn select_left(&mut self, _: &SelectLeft, window: &mut Window, cx: &mut Context<Self>) {
        self.select_to(self.previous_boundary(self.cursor_offset()), window, cx);
    }

    fn select_right(&mut self, _: &SelectRight, window: &mut Window, cx: &mut Context<Self>) {
        self.select_to(self.next_boundary(self.cursor_offset()), window, cx);
    }

    fn select_up(&mut self, _: &SelectUp, window: &mut Window, cx: &mut Context<Self>) {
        let target = self.vertical(-1.);
        self.select_to(target, window, cx);
    }

    fn select_down(&mut self, _: &SelectDown, window: &mut Window, cx: &mut Context<Self>) {
        let target = self.vertical(1.);
        self.select_to(target, window, cx);
    }

    fn select_all(&mut self, _: &SelectAll, window: &mut Window, cx: &mut Context<Self>) {
        self.move_to(0, window, cx);
        self.select_to(self.content.len(), window, cx);
    }

    fn home(&mut self, _: &Home, window: &mut Window, cx: &mut Context<Self>) {
        self.goal_x = None;
        let target = self.line_start(self.cursor_offset());
        self.move_to(target, window, cx);
    }

    fn end(&mut self, _: &End, window: &mut Window, cx: &mut Context<Self>) {
        self.goal_x = None;
        let target = self.line_end(self.cursor_offset());
        self.move_to(target, window, cx);
    }

    /// Deletes from the cursor to `target` unless a selection is already
    /// there to delete.
    fn delete_to(&mut self, target: usize, window: &mut Window, cx: &mut Context<Self>) {
        if self.selected_range.is_empty() {
            if target == self.cursor_offset() {
                return;
            }
            self.select_to(target, window, cx);
        }
        self.replace_text_in_range(None, "", window, cx);
    }

    fn backspace(&mut self, _: &Backspace, window: &mut Window, cx: &mut Context<Self>) {
        self.delete_to(self.previous_boundary(self.cursor_offset()), window, cx);
    }

    fn delete_word_left(&mut self, _: &DeleteWordLeft, window: &mut Window, cx: &mut Context<Self>) {
        self.delete_to(self.previous_word(self.cursor_offset()), window, cx);
    }

    fn delete_to_line_start(&mut self, _: &DeleteToLineStart, window: &mut Window, cx: &mut Context<Self>) {
        self.delete_to(self.line_start(self.cursor_offset()), window, cx);
    }

    fn delete(&mut self, _: &Delete, window: &mut Window, cx: &mut Context<Self>) {
        self.delete_to(self.next_boundary(self.cursor_offset()), window, cx);
    }

    fn newline(&mut self, _: &Newline, window: &mut Window, cx: &mut Context<Self>) {
        self.replace_text_in_range(None, "\n", window, cx);
    }

    fn submit(&mut self, _: &Submit, _: &mut Window, cx: &mut Context<Self>) {
        cx.emit(InputEvent::Submit);
    }

    fn on_mouse_down(&mut self, event: &MouseDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        self.is_selecting = true;
        self.goal_x = None;
        let offset = self.index_for_mouse_position(event.position);
        if event.click_count >= 2 {
            let start = self.previous_word(offset.min(self.next_word(offset)));
            self.move_to(start, window, cx);
            self.select_to(self.next_word(start), window, cx);
        } else if event.modifiers.shift {
            self.select_to(offset, window, cx);
        } else {
            self.move_to(offset, window, cx);
        }
    }

    fn on_mouse_up(&mut self, _: &MouseUpEvent, _: &mut Window, _: &mut Context<Self>) {
        self.is_selecting = false;
    }

    fn on_mouse_move(&mut self, event: &MouseMoveEvent, window: &mut Window, cx: &mut Context<Self>) {
        if self.is_selecting {
            self.select_to(self.index_for_mouse_position(event.position), window, cx);
        }
    }

    fn index_for_mouse_position(&self, position: Point<Pixels>) -> usize {
        let Some(layout) = &self.layout else { return 0 };
        if self.content.is_empty() {
            return 0;
        }
        let local = position - layout.bounds.origin + point(px(0.), self.scroll_y);
        if local.y < px(0.) {
            return 0;
        }
        if local.y > layout.height() {
            return self.content.len();
        }
        layout.offset(local)
    }

    fn show_character_palette(&mut self, _: &ShowCharacterPalette, window: &mut Window, _: &mut Context<Self>) {
        window.show_character_palette();
    }

    fn paste(&mut self, _: &Paste, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(text) = cx.read_from_clipboard().and_then(|item| item.text()) {
            self.replace_text_in_range(None, &text, window, cx);
        }
    }

    fn copy(&mut self, _: &Copy, _: &mut Window, cx: &mut Context<Self>) {
        if !self.selected_range.is_empty() {
            cx.write_to_clipboard(ClipboardItem::new_string(self.content[self.selected_range.clone()].to_string()));
        }
    }

    fn cut(&mut self, _: &Cut, window: &mut Window, cx: &mut Context<Self>) {
        if !self.selected_range.is_empty() {
            cx.write_to_clipboard(ClipboardItem::new_string(self.content[self.selected_range.clone()].to_string()));
            self.replace_text_in_range(None, "", window, cx);
        }
    }

    fn offset_from_utf16(&self, offset: usize) -> usize {
        let mut utf8 = 0;
        let mut utf16 = 0;
        for ch in self.content.chars() {
            if utf16 >= offset {
                break;
            }
            utf16 += ch.len_utf16();
            utf8 += ch.len_utf8();
        }
        utf8
    }

    fn offset_to_utf16(&self, offset: usize) -> usize {
        self.content[..offset.min(self.content.len())].encode_utf16().count()
    }

    fn range_to_utf16(&self, range: &Range<usize>) -> Range<usize> {
        self.offset_to_utf16(range.start)..self.offset_to_utf16(range.end)
    }

    fn range_from_utf16(&self, range: &Range<usize>) -> Range<usize> {
        self.offset_from_utf16(range.start)..self.offset_from_utf16(range.end)
    }

    fn splice(&mut self, range: Range<usize>, new_text: &str) {
        self.content.replace_range(range, new_text);
        self.goal_x = None;
    }
}

impl EntityInputHandler for TextInput {
    fn text_for_range(&mut self, range_utf16: Range<usize>, actual_range: &mut Option<Range<usize>>, _: &mut Window, _: &mut Context<Self>) -> Option<String> {
        let range = self.range_from_utf16(&range_utf16);
        actual_range.replace(self.range_to_utf16(&range));
        Some(self.content[range].to_string())
    }

    fn selected_text_range(&mut self, _: bool, _: &mut Window, _: &mut Context<Self>) -> Option<UTF16Selection> {
        Some(UTF16Selection { range: self.range_to_utf16(&self.selected_range), reversed: self.selection_reversed })
    }

    fn set_selected_text_range(&mut self, range_utf16: Range<usize>, window: &mut Window, cx: &mut Context<Self>) {
        self.selected_range = self.range_from_utf16(&range_utf16);
        self.selection_reversed = false;
        window.notify_text_selection_changed(&self.focus_handle);
        cx.notify();
    }

    fn text_length_utf16(&mut self, _: &mut Window, _: &mut Context<Self>) -> Option<usize> {
        Some(self.content.encode_utf16().count())
    }

    fn marked_text_range(&self, _: &mut Window, _: &mut Context<Self>) -> Option<Range<usize>> {
        self.marked_range.as_ref().map(|range| self.range_to_utf16(range))
    }

    fn unmark_text(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.marked_range = None;
        window.notify_text_input_changed(&self.focus_handle);
        cx.notify();
    }

    fn replace_text_in_range(&mut self, range_utf16: Option<Range<usize>>, new_text: &str, window: &mut Window, cx: &mut Context<Self>) {
        let range = range_utf16
            .as_ref()
            .map(|range| self.range_from_utf16(range))
            .or(self.marked_range.clone())
            .unwrap_or(self.selected_range.clone());
        self.splice(range.clone(), new_text);
        let end = range.start + new_text.len();
        self.selected_range = end..end;
        self.selection_reversed = false;
        self.marked_range = None;
        window.notify_text_input_changed(&self.focus_handle);
        cx.emit(InputEvent::Changed);
        cx.notify();
    }

    fn replace_and_mark_text_in_range(
        &mut self,
        range_utf16: Option<Range<usize>>,
        new_text: &str,
        new_selected_range_utf16: Option<Range<usize>>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let range = range_utf16
            .as_ref()
            .map(|range| self.range_from_utf16(range))
            .or(self.marked_range.clone())
            .unwrap_or(self.selected_range.clone());
        self.splice(range.clone(), new_text);
        self.marked_range = (!new_text.is_empty()).then(|| range.start..range.start + new_text.len());
        let start_utf16 = self.offset_to_utf16(range.start);
        let inserted_utf16 = new_text.encode_utf16().count();
        self.selected_range = new_selected_range_utf16
            .map(|selected| self.range_from_utf16(&(start_utf16 + selected.start.min(inserted_utf16)..start_utf16 + selected.end.min(inserted_utf16))))
            .unwrap_or_else(|| range.start + new_text.len()..range.start + new_text.len());
        self.selection_reversed = false;
        window.notify_text_input_changed(&self.focus_handle);
        cx.emit(InputEvent::Changed);
        cx.notify();
    }

    fn bounds_for_range(&mut self, range_utf16: Range<usize>, _: Bounds<Pixels>, _: &mut Window, _: &mut Context<Self>) -> Option<Bounds<Pixels>> {
        let layout = self.layout.as_ref()?;
        let range = self.range_from_utf16(&range_utf16);
        let origin = layout.bounds.origin - point(px(0.), self.scroll_y);
        let start = layout.position(range.start);
        let end = layout.position(range.end);
        Some(Bounds::from_corners(origin + start, origin + point(end.x, end.y + layout.line_height)))
    }

    fn character_index_for_point(&mut self, position: Point<Pixels>, _: &mut Window, _: &mut Context<Self>) -> Option<usize> {
        self.layout.as_ref()?;
        Some(self.offset_to_utf16(self.index_for_mouse_position(position)))
    }
}

/// Paints the input and records its layout for hit-testing.
struct TextElement {
    input: Entity<TextInput>,
}

struct PrepaintState {
    lines: Vec<WrappedLine>,
    tops: Vec<Pixels>,
    starts: Vec<usize>,
    line_height: Pixels,
    cursor: Option<PaintQuad>,
    selections: Vec<PaintQuad>,
    scroll_y: Pixels,
}

/// Shapes `text` into one wrapped line per hard line, with the byte offset
/// each starts at.
fn shape(text: &str, color: gpui::Hsla, width: Pixels, window: &Window) -> (Vec<WrappedLine>, Vec<usize>) {
    let style = window.text_style();
    let font_size = style.font_size.to_pixels(window.rem_size());
    let mut lines = Vec::new();
    let mut starts = Vec::new();
    let mut start = 0;
    for line in text.split('\n') {
        let run = TextRun { len: line.len(), font: style.font(), color, background_color: None, underline: None, strikethrough: None };
        let shaped = window
            .text_system()
            .shape_text(SharedString::from(line.to_string()), font_size, &[run], Some(width), None)
            .ok()
            .and_then(|mut shaped| shaped.pop())
            .unwrap_or_default();
        lines.push(shaped);
        starts.push(start);
        start += line.len() + 1;
    }
    (lines, starts)
}

fn tops_of(lines: &[WrappedLine], line_height: Pixels) -> Vec<Pixels> {
    let mut top = px(0.);
    lines
        .iter()
        .map(|line| {
            let this = top;
            top += line.size(line_height).height.max(line_height);
            this
        })
        .collect()
}

impl Element for TextElement {
    type RequestLayoutState = ();
    type PrepaintState = PrepaintState;

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(&mut self, _: Option<&GlobalElementId>, _: Option<&gpui::InspectorElementId>, window: &mut Window, cx: &mut App) -> (LayoutId, ()) {
        let input = self.input.read(cx);
        let text = if input.content.is_empty() { input.placeholder.to_string() } else { input.content.clone() };
        let max_lines = input.max_lines;
        let mut style = Style::default();
        style.size.width = gpui::relative(1.).into();
        let layout_id = window.request_measured_layout(style, move |known: Size<Option<Pixels>>, available: Size<AvailableSpace>, window, _| {
            let width = known.width.unwrap_or(match available.width {
                AvailableSpace::Definite(width) => width,
                _ => px(600.),
            });
            let line_height = window.line_height();
            let (lines, _) = shape(&text, gpui::black(), width, window);
            let height = tops_of(&lines, line_height).last().copied().unwrap_or_default()
                + lines.last().map_or(line_height, |line| line.size(line_height).height.max(line_height));
            size(width, height.min(line_height * max_lines as f32))
        });
        (layout_id, ())
    }

    fn prepaint(&mut self, _: Option<&GlobalElementId>, _: Option<&gpui::InspectorElementId>, bounds: Bounds<Pixels>, _: &mut (), window: &mut Window, cx: &mut App) -> PrepaintState {
        let theme = cx.theme();
        let (selection_color, cursor_color, placeholder_color) = (theme.selection, theme.primary, theme.placeholder);
        let input = self.input.read(cx);
        let empty = input.content.is_empty();
        let (text, color) = if empty { (input.placeholder.to_string(), placeholder_color) } else { (input.content.clone(), window.text_style().color) };
        let line_height = window.line_height();
        let (lines, starts) = shape(&text, color, bounds.size.width, window);
        let tops = tops_of(&lines, line_height);
        let layout = InputLayout { lines, starts, tops, line_height, bounds };

        let cursor_at = if empty { 0 } else { input.cursor_offset() };
        let cursor_pos = layout.position(cursor_at);
        // Keep the cursor's row inside the visible window of lines.
        let mut scroll_y = input.scroll_y;
        if cursor_pos.y < scroll_y {
            scroll_y = cursor_pos.y;
        } else if cursor_pos.y + line_height > scroll_y + bounds.size.height {
            scroll_y = cursor_pos.y + line_height - bounds.size.height;
        }
        scroll_y = scroll_y.min((layout.height() - bounds.size.height).max(px(0.))).max(px(0.));
        let origin = bounds.origin - point(px(0.), scroll_y);

        let selections = if input.selected_range.is_empty() || empty {
            Vec::new()
        } else {
            selection_quads(&layout, input.selected_range.clone(), origin, bounds.size.width, selection_color)
        };
        let cursor = input
            .selected_range
            .is_empty()
            .then(|| fill(Bounds::new(origin + cursor_pos, size(px(1.5), line_height)), cursor_color));
        let InputLayout { lines, starts, tops, .. } = layout;
        PrepaintState { lines, tops, starts, line_height, cursor, selections, scroll_y }
    }

    fn paint(&mut self, _: Option<&GlobalElementId>, _: Option<&gpui::InspectorElementId>, bounds: Bounds<Pixels>, _: &mut (), prepaint: &mut PrepaintState, window: &mut Window, cx: &mut App) {
        let focus_handle = self.input.read(cx).focus_handle.clone();
        window.handle_input(&focus_handle, ElementInputHandler::new(bounds, self.input.clone()), cx);
        let origin = bounds.origin - point(px(0.), prepaint.scroll_y);
        let layout = InputLayout {
            lines: std::mem::take(&mut prepaint.lines),
            starts: std::mem::take(&mut prepaint.starts),
            tops: std::mem::take(&mut prepaint.tops),
            line_height: prepaint.line_height,
            bounds,
        };
        let marked = self.input.read(cx).marked_range.clone();
        window.with_content_mask(Some(gpui::ContentMask { bounds }), |window| {
            for quad in prepaint.selections.drain(..) {
                window.paint_quad(quad);
            }
            for (line, top) in layout.lines.iter().zip(&layout.tops) {
                let _ = line.paint(origin + point(px(0.), *top), layout.line_height, gpui::TextAlign::Left, None, window, cx);
            }
            if let Some(marked) = marked {
                paint_marked_underline(&layout, marked, origin, window);
            }
            if focus_handle.is_focused(window)
                && let Some(cursor) = prepaint.cursor.take()
            {
                window.paint_quad(cursor);
            }
        });
        let scroll_y = prepaint.scroll_y;
        self.input.update(cx, |input, _| {
            input.layout = Some(layout);
            input.scroll_y = scroll_y;
        });
    }
}

/// One rectangle per visual row the selection covers.
fn selection_quads(layout: &InputLayout, range: Range<usize>, origin: Point<Pixels>, width: Pixels, color: gpui::Hsla) -> Vec<PaintQuad> {
    let start = layout.position(range.start);
    let end = layout.position(range.end);
    let height = layout.line_height;
    if start.y == end.y {
        return vec![fill(Bounds::from_corners(origin + start, origin + point(end.x, end.y + height)), color)];
    }
    let mut quads = vec![fill(Bounds::from_corners(origin + start, origin + point(width, start.y + height)), color)];
    let middle_top = start.y + height;
    if end.y > middle_top {
        quads.push(fill(Bounds::from_corners(origin + point(px(0.), middle_top), origin + point(width, end.y)), color));
    }
    quads.push(fill(Bounds::from_corners(origin + point(px(0.), end.y), origin + point(end.x, end.y + height)), color));
    quads
}

/// IME composition text is underlined, as the platform expects.
fn paint_marked_underline(layout: &InputLayout, marked: Range<usize>, origin: Point<Pixels>, window: &mut Window) {
    let start = layout.position(marked.start);
    let end = layout.position(marked.end);
    if start.y == end.y {
        let style = UnderlineStyle { thickness: px(1.), color: None, wavy: false };
        window.paint_underline(origin + point(start.x, start.y + layout.line_height - px(2.)), end.x - start.x, &style);
    }
}

impl Render for TextInput {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .w_full()
            .key_context(CONTEXT)
            .track_focus(&self.focus_handle)
            .cursor(CursorStyle::IBeam)
            .on_action(cx.listener(Self::backspace))
            .on_action(cx.listener(Self::delete_word_left))
            .on_action(cx.listener(Self::delete_to_line_start))
            .on_action(cx.listener(Self::delete))
            .on_action(cx.listener(Self::left))
            .on_action(cx.listener(Self::right))
            .on_action(cx.listener(Self::up))
            .on_action(cx.listener(Self::down))
            .on_action(cx.listener(Self::word_left))
            .on_action(cx.listener(Self::word_right))
            .on_action(cx.listener(Self::select_left))
            .on_action(cx.listener(Self::select_right))
            .on_action(cx.listener(Self::select_up))
            .on_action(cx.listener(Self::select_down))
            .on_action(cx.listener(Self::select_all))
            .on_action(cx.listener(Self::home))
            .on_action(cx.listener(Self::end))
            .on_action(cx.listener(Self::newline))
            .on_action(cx.listener(Self::submit))
            .on_action(cx.listener(Self::show_character_palette))
            .on_action(cx.listener(Self::paste))
            .on_action(cx.listener(Self::cut))
            .on_action(cx.listener(Self::copy))
            .on_mouse_down(MouseButton::Left, cx.listener(Self::on_mouse_down))
            .on_mouse_up(MouseButton::Left, cx.listener(Self::on_mouse_up))
            .on_mouse_up_out(MouseButton::Left, cx.listener(Self::on_mouse_up))
            .on_mouse_move(cx.listener(Self::on_mouse_move))
            .child(TextElement { input: cx.entity() })
    }
}

impl Focusable for TextInput {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::TestAppContext;

    #[gpui::test]
    fn typing_editing_and_submitting(cx: &mut TestAppContext) {
        cx.update(|cx| {
            cx.set_global(crate::theme::Theme::loop_dark());
            bind_keys(cx);
        });
        let (input, cx) = cx.add_window_view(|_, cx| TextInput::new("Ask", 8, cx));
        let submitted = std::rc::Rc::new(std::cell::Cell::new(0));
        let counter = submitted.clone();
        cx.update(|window, cx| {
            cx.subscribe(&input, move |_, event: &InputEvent, _| {
                if matches!(event, InputEvent::Submit) {
                    counter.set(counter.get() + 1);
                }
            })
            .detach();
            window.focus(&input.focus_handle(cx), cx);
        });
        cx.simulate_input("hello world");
        cx.simulate_keystrokes("alt-backspace shift-enter");
        cx.simulate_input("two");
        cx.simulate_keystrokes("enter");
        input.read_with(cx, |input, _| assert_eq!(input.text(), "hello \ntwo"));
        assert_eq!(submitted.get(), 1);
    }
}
