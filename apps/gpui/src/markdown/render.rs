//! Draws parsed markdown the way loop's ChatMarkdown styles it (apps/web
//! index.css `.chat-markdown`): 14px prose on a 22.75px line, blocks 10.4px
//! apart with margins collapsing as CSS's do.

use gpui::{
    AnyElement, App, ClipboardItem, FontStyle, FontWeight, HighlightStyle, InteractiveElement,
    InteractiveText, IntoElement, ParentElement, SharedString, StatefulInteractiveElement,
    StrikethroughStyle, Styled, StyledText, div, prelude::FluentBuilder, px, relative,
};

use super::parse::{Block, Inline, Style};
use crate::assets::Icon;
use crate::theme::{ActiveTheme, PROSE_LINE_HEIGHT};
use crate::ui::controls::ghost_icon_button;

/// `.chat-markdown` block margin: 0.65em of 16px.
const BLOCK_MARGIN: f32 = 10.4;

/// Draws parsed markdown. `id` must be unique in the window: links and copy
/// buttons hang off element ids derived from it.
pub fn render_markdown(id: &str, blocks: &[Block], cx: &App) -> AnyElement {
    let theme = cx.theme();
    div().text_sm().line_height(relative(PROSE_LINE_HEIGHT)).text_color(theme.prose).child(render_blocks(id, blocks, 0, cx)).into_any_element()
}

/// A block's top and bottom margins.
fn margins(block: &Block) -> (f32, f32) {
    match block {
        Block::Heading(..) => (20., 8.),
        Block::Rule => (0., 0.),
        _ => (BLOCK_MARGIN, BLOCK_MARGIN),
    }
}

/// Blocks in a column, each gap the larger of the two margins that meet;
/// the first and last lose their outer margins.
fn render_blocks(id: &str, blocks: &[Block], depth: usize, cx: &App) -> AnyElement {
    let mut column = div().flex().flex_col();
    let mut below_previous: Option<f32> = None;
    for (ix, block) in blocks.iter().enumerate() {
        let (top, bottom) = margins(block);
        let gap = below_previous.map_or(0., |below| below.max(top));
        column = column.child(div().pt(px(gap)).child(render_block(&format!("{id}-{ix}"), block, depth, cx)));
        below_previous = Some(bottom);
    }
    column.into_any_element()
}

fn render_block(id: &str, block: &Block, depth: usize, cx: &App) -> AnyElement {
    let theme = cx.theme();
    match block {
        Block::Paragraph(inline) => render_inline(id, inline, cx),
        Block::Heading(level, inline) => {
            let size = match level {
                1 => 20.,
                2 => 18.,
                3 => 16.,
                _ => 14.,
            };
            div()
                .text_size(px(size))
                .line_height(relative(1.3))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(if *level == 6 { theme.muted } else { theme.text })
                .child(render_inline(id, inline, cx))
                .into_any_element()
        }
        Block::Code { language, text } => render_code(id, language.as_deref(), text, cx),
        Block::List { start, items } => div()
            .flex()
            .flex_col()
            .gap_1()
            .children(items.iter().enumerate().map(|(ix, item)| {
                div()
                    .flex()
                    .child(div().flex_none().w(px(20.)).pr_1p5().flex().justify_end().text_color(theme.prose).child(marker(*start, ix, depth)))
                    .child(div().flex_1().min_w_0().child(render_blocks(&format!("{id}-{ix}"), item, depth + 1, cx)))
            }))
            .into_any_element(),
        Block::Quote(blocks) => div().pl(px(12.8)).border_l_2().border_color(theme.border).text_color(theme.muted).child(render_blocks(id, blocks, depth, cx)).into_any_element(),
        Block::Table(rows) => render_table(id, rows, cx),
        Block::Rule => div().h(px(1.)).bg(theme.border).into_any_element(),
    }
}

/// CSS list markers: disc, circle, square by depth; numbers as decimal,
/// lower-alpha, lower-roman.
fn marker(start: Option<u64>, ix: usize, depth: usize) -> String {
    let Some(first) = start else {
        return ["•", "◦", "▪"][depth.min(2)].to_string();
    };
    let n = first + ix as u64;
    match depth % 3 {
        0 => format!("{n}."),
        1 => format!("{}.", alpha(n)),
        _ => format!("{}.", roman(n)),
    }
}

fn alpha(mut n: u64) -> String {
    let mut letters = Vec::new();
    while n > 0 {
        n -= 1;
        letters.push((b'a' + (n % 26) as u8) as char);
        n /= 26;
    }
    letters.iter().rev().collect()
}

fn roman(mut n: u64) -> String {
    const NUMERALS: [(u64, &str); 13] = [(1000, "m"), (900, "cm"), (500, "d"), (400, "cd"), (100, "c"), (90, "xc"), (50, "l"), (40, "xl"), (10, "x"), (9, "ix"), (5, "v"), (4, "iv"), (1, "i")];
    let mut out = String::new();
    for (value, numeral) in NUMERALS {
        while n >= value {
            out.push_str(numeral);
            n -= value;
        }
    }
    out
}

/// A fenced block: a header with the language and a copy button, then the
/// code, scrolling sideways rather than wrapping.
fn render_code(id: &str, language: Option<&str>, text: &str, cx: &App) -> AnyElement {
    let theme = cx.theme();
    let copied = text.to_string();
    let header = div()
        .pt_1p5()
        .pr_1p5()
        .pl_3()
        .flex()
        .items_center()
        .justify_between()
        .text_color(theme.text.opacity(0.72))
        .child(div().font_family(theme.mono_font).text_size(px(11.)).child(language.unwrap_or_default().to_string()))
        .child(ghost_icon_button(SharedString::from(format!("{id}-copy")), Icon::Copy, cx).on_click(move |_, _, cx| cx.write_to_clipboard(ClipboardItem::new_string(copied.clone()))));
    div()
        .flex()
        .flex_col()
        .overflow_hidden()
        .rounded(px(10.))
        .bg(theme.code_block)
        .child(header)
        .child(
            div()
                .id(SharedString::from(format!("{id}-code")))
                .overflow_x_scroll()
                .px(px(14.4))
                .py(px(12.8))
                .font_family(theme.mono_font)
                .text_size(px(12.))
                .line_height(px(16.5))
                .text_color(theme.text)
                .whitespace_nowrap()
                .child(text.trim_end_matches('\n').to_string()),
        )
        .into_any_element()
}

fn render_table(id: &str, rows: &[Vec<Inline>], cx: &App) -> AnyElement {
    let theme = cx.theme();
    let rule = gpui::rgba(0xffffff0b);
    div()
        .flex()
        .flex_col()
        .text_xs()
        .children(rows.iter().enumerate().map(|(row_ix, row)| {
            let header = row_ix == 0;
            div().flex().border_b_1().border_color(rule).when(header, |line| line.font_weight(FontWeight::SEMIBOLD).text_color(theme.text)).children(row.iter().enumerate().map(|(cell_ix, cell)| {
                div()
                    .flex_1()
                    .min_w_0()
                    .px_3()
                    .py(px(if header { 8.8 } else { 7.2 }))
                    .child(render_inline(&format!("{id}-{row_ix}-{cell_ix}"), cell, cx))
            }))
        }))
        .into_any_element()
}

fn highlight(style: Style, link: bool, cx: &App) -> HighlightStyle {
    let theme = cx.theme();
    HighlightStyle {
        font_weight: style.bold.then_some(FontWeight::SEMIBOLD),
        font_style: style.italic.then_some(FontStyle::Italic),
        background_color: style.code.then_some(theme.code_background),
        color: if link { Some(theme.link) } else { style.code.then_some(theme.text) },
        strikethrough: style.strike.then(|| StrikethroughStyle { thickness: px(1.), color: None }),
        ..HighlightStyle::default()
    }
}

fn render_inline(id: &str, inline: &Inline, cx: &App) -> AnyElement {
    let highlights: Vec<_> = inline
        .spans
        .iter()
        .filter(|span| span.style != Style::default() || span.link.is_some())
        .map(|span| (span.range.clone(), highlight(span.style, span.link.is_some(), cx)))
        .collect();
    let text = StyledText::new(SharedString::from(inline.text.clone())).with_highlights(highlights);
    let links: Vec<_> = inline.spans.iter().filter_map(|span| Some((span.range.clone(), span.link.clone()?))).collect();
    if links.is_empty() {
        return text.into_any_element();
    }
    let ranges = links.iter().map(|(range, _)| range.clone()).collect();
    let targets: Vec<String> = links.into_iter().map(|(_, url)| url).collect();
    InteractiveText::new(SharedString::from(id.to_string()), text)
        .on_click(ranges, move |ix, _, cx| cx.open_url(&targets[ix]))
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_markers_follow_css_by_depth() {
        assert_eq!(marker(None, 0, 0), "•");
        assert_eq!(marker(None, 0, 1), "◦");
        assert_eq!(marker(None, 0, 5), "▪");
        assert_eq!(marker(Some(3), 1, 0), "4.");
        assert_eq!(marker(Some(1), 27, 1), "ab.");
        assert_eq!(marker(Some(1), 3, 2), "iv.");
    }
}
