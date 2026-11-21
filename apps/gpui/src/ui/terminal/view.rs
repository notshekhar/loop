//! One terminal pane: keys and the clipboard go to the shell, the mouse
//! selects and scrolls, and the grid repaints whenever the shell prints.

use std::cell::Cell;
use std::rc::Rc;
use std::sync::Arc;

use alacritty_terminal::event::Event;
use alacritty_terminal::grid::{Dimensions, Scroll};
use alacritty_terminal::index::{Column, Line, Point as GridPoint, Side};
use alacritty_terminal::selection::{Selection, SelectionType};
use alacritty_terminal::term::TermMode;
use alacritty_terminal::vte::ansi::Rgb;
use futures::StreamExt;
use futures::channel::mpsc::UnboundedReceiver;
use gpui::{
    App, ClipboardItem, Context, EventEmitter, FocusHandle, Focusable, InteractiveElement,
    IntoElement, KeyDownEvent, MouseButton, MouseDownEvent, MouseMoveEvent, ParentElement,
    Pixels, Point, Render, ScrollEvent, Styled, Task, Window, canvas, div,
};

use super::actions::{Copy, Paste};
use super::paint::{GridLayout, layout, paint_frame};
use crate::terminal::colors::Palette;
use crate::terminal::frame::snapshot;
use crate::terminal::keys;
use crate::terminal::session::{GridSize, Session};
use crate::theme::{ActiveTheme, Theme};

/// The pty's size before the first layout measures the pane.
const FIRST_SIZE: GridSize = GridSize { columns: 80, lines: 24, cell_width: 7, cell_height: 14 };

pub enum TerminalEvent {
    /// The shell exited; the drawer closes the pane.
    Exited,
    /// The program renamed its window (OSC 0/2): the tab shows it, as Zed's do.
    TitleChanged,
}

/// A shell that started, not yet shown.
pub struct Started {
    session: Session,
    events: UnboundedReceiver<Event>,
}

pub struct TerminalView {
    session: Arc<Session>,
    focus: FocusHandle,
    /// Where the grid was last painted, for turning the pointer into a cell.
    layout: Rc<Cell<Option<GridLayout>>>,
    title: Option<String>,
    /// Wheel movement smaller than a line, carried to the next event.
    scroll_remainder: f32,
    _events: Task<()>,
}

impl EventEmitter<TerminalEvent> for TerminalView {}

/// Zed's terminal colours on the drawer's surface.
pub fn palette(theme: Theme) -> Palette {
    Palette::zed(theme.card)
}

fn rgb(color: gpui::Hsla) -> Rgb {
    let color = color.to_rgb();
    let byte = |channel: f32| (channel * 255.).round() as u8;
    Rgb { r: byte(color.r), g: byte(color.g), b: byte(color.b) }
}

impl TerminalView {
    /// Starts a shell in `cwd`, or the home folder when `cwd` is gone.
    pub fn start(cwd: &str) -> anyhow::Result<Started> {
        let cwd = if std::path::Path::new(cwd).is_dir() { cwd.to_string() } else { std::env::var("HOME").unwrap_or_else(|_| "/".into()) };
        let (session, events) = Session::spawn(&cwd, FIRST_SIZE)?;
        Ok(Started { session, events })
    }

    pub fn new(started: Started, cx: &mut Context<Self>) -> Self {
        let Started { session, mut events } = started;
        let task = cx.spawn(async move |this, cx| {
            while let Some(event) = events.next().await {
                if this.update(cx, |view, cx| view.on_event(event, cx)).is_err() {
                    break;
                }
            }
        });
        Self { session: Arc::new(session), focus: cx.focus_handle(), layout: Rc::default(), title: None, scroll_remainder: 0., _events: task }
    }

    fn on_event(&mut self, event: Event, cx: &mut Context<Self>) {
        match event {
            Event::Wakeup | Event::MouseCursorDirty | Event::CursorBlinkingChange => cx.notify(),
            Event::PtyWrite(text) => self.session.reply(text),
            Event::ClipboardStore(_, text) => cx.write_to_clipboard(ClipboardItem::new_string(text)),
            Event::ClipboardLoad(_, format) => {
                let text = cx.read_from_clipboard().and_then(|item| item.text()).unwrap_or_default();
                self.session.reply(format(&text));
            }
            Event::ColorRequest(index, format) => {
                let theme = palette(cx.theme());
                let color = self.session.with_grid(|grid| grid.colors()[index]).unwrap_or_else(|| rgb(if index == 257 { theme.background } else { theme.foreground }));
                self.session.reply(format(color));
            }
            Event::TextAreaSizeRequest(format) => self.session.reply(format(self.session.size().window_size())),
            Event::ChildExit(code) => { eprintln!("DEBUG child exit {code:?}"); cx.emit(TerminalEvent::Exited) }
            Event::Exit => { eprintln!("DEBUG exit"); cx.emit(TerminalEvent::Exited) }
            Event::Title(title) => self.set_title(Some(title), cx),
            Event::ResetTitle => self.set_title(None, cx),
            Event::Bell => {}
        }
    }

    fn set_title(&mut self, title: Option<String>, cx: &mut Context<Self>) {
        self.title = title.filter(|title| !title.trim().is_empty());
        cx.emit(TerminalEvent::TitleChanged);
    }

    pub fn title(&self) -> Option<&str> {
        self.title.as_deref()
    }

    fn mode(&self) -> TermMode {
        self.session.with_grid(|grid| *grid.mode())
    }

    fn key_down(&mut self, event: &KeyDownEvent, _: &mut Window, cx: &mut Context<Self>) {
        let app_cursor = self.mode().contains(TermMode::APP_CURSOR);
        if let Some(bytes) = keys::to_bytes(&event.keystroke, app_cursor) {
            self.session.write(bytes);
            cx.stop_propagation();
        }
    }

    fn copy(&mut self, _: &Copy, _: &mut Window, cx: &mut Context<Self>) {
        if let Some(text) = self.session.with_grid(|grid| grid.selection_to_string()).filter(|text| !text.is_empty()) {
            cx.write_to_clipboard(ClipboardItem::new_string(text));
        }
    }

    fn paste(&mut self, _: &Paste, _: &mut Window, cx: &mut Context<Self>) {
        let Some(text) = cx.read_from_clipboard().and_then(|item| item.text()) else { return };
        let bracketed = self.mode().contains(TermMode::BRACKETED_PASTE);
        self.session.write(paste_bytes(&text, bracketed));
    }

    /// The cell under `position`, and which half of it.
    fn cell_at(&self, position: Point<Pixels>) -> Option<(GridPoint, Side)> {
        let layout = self.layout.get()?;
        let relative = position - layout.origin;
        let (columns, lines, offset) = self.session.with_grid(|grid| (grid.columns(), grid.screen_lines(), grid.grid().display_offset()));
        let column_f = (relative.x / layout.cell.width).max(0.);
        let column = (column_f as usize).min(columns - 1);
        let line = ((relative.y / layout.cell.height).max(0.) as usize).min(lines - 1);
        let side = if column_f.fract() < 0.5 { Side::Left } else { Side::Right };
        Some((GridPoint::new(Line(line as i32 - offset as i32), Column(column)), side))
    }

    fn mouse_down(&mut self, event: &MouseDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        window.focus(&self.focus, cx);
        let Some((point, side)) = self.cell_at(event.position) else { return };
        let kind = match event.click_count {
            2 => SelectionType::Semantic,
            3.. => SelectionType::Lines,
            _ => SelectionType::Simple,
        };
        self.session.with_grid(|grid| match grid.selection.as_mut() {
            // Shift-click stretches the selection there is to the click.
            Some(selection) if event.modifiers.shift => selection.update(point, side),
            _ => grid.selection = Some(Selection::new(kind, point, side)),
        });
        cx.notify();
    }

    fn mouse_drag(&mut self, event: &MouseMoveEvent, _: &mut Window, cx: &mut Context<Self>) {
        if event.pressed_button != Some(MouseButton::Left) {
            return;
        }
        let Some((point, side)) = self.cell_at(event.position) else { return };
        self.session.with_grid(|grid| {
            if let Some(selection) = grid.selection.as_mut() {
                selection.update(point, side);
            }
        });
        cx.notify();
    }

    /// The wheel scrolls history; in a full-screen program with alternate
    /// scroll on (less, vim), it sends arrow keys instead, as xterm does.
    fn scroll(&mut self, event: &ScrollEvent, _: &mut Window, cx: &mut Context<Self>) {
        let Some(layout) = self.layout.get() else { return };
        let delta = event.delta.pixel_delta(layout.cell.height).y / layout.cell.height + self.scroll_remainder;
        let lines = delta.trunc() as i32;
        self.scroll_remainder = delta.fract();
        if lines == 0 {
            return;
        }
        let mode = self.mode();
        if mode.contains(TermMode::ALT_SCREEN | TermMode::ALTERNATE_SCROLL) {
            let arrow: &[u8] = match (lines > 0, mode.contains(TermMode::APP_CURSOR)) {
                (true, true) => b"\x1bOA",
                (true, false) => b"\x1b[A",
                (false, true) => b"\x1bOB",
                (false, false) => b"\x1b[B",
            };
            self.session.reply(arrow.repeat(lines.unsigned_abs() as usize));
        } else {
            self.session.with_grid(|grid| grid.scroll_display(Scroll::Delta(lines)));
        }
        cx.notify();
    }
}

/// Pasted text with line ends as Enter, wrapped in bracketed-paste marks
/// when the program asked for them.
fn paste_bytes(text: &str, bracketed: bool) -> Vec<u8> {
    let text = text.replace("\r\n", "\r").replace('\n', "\r");
    if bracketed { format!("\x1b[200~{}\x1b[201~", text.replace('\x1b', "")).into_bytes() } else { text.into_bytes() }
}

impl Focusable for TerminalView {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for TerminalView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let palette = palette(theme);
        let focused = self.focus.is_focused(window);
        let session = self.session.clone();
        let layout_cell = self.layout.clone();
        let grid = canvas(
            move |bounds, window, _| {
                let (grid_layout, size) = layout(bounds, window);
                session.resize(size);
                layout_cell.set(Some(grid_layout));
                (session.with_grid(|grid| snapshot(grid, &palette)), grid_layout)
            },
            move |_, (frame, grid_layout), window, cx| paint_frame(&frame, &grid_layout, focused, &palette, window, cx),
        )
        .size_full();
        div()
            .track_focus(&self.focus)
            .key_context(super::actions::CONTEXT)
            .on_action(cx.listener(Self::copy))
            .on_action(cx.listener(Self::paste))
            .on_key_down(cx.listener(Self::key_down))
            .on_mouse_down(MouseButton::Left, cx.listener(Self::mouse_down))
            .on_mouse_move(cx.listener(Self::mouse_drag))
            .on_scroll(cx.listener(Self::scroll))
            .size_full()
            .overflow_hidden()
            .bg(theme.card)
            .cursor_text()
            .child(grid)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_paste_sends_enter_for_newlines_and_brackets_when_asked() {
        assert_eq!(paste_bytes("a\nb\r\nc", false), b"a\rb\rc");
        assert_eq!(paste_bytes("ls", true), b"\x1b[200~ls\x1b[201~");
        assert_eq!(paste_bytes("x\x1b[201~y", true), b"\x1b[200~x[201~y\x1b[201~");
    }
}
