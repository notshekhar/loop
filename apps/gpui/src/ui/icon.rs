use gpui::{Hsla, Pixels, Styled, Svg, px, svg};

use crate::assets::{Icon, provider_logo};

/// Icons are 16px in loop's rows and controls.
pub const ICON_SIZE: Pixels = px(16.);

pub fn icon(icon: Icon, color: Hsla) -> Svg {
    sized_icon(icon, ICON_SIZE, color)
}

pub fn sized_icon(icon: Icon, size: Pixels, color: Hsla) -> Svg {
    svg().path(icon.path()).size(size).flex_none().text_color(color)
}

/// A provider's logo, when loop has one for it.
pub fn provider_icon(provider: &str, size: Pixels, color: Hsla) -> Option<Svg> {
    provider_logo(provider).map(|path| svg().path(path).size(size).flex_none().text_color(color))
}
