//! What is on screen, read out of the grid as runs of like-styled cells so
//! a frame shapes a few dozen strings rather than thousands of glyphs.

use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::index::Point;
use alacritty_terminal::term::Term;
use alacritty_terminal::term::cell::{Cell, Flags};
use alacritty_terminal::vte::ansi::CursorShape;
use gpui::Hsla;

use super::colors::Palette;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Style {
    pub color: Hsla,
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    pub strike: bool,
}

/// Text drawn from `column`, `cells` wide.
#[derive(Debug, PartialEq)]
pub struct Span {
    pub column: usize,
    pub cells: usize,
    pub text: String,
    pub style: Style,
}

/// A background (or the selection) behind `cells` cells from `column`.
#[derive(Debug, PartialEq)]
pub struct Fill {
    pub column: usize,
    pub cells: usize,
    pub color: Hsla,
}

#[derive(Debug, Default)]
pub struct Row {
    pub spans: Vec<Span>,
    pub fills: Vec<Fill>,
}

#[derive(Debug)]
pub struct Cursor {
    pub line: usize,
    pub column: usize,
    pub cells: usize,
    pub shape: CursorShape,
    /// The glyph under a block cursor, redrawn in the background colour.
    pub text: String,
    pub style: Style,
}

#[derive(Debug)]
pub struct Frame {
    pub rows: Vec<Row>,
    pub cursor: Option<Cursor>,
}

/// A cell's colours and attributes once INVERSE, DIM and HIDDEN apply.
fn cell_style<T>(cell: &Cell, term: &Term<T>, palette: &Palette) -> (Style, Hsla) {
    let colors = term.colors();
    let dim = cell.flags.contains(Flags::DIM);
    let mut fg = if dim { palette.dimmed(cell.fg, colors) } else { palette.resolve(cell.fg, colors) };
    let mut bg = palette.resolve(cell.bg, colors);
    if cell.flags.contains(Flags::INVERSE) {
        std::mem::swap(&mut fg, &mut bg);
    }
    fg = if cell.flags.contains(Flags::HIDDEN) { bg } else { palette.readable(fg, bg) };
    let style = Style {
        color: fg,
        bold: cell.flags.contains(Flags::BOLD),
        italic: cell.flags.contains(Flags::ITALIC),
        underline: cell.flags.intersects(Flags::ALL_UNDERLINES),
        strike: cell.flags.contains(Flags::STRIKEOUT),
    };
    (style, bg)
}

fn cell_text(cell: &Cell) -> String {
    let mut text = String::from(if cell.c == '\0' { ' ' } else { cell.c });
    text.extend(cell.zerowidth().into_iter().flatten());
    text
}

fn push_span(row: &mut Row, column: usize, cells: usize, text: String, style: Style) {
    if let Some(last) = row.spans.last_mut()
        && last.style == style
        && last.column + last.cells == column
        && cells == 1
        && last.cells == last.text.chars().count()
    {
        last.cells += 1;
        last.text.push_str(&text);
        return;
    }
    row.spans.push(Span { column, cells, text, style });
}

fn push_fill(row: &mut Row, column: usize, cells: usize, color: Hsla) {
    if let Some(last) = row.fills.last_mut()
        && last.color == color
        && last.column + last.cells == column
    {
        last.cells += cells;
        return;
    }
    row.fills.push(Fill { column, cells, color });
}

/// Reads the visible screen of `term`.
pub fn snapshot<T: alacritty_terminal::event::EventListener>(term: &Term<T>, palette: &Palette) -> Frame {
    let content = term.renderable_content();
    let offset = content.display_offset as i32;
    let selection = content.selection;
    let cursor_point = content.cursor.point;
    let cursor_shape = content.cursor.shape;
    let mut rows: Vec<Row> = (0..term.screen_lines()).map(|_| Row::default()).collect();
    let mut cursor = None;
    for indexed in content.display_iter {
        let cell = indexed.cell;
        if cell.flags.intersects(Flags::WIDE_CHAR_SPACER | Flags::LEADING_WIDE_CHAR_SPACER) {
            continue;
        }
        let Point { line, column } = indexed.point;
        let Some(row) = usize::try_from(line.0 + offset).ok().and_then(|line| rows.get_mut(line)) else { continue };
        let cells = if cell.flags.contains(Flags::WIDE_CHAR) { 2 } else { 1 };
        let (style, bg) = cell_style(cell, term, palette);
        if selection.is_some_and(|range| range.contains(indexed.point)) {
            push_fill(row, column.0, cells, palette.selection);
        } else if bg != palette.background {
            push_fill(row, column.0, cells, bg);
        }
        let text = cell_text(cell);
        if indexed.point == cursor_point {
            cursor = Some(Cursor { line: (line.0 + offset) as usize, column: column.0, cells, shape: cursor_shape, text: text.clone(), style });
        }
        if text != " " || style.underline || style.strike {
            push_span(row, column.0, cells, text, style);
        }
    }
    Frame { rows, cursor: cursor.filter(|cursor| cursor.shape != CursorShape::Hidden) }
}

#[cfg(test)]
mod tests {
    use alacritty_terminal::event::VoidListener;
    use alacritty_terminal::term::Config;
    use alacritty_terminal::vte::ansi::Processor;

    use super::super::session::GridSize;
    use super::*;

    fn palette() -> Palette {
        Palette::zed(crate::terminal::colors::hex(0x1b1b1b))
    }

    fn frame(bytes: &[u8]) -> Frame {
        let size = GridSize { columns: 20, lines: 4, cell_width: 7, cell_height: 14 };
        let mut term = Term::new(Config::default(), &size, VoidListener);
        let mut parser: Processor = Processor::new();
        parser.advance(&mut term, bytes);
        snapshot(&term, &palette())
    }

    #[test]
    fn like_styled_cells_share_one_span() {
        let frame = frame(b"ab \x1b[31mred\x1b[0m");
        let spans: Vec<(&str, usize)> = frame.rows[0].spans.iter().map(|span| (span.text.as_str(), span.column)).collect();
        assert_eq!(spans, [("ab", 0), ("red", 3)]);
        assert_ne!(frame.rows[0].spans[0].style.color, frame.rows[0].spans[1].style.color);
    }

    #[test]
    fn backgrounds_become_fills_and_the_cursor_follows_output() {
        let frame = frame(b"\x1b[44mhi\x1b[0m\r\nx");
        assert_eq!(frame.rows[0].fills.len(), 1);
        assert_eq!(frame.rows[0].fills[0].cells, 2);
        let cursor = frame.cursor.unwrap();
        assert_eq!((cursor.line, cursor.column), (1, 1));
    }

    #[test]
    fn a_wide_glyph_is_its_own_two_cell_span() {
        let frame = frame("a界b".as_bytes());
        let spans: Vec<(&str, usize, usize)> = frame.rows[0].spans.iter().map(|span| (span.text.as_str(), span.column, span.cells)).collect();
        assert_eq!(spans, [("a", 0, 1), ("界", 1, 2), ("b", 3, 1)]);
    }
}
