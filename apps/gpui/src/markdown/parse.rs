//! Markdown → a small block tree the renderer walks. Pure, so it is tested
//! without a window.

use std::ops::Range;

use pulldown_cmark::{CodeBlockKind, Event, HeadingLevel, Options, Parser, Tag, TagEnd};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Style {
    pub bold: bool,
    pub italic: bool,
    pub code: bool,
    pub strike: bool,
}

/// A styled span of an inline run, as a byte range into `Inline::text`.
#[derive(Debug, Clone, PartialEq)]
pub struct Span {
    pub range: Range<usize>,
    pub style: Style,
    pub link: Option<String>,
}

/// One paragraph's worth of text with its styling.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Inline {
    pub text: String,
    pub spans: Vec<Span>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Block {
    Paragraph(Inline),
    Heading(u8, Inline),
    Code { language: Option<String>, text: String },
    List { start: Option<u64>, items: Vec<Vec<Block>> },
    Quote(Vec<Block>),
    Table(Vec<Vec<Inline>>),
    Rule,
}

pub fn parse(source: &str) -> Vec<Block> {
    let options = Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS;
    let mut builder = Builder::default();
    for event in Parser::new_ext(source, options) {
        builder.event(event);
    }
    builder.finish()
}

/// A container being filled: the document, a list item, a quote.
enum Frame {
    Blocks(Vec<Block>),
    List { start: Option<u64>, items: Vec<Vec<Block>> },
    Table(Vec<Vec<Inline>>),
}

#[derive(Default)]
struct Builder {
    frames: Vec<Frame>,
    inline: Option<Inline>,
    styles: Vec<Style>,
    links: Vec<String>,
    code: Option<(Option<String>, String)>,
    heading: Option<u8>,
}

impl Builder {
    fn blocks(&mut self) -> &mut Vec<Block> {
        if !matches!(self.frames.last(), Some(Frame::Blocks(_))) {
            self.frames.push(Frame::Blocks(Vec::new()));
        }
        match self.frames.last_mut() {
            Some(Frame::Blocks(blocks)) => blocks,
            _ => unreachable!("a blocks frame was just ensured"),
        }
    }

    fn style(&self) -> Style {
        self.styles.last().copied().unwrap_or_default()
    }

    fn push_style(&mut self, edit: impl FnOnce(&mut Style)) {
        let mut style = self.style();
        edit(&mut style);
        self.styles.push(style);
    }

    fn text(&mut self, text: &str, extra: impl FnOnce(&mut Style)) {
        let mut style = self.style();
        extra(&mut style);
        let link = self.links.last().cloned();
        let inline = self.inline.get_or_insert_default();
        let start = inline.text.len();
        inline.text.push_str(text);
        inline.spans.push(Span { range: start..inline.text.len(), style, link });
    }

    /// Text outside a paragraph (a tight list item) still needs one.
    fn flush_inline(&mut self) {
        if let Some(inline) = self.inline.take().filter(|inline| !inline.text.is_empty()) {
            let block = match self.heading.take() {
                Some(level) => Block::Heading(level, inline),
                None => Block::Paragraph(inline),
            };
            self.blocks().push(block);
        }
    }

    fn event(&mut self, event: Event) {
        if let Some((_, code)) = &mut self.code {
            match event {
                Event::Text(text) => code.push_str(&text),
                Event::End(TagEnd::CodeBlock) => {
                    let (language, mut text) = self.code.take().expect("inside a code block");
                    if text.ends_with('\n') {
                        text.pop();
                    }
                    self.blocks().push(Block::Code { language, text });
                }
                _ => {}
            }
            return;
        }
        match event {
            Event::Start(tag) => self.start(tag),
            Event::End(tag) => self.end(tag),
            Event::Text(text) => self.text(&text, |_| {}),
            Event::Code(text) => self.text(&text, |style| style.code = true),
            Event::SoftBreak => self.text(" ", |_| {}),
            Event::HardBreak => self.text("\n", |_| {}),
            Event::Rule => {
                self.flush_inline();
                self.blocks().push(Block::Rule);
            }
            Event::TaskListMarker(done) => self.text(if done { "☑ " } else { "☐ " }, |_| {}),
            Event::Html(html) | Event::InlineHtml(html) => self.text(&html, |_| {}),
            _ => {}
        }
    }

    fn start(&mut self, tag: Tag) {
        match tag {
            Tag::Paragraph => self.flush_inline(),
            Tag::Heading { level, .. } => {
                self.flush_inline();
                self.heading = Some(heading_level(level));
            }
            Tag::CodeBlock(kind) => {
                self.flush_inline();
                let language = match kind {
                    CodeBlockKind::Fenced(info) => info.split_whitespace().next().map(str::to_string),
                    CodeBlockKind::Indented => None,
                };
                self.code = Some((language, String::new()));
            }
            Tag::List(start) => {
                self.flush_inline();
                self.frames.push(Frame::List { start, items: Vec::new() });
            }
            Tag::Item | Tag::BlockQuote(_) => {
                self.flush_inline();
                self.frames.push(Frame::Blocks(Vec::new()));
            }
            Tag::Table(_) => {
                self.flush_inline();
                self.frames.push(Frame::Table(Vec::new()));
            }
            Tag::TableHead | Tag::TableRow => {
                if let Some(Frame::Table(rows)) = self.frames.last_mut() {
                    rows.push(Vec::new());
                }
            }
            Tag::TableCell => self.inline = Some(Inline::default()),
            Tag::Emphasis => self.push_style(|style| style.italic = true),
            Tag::Strong => self.push_style(|style| style.bold = true),
            Tag::Strikethrough => self.push_style(|style| style.strike = true),
            Tag::Link { dest_url, .. } => self.links.push(dest_url.to_string()),
            _ => {}
        }
    }

    fn end(&mut self, tag: TagEnd) {
        match tag {
            TagEnd::Paragraph | TagEnd::Heading(_) => self.flush_inline(),
            TagEnd::Item => {
                self.flush_inline();
                let item = self.pop_blocks();
                if let Some(Frame::List { items, .. }) = self.frames.last_mut() {
                    items.push(item);
                }
            }
            TagEnd::List(_) => {
                if let Some(Frame::List { start, items }) = self.frames.pop() {
                    self.blocks().push(Block::List { start, items });
                }
            }
            TagEnd::BlockQuote(_) => {
                self.flush_inline();
                let quote = self.pop_blocks();
                self.blocks().push(Block::Quote(quote));
            }
            TagEnd::TableCell => {
                let cell = self.inline.take().unwrap_or_default();
                if let Some(Frame::Table(rows)) = self.frames.last_mut()
                    && let Some(row) = rows.last_mut()
                {
                    row.push(cell);
                }
            }
            TagEnd::Table => {
                if let Some(Frame::Table(rows)) = self.frames.pop() {
                    self.blocks().push(Block::Table(rows));
                }
            }
            TagEnd::Emphasis | TagEnd::Strong | TagEnd::Strikethrough => {
                self.styles.pop();
            }
            TagEnd::Link => {
                self.links.pop();
            }
            _ => {}
        }
    }

    fn pop_blocks(&mut self) -> Vec<Block> {
        match self.frames.pop() {
            Some(Frame::Blocks(blocks)) => blocks,
            Some(other) => {
                self.frames.push(other);
                Vec::new()
            }
            None => Vec::new(),
        }
    }

    fn finish(mut self) -> Vec<Block> {
        self.flush_inline();
        // An unterminated fence while streaming still shows what is there.
        if let Some((language, text)) = self.code.take() {
            self.blocks().push(Block::Code { language, text });
        }
        let mut document = Vec::new();
        for frame in self.frames {
            if let Frame::Blocks(blocks) = frame {
                document.extend(blocks);
            }
        }
        document
    }
}

fn heading_level(level: HeadingLevel) -> u8 {
    match level {
        HeadingLevel::H1 => 1,
        HeadingLevel::H2 => 2,
        HeadingLevel::H3 => 3,
        HeadingLevel::H4 => 4,
        HeadingLevel::H5 => 5,
        HeadingLevel::H6 => 6,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paragraphs_carry_their_inline_styles() {
        let blocks = parse("Hello **bold** and `code` [link](https://x.dev)");
        let [Block::Paragraph(inline)] = blocks.as_slice() else { panic!("{blocks:?}") };
        assert_eq!(inline.text, "Hello bold and code link");
        let bold = inline.spans.iter().find(|span| span.style.bold).unwrap();
        assert_eq!(&inline.text[bold.range.clone()], "bold");
        let link = inline.spans.iter().find(|span| span.link.is_some()).unwrap();
        assert_eq!(&inline.text[link.range.clone()], "link");
    }

    #[test]
    fn lists_code_and_headings_nest() {
        let blocks = parse("# Title\n\n- one\n- two\n  - nested\n\n```rust\nfn x() {}\n```\n");
        assert!(matches!(&blocks[0], Block::Heading(1, inline) if inline.text == "Title"));
        let Block::List { items, start: None } = &blocks[1] else { panic!("{blocks:?}") };
        assert_eq!(items.len(), 2);
        assert!(matches!(items[1].last(), Some(Block::List { .. })));
        assert!(matches!(&blocks[2], Block::Code { language: Some(lang), text } if lang == "rust" && text == "fn x() {}"));
    }

    #[test]
    fn an_unclosed_fence_while_streaming_still_shows() {
        let blocks = parse("text\n\n```\nlet a = 1;");
        assert!(matches!(blocks.last(), Some(Block::Code { text, .. }) if text.contains("let a")));
    }

    #[test]
    fn tables_keep_rows_and_cells() {
        let blocks = parse("| a | b |\n|---|---|\n| 1 | 2 |\n");
        let [Block::Table(rows)] = blocks.as_slice() else { panic!("{blocks:?}") };
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[1][1].text, "2");
    }
}
