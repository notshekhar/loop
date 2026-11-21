//! Draws a terminal frame the way Zed's terminal element does: cell
//! backgrounds, text runs, then the cursor, in Lilex on a one-cell gutter.

use alacritty_terminal::vte::ansi::CursorShape;
use gpui::{
    App, BorderStyle, Bounds, Font, FontStyle, FontWeight, Hsla, Pixels, Point, Size,
    StrikethroughStyle, TextAlign, TextRun, UnderlineStyle, Window, fill, font, outline, point,
    px, size,
};

use crate::terminal::colors::Palette;
use crate::terminal::frame::{Cursor, Frame, Style};
use crate::terminal::session::GridSize;

/// Zed's buffer font, default `buffer_font_size`, and the terminal's
/// `line_height: "standard"`.
const FAMILY: &str = "Lilex";
const FONT_SIZE: Pixels = px(15.);
const LINE_HEIGHT: f32 = 1.3;
/// A beam or underline cursor's thickness.
const BAR: Pixels = px(2.);
/// Measured off a shaped run rather than one glyph's advance, so the grid
/// matches exactly how the text is drawn.
const MEASURE: &str = "mmmmmmmmmm";

/// Where the grid starts and a cell's size.
#[derive(Clone, Copy, Debug)]
pub struct GridLayout {
    pub origin: Point<Pixels>,
    pub cell: Size<Pixels>,
}

fn cell_size(window: &Window) -> Size<Pixels> {
    let run = TextRun { len: MEASURE.len(), font: font(FAMILY), color: gpui::black(), background_color: None, underline: None, strikethrough: None };
    let shaped = window.text_system().shape_line(MEASURE.into(), FONT_SIZE, &[run], None);
    size(shaped.width / MEASURE.len() as f32, FONT_SIZE * LINE_HEIGHT)
}

/// Lays the grid out in `bounds` as Zed does: a one-cell gutter on the
/// left, whole rows from the top, the origin snapped to device pixels so
/// glyphs don't shimmer while resizing.
pub fn layout(bounds: Bounds<Pixels>, window: &Window) -> (GridLayout, GridSize) {
    let cell = cell_size(window);
    let scale = window.scale_factor();
    let snap = |value: Pixels| px((f32::from(value) * scale).floor() / scale);
    let origin = point(snap(bounds.origin.x + cell.width), snap(bounds.origin.y));
    let width = (bounds.size.width - cell.width).max(cell.width * 2.);
    let count = |room: Pixels, step: Pixels| ((room / step).floor() as u16).max(1);
    let grid = GridSize { columns: count(width, cell.width).max(2), lines: count(bounds.size.height, cell.height), cell_width: f32::from(cell.width).round() as u16, cell_height: f32::from(cell.height).round() as u16 };
    (GridLayout { origin, cell }, grid)
}

fn cell_bounds(layout: &GridLayout, line: usize, column: usize, cells: usize) -> Bounds<Pixels> {
    let origin = layout.origin + point(layout.cell.width * column as f32, layout.cell.height * line as f32);
    Bounds { origin, size: size(layout.cell.width * cells as f32, layout.cell.height) }
}

fn text_run(text: &str, style: &Style, color: Hsla) -> TextRun {
    TextRun {
        len: text.len(),
        font: Font { weight: if style.bold { FontWeight::BOLD } else { FontWeight::NORMAL }, style: if style.italic { FontStyle::Italic } else { FontStyle::Normal }, ..font(FAMILY) },
        color,
        background_color: None,
        underline: style.underline.then_some(UnderlineStyle { thickness: px(1.), color: Some(color), wavy: false }),
        strikethrough: style.strike.then_some(StrikethroughStyle { thickness: px(1.), color: Some(color) }),
    }
}

fn paint_text(text: &str, style: &Style, color: Hsla, at: Point<Pixels>, layout: &GridLayout, window: &mut Window, cx: &mut App) {
    let run = text_run(text, style, color);
    let shaped = window.text_system().shape_line(text.to_string().into(), FONT_SIZE, &[run], None);
    let _ = shaped.paint(at, layout.cell.height, TextAlign::Left, None, window, cx);
}

/// A focused block cursor is solid with its glyph knocked out; an
/// unfocused one is an outline, as in Zed.
fn paint_cursor(cursor: &Cursor, focused: bool, palette: &Palette, layout: &GridLayout, window: &mut Window, cx: &mut App) {
    let bounds = cell_bounds(layout, cursor.line, cursor.column, cursor.cells);
    match cursor.shape {
        CursorShape::Block if focused => {
            window.paint_quad(fill(bounds, palette.cursor));
            if cursor.text.trim() != "" {
                paint_text(&cursor.text, &cursor.style, palette.background, bounds.origin, layout, window, cx);
            }
        }
        CursorShape::Beam => window.paint_quad(fill(Bounds { size: size(BAR, bounds.size.height), ..bounds }, palette.cursor)),
        CursorShape::Underline => window.paint_quad(fill(Bounds { origin: point(bounds.origin.x, bounds.bottom() - BAR), size: size(bounds.size.width, BAR) }, palette.cursor)),
        _ => window.paint_quad(outline(bounds, palette.cursor, BorderStyle::Solid)),
    }
}

pub fn paint_frame(frame: &Frame, layout: &GridLayout, focused: bool, palette: &Palette, window: &mut Window, cx: &mut App) {
    for (line, row) in frame.rows.iter().enumerate() {
        for background in &row.fills {
            window.paint_quad(fill(cell_bounds(layout, line, background.column, background.cells), background.color));
        }
    }
    for (line, row) in frame.rows.iter().enumerate() {
        for span in &row.spans {
            let at = cell_bounds(layout, line, span.column, span.cells).origin;
            paint_text(&span.text, &span.style, span.style.color, at, layout, window, cx);
        }
    }
    if let Some(cursor) = &frame.cursor {
        paint_cursor(cursor, focused, palette, layout, window, cx);
    }
}
