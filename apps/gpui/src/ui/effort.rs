//! loop's thinking control: a "Faster … Smarter" slider with one stop per
//! level, coloured from green to orange so the amount reads before the label.

use gpui::{
    App, ClickEvent, FontWeight, Hsla, InteractiveElement, IntoElement, ParentElement, SharedString,
    StatefulInteractiveElement, Styled, Window, div, prelude::FluentBuilder, px, relative,
};

use crate::catalog::THINKING_LEVELS;
use crate::theme::ActiveTheme;
use crate::ui::controls::popover;

/// loop's `--effort-faster` and `--effort-smarter`.
const FASTER: u32 = 0x10b981;
const SMARTER: u32 = 0xe8743b;
/// Half a stop: the rail is inset by this so the end stops sit inside the
/// track's rounded ends.
const STOP: f32 = 20.;

pub fn level_label(level: &str) -> &'static str {
    match level {
        "off" => "Off",
        "minimal" => "Minimal",
        "low" => "Low",
        "medium" => "Medium",
        "high" => "High",
        _ => "Extra high",
    }
}

/// The level's colour: CSS `color-mix(in oklch, smarter f%, faster)`,
/// exactly as loop computes it, so the middle reads gold, not lime.
pub fn level_color(fraction: f32) -> Hsla {
    let (from, to) = (oklch(FASTER), oklch(SMARTER));
    let mut turn = to[2] - from[2];
    if turn.abs() > 180. {
        turn -= 360. * turn.signum();
    }
    let lightness = from[0] + (to[0] - from[0]) * fraction;
    let chroma = from[1] + (to[1] - from[1]) * fraction;
    let hue = (from[2] + turn * fraction).to_radians();
    srgb_from_oklab([lightness, chroma * hue.cos(), chroma * hue.sin()])
}

/// `color-mix(in srgb, a share, b)`.
fn mix(a: Hsla, b: Hsla, share: f32) -> Hsla {
    let (a, b) = (a.to_rgb(), b.to_rgb());
    let channel = |x: f32, y: f32| x * share + y * (1. - share);
    gpui::Rgba { r: channel(a.r, b.r), g: channel(a.g, b.g), b: channel(a.b, b.b), a: 1. }.into()
}

/// Björn Ottosson's sRGB → OKLab matrices (the ones CSS Color 4 uses).
fn oklch(hex: u32) -> [f32; 3] {
    let channel = |shift: u32| {
        let value = ((hex >> shift) & 0xff) as f32 / 255.;
        if value <= 0.04045 { value / 12.92 } else { ((value + 0.055) / 1.055).powf(2.4) }
    };
    let (r, g, b) = (channel(16), channel(8), channel(0));
    let l = (0.412_221_46 * r + 0.536_332_55 * g + 0.051_445_995 * b).cbrt();
    let m = (0.211_903_5 * r + 0.680_699_5 * g + 0.107_396_96 * b).cbrt();
    let s = (0.088_302_46 * r + 0.281_718_85 * g + 0.629_978_7 * b).cbrt();
    let lab_l = 0.210_454_26 * l + 0.793_617_8 * m - 0.004_072_047 * s;
    let lab_a = 1.977_998_5 * l - 2.428_592_2 * m + 0.450_593_7 * s;
    let lab_b = 0.025_904_037 * l + 0.782_771_77 * m - 0.808_675_77 * s;
    [lab_l, lab_a.hypot(lab_b), lab_b.atan2(lab_a).to_degrees()]
}

fn srgb_from_oklab([lab_l, lab_a, lab_b]: [f32; 3]) -> Hsla {
    let l = (lab_l + 0.396_337_78 * lab_a + 0.215_803_76 * lab_b).powi(3);
    let m = (lab_l - 0.105_561_346 * lab_a - 0.063_854_17 * lab_b).powi(3);
    let s = (lab_l - 0.089_484_18 * lab_a - 1.291_485_5 * lab_b).powi(3);
    let encode = |linear: f32| {
        let value = if linear <= 0.003_130_8 { 12.92 * linear } else { 1.055 * linear.powf(1. / 2.4) - 0.055 };
        value.clamp(0., 1.)
    };
    let r = encode(4.076_741_7 * l - 3.307_711_6 * m + 0.230_969_94 * s);
    let g = encode(-1.268_438 * l + 2.609_757_4 * m - 0.341_319_38 * s);
    let b = encode(-0.004_196_086_3 * l - 0.703_418_6 * m + 1.707_614_7 * s);
    gpui::Rgba { r, g, b, a: 1. }.into()
}

/// The popover: `Thinking Medium`, the Faster/Smarter ends, then the slider.
pub fn effort_slider(selected: &'static str, cx: &App, on_pick: impl Fn(&'static str, &mut Window, &mut App) + Clone + 'static) -> impl IntoElement {
    let theme = cx.theme();
    let index = THINKING_LEVELS.iter().position(|level| *level == selected).unwrap_or(0);
    let fraction = index as f32 / (THINKING_LEVELS.len() - 1) as f32;
    let color = level_color(fraction);
    let passed = mix(color, theme.text, 0.7);
    let stops = THINKING_LEVELS.iter().enumerate().map(|(ix, level)| {
        let on_pick = on_pick.clone();
        let at = ix as f32 / (THINKING_LEVELS.len() - 1) as f32;
        div()
            .id(SharedString::from(format!("effort-{level}")))
            .absolute()
            .top_0()
            .left(relative(at))
            .ml(px(-STOP / 2.))
            .size(px(STOP))
            .flex()
            .items_center()
            .justify_center()
            .cursor_pointer()
            .when(ix != index, |stop| stop.child(div().size(px(4.)).rounded_full().bg(if ix < index { passed } else { theme.muted.opacity(0.45) })))
            .on_click(move |_: &ClickEvent, window, cx| on_pick(level, window, cx))
    });
    let fill = div()
        .absolute()
        .top_0()
        .bottom_0()
        .left(px(-STOP / 2.))
        .w(relative(fraction))
        .rounded_l(px(8.))
        .bg(color.opacity(0.28))
        .child(div().absolute().top_0().bottom_0().right(px(-STOP)).w(px(STOP)).rounded_r(px(8.)).bg(color.opacity(0.28)));
    let thumb = div()
        .absolute()
        .top(px(2.))
        .left(relative(fraction))
        .ml(px(-5.))
        .w(px(10.))
        .h(px(16.))
        .rounded(px(4.))
        .border(px(1.5))
        .border_color(color)
        .bg(theme.background)
        .shadow_sm();
    // loop's panel is 240px with 8px sides inside a menu's 4px padding.
    popover(cx)
        .w(px(248.))
        .px_3()
        .pt(px(10.))
        .pb_3()
        .child(div().flex().gap_1p5().text_xs().child(div().text_color(theme.muted).child("Thinking")).child(div().font_weight(FontWeight::MEDIUM).text_color(color).child(level_label(selected))))
        .child(div().mt_2p5().flex().justify_between().text_size(px(11.)).text_color(theme.muted).child("Faster").child("Smarter"))
        .child(
            div()
                .mt_1p5()
                .h(px(STOP))
                .rounded(px(8.))
                .bg(theme.selected)
                .child(div().relative().mx(px(STOP / 2.)).h_full().child(fill).children(stops).child(thumb)),
        )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(color: Hsla) -> u32 {
        let rgba = color.to_rgb();
        let byte = |v: f32| (v * 255.).round() as u32;
        byte(rgba.r) << 16 | byte(rgba.g) << 8 | byte(rgba.b)
    }

    #[test]
    fn the_ends_are_loops_colours() {
        let close = |a: u32, b: u32| (0..3).all(|i| ((a >> (i * 8)) & 0xff).abs_diff((b >> (i * 8)) & 0xff) <= 1);
        assert!(close(hex(level_color(0.)), FASTER), "{:06x}", hex(level_color(0.)));
        assert!(close(hex(level_color(1.)), SMARTER), "{:06x}", hex(level_color(1.)));
    }

    #[test]
    fn medium_is_gold_like_loop() {
        let medium: Hsla = level_color(0.6);
        let hue = medium.h * 360.;
        assert!((30. ..60.).contains(&hue), "medium should read gold, got hue {hue} ({:06x})", hex(medium));
    }
}
