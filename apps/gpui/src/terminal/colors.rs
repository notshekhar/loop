//! A cell's colour as Zed's terminal paints it: One Dark's terminal colours
//! (assets/themes/one/one.json), the xterm 256 cube, and Zed's minimum
//! contrast so dim colours stay readable.

use alacritty_terminal::term::color::Colors;
use alacritty_terminal::vte::ansi::{Color, NamedColor, Rgb};
use gpui::{Hsla, Rgba};

use super::contrast::ensure_minimum_contrast;

/// `terminal.ansi.*`: black…white, then the bright eight.
const ANSI: [u32; 16] = [
    0x282c34, 0xe06c75, 0x98c379, 0xe5c07b, 0x61afef, 0xc678dd, 0x56b6c2, 0xabb2bf, //
    0x636d83, 0xea858b, 0xaad581, 0xffd885, 0x85c1ff, 0xd398eb, 0x6ed5de, 0xfafafa,
];
/// The first eight as names, to find their dim variants.
const NORMAL: [NamedColor; 8] = [NamedColor::Black, NamedColor::Red, NamedColor::Green, NamedColor::Yellow, NamedColor::Blue, NamedColor::Magenta, NamedColor::Cyan, NamedColor::White];
/// `terminal.ansi.dim_*`.
const DIM: [u32; 8] = [0x3b3f4a, 0xa7545a, 0x6d8f59, 0xb8985b, 0x457cad, 0x8d54a0, 0x3c818a, 0x8f969b];
const FOREGROUND: u32 = 0xabb2bf;
const BRIGHT_FOREGROUND: u32 = 0xdce0e5;
const DIM_FOREGROUND: u32 = 0x636d83;
/// The local player's cursor, and its selection at 24%.
const CURSOR: u32 = 0x74ade8;
const SELECTION_ALPHA: f32 = 0x3d as f32 / 255.;
/// Zed's default `terminal.minimum_contrast` (APCA Lc).
const MINIMUM_CONTRAST: f32 = 45.;

/// The terminal's colours over a given surface; programs can override any
/// of them (OSC 4, 10, 11), which `Colors` carries.
#[derive(Clone, Copy)]
pub struct Palette {
    pub foreground: Hsla,
    pub background: Hsla,
    pub cursor: Hsla,
    pub selection: Hsla,
}

pub fn hex(rgb: u32) -> Hsla {
    Rgba { r: ((rgb >> 16) & 0xff) as f32 / 255., g: ((rgb >> 8) & 0xff) as f32 / 255., b: (rgb & 0xff) as f32 / 255., a: 1. }.into()
}

fn from_rgb(rgb: Rgb) -> Hsla {
    hex((rgb.r as u32) << 16 | (rgb.g as u32) << 8 | rgb.b as u32)
}

/// xterm's 256 colours: the sixteen, a 6×6×6 cube, then 24 greys.
pub fn indexed(index: u8) -> u32 {
    match index {
        0..=15 => ANSI[index as usize],
        16..=231 => {
            let step = |value: u8| if value == 0 { 0 } else { 55 + 40 * value as u32 };
            let cube = index - 16;
            step(cube / 36) << 16 | step(cube / 6 % 6) << 8 | step(cube % 6)
        }
        232..=255 => {
            let grey = 8 + 10 * (index as u32 - 232);
            grey << 16 | grey << 8 | grey
        }
    }
}

impl Palette {
    /// Zed's colours on `background`, the surface the terminal sits on.
    pub fn zed(background: Hsla) -> Self {
        let cursor = hex(CURSOR);
        Self { foreground: hex(FOREGROUND), background, cursor, selection: cursor.opacity(SELECTION_ALPHA) }
    }

    pub fn resolve(&self, color: Color, overrides: &Colors) -> Hsla {
        match color {
            Color::Spec(rgb) => from_rgb(rgb),
            Color::Indexed(index) => overrides[index as usize].map(from_rgb).unwrap_or_else(|| hex(indexed(index))),
            Color::Named(named) => overrides[named].map(from_rgb).unwrap_or_else(|| self.named(named)),
        }
    }

    fn named(&self, named: NamedColor) -> Hsla {
        match named {
            NamedColor::Foreground => self.foreground,
            NamedColor::BrightForeground => hex(BRIGHT_FOREGROUND),
            NamedColor::DimForeground => hex(DIM_FOREGROUND),
            NamedColor::Background => self.background,
            NamedColor::Cursor => self.cursor,
            NamedColor::DimBlack => hex(DIM[0]),
            NamedColor::DimRed => hex(DIM[1]),
            NamedColor::DimGreen => hex(DIM[2]),
            NamedColor::DimYellow => hex(DIM[3]),
            NamedColor::DimBlue => hex(DIM[4]),
            NamedColor::DimMagenta => hex(DIM[5]),
            NamedColor::DimCyan => hex(DIM[6]),
            NamedColor::DimWhite => hex(DIM[7]),
            other => hex(ANSI[other as usize]),
        }
    }

    /// A DIM cell's foreground: the dim variant of a named colour, else the
    /// colour faded, as alacritty does.
    pub fn dimmed(&self, color: Color, overrides: &Colors) -> Hsla {
        let dim = match color {
            Color::Named(named) if (named as usize) < 8 => Color::Named(named.to_dim()),
            Color::Named(NamedColor::Foreground) => Color::Named(NamedColor::DimForeground),
            Color::Indexed(index) if index < 8 => Color::Named(NORMAL[index as usize].to_dim()),
            other => return self.resolve(other, overrides).opacity(0.66),
        };
        self.resolve(dim, overrides)
    }

    /// Text colour nudged until it reads on `background` (Zed's
    /// `minimum_contrast`).
    pub fn readable(&self, text: Hsla, background: Hsla) -> Hsla {
        ensure_minimum_contrast(text, background, MINIMUM_CONTRAST)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::terminal::contrast::apca_contrast;

    #[test]
    fn the_256_table_matches_xterm_over_zeds_sixteen() {
        assert_eq!(indexed(1), 0xe06c75);
        assert_eq!(indexed(21), 0x0000ff);
        assert_eq!(indexed(196), 0xff0000);
        assert_eq!(indexed(232), 0x080808);
        assert_eq!(indexed(255), 0xeeeeee);
    }

    #[test]
    fn a_program_can_override_a_colour() {
        let palette = Palette::zed(hex(0x1b1b1b));
        let mut overrides = Colors::default();
        assert_eq!(palette.resolve(Color::Indexed(1), &overrides), hex(0xe06c75));
        overrides[1] = Some(Rgb { r: 1, g: 2, b: 3 });
        assert_eq!(palette.resolve(Color::Indexed(1), &overrides), hex(0x010203));
        assert_eq!(palette.resolve(Color::Named(NamedColor::Background), &overrides), hex(0x1b1b1b));
    }

    #[test]
    fn dim_uses_the_themes_dim_colours() {
        let palette = Palette::zed(hex(0x1b1b1b));
        assert_eq!(palette.dimmed(Color::Named(NamedColor::Red), &Colors::default()), hex(DIM[1]));
        assert_eq!(palette.dimmed(Color::Named(NamedColor::Foreground), &Colors::default()), hex(DIM_FOREGROUND));
    }

    #[test]
    fn unreadable_text_is_lifted_to_the_minimum_contrast() {
        let palette = Palette::zed(hex(0x1b1b1b));
        let black_on_dark = palette.readable(hex(ANSI[0]), palette.background);
        assert!(apca_contrast(black_on_dark, palette.background).abs() >= MINIMUM_CONTRAST - 1.);
        assert_eq!(palette.readable(palette.foreground, palette.background), palette.foreground);
    }
}
