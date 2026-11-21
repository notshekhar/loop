//! loop's ContextRing: a 16px circle that fills clockwise from the top.

use std::f32::consts::{FRAC_PI_2, TAU};

use gpui::{Hsla, IntoElement, PathBuilder, Pixels, Point, Styled, canvas, point, px};
use gpui::{LineCap, PathStyle, StrokeOptions};

const SIZE: f32 = 16.;
const RADIUS: f32 = 6.;
const STROKE: f32 = 2.;

fn stroke() -> PathBuilder {
    PathBuilder::stroke(px(STROKE)).with_style(PathStyle::Stroke(StrokeOptions { line_width: STROKE, line_cap: LineCap::Round, ..Default::default() }))
}

/// The point `turn` of the way round, clockwise from twelve o'clock.
fn at(center: Point<Pixels>, turn: f32) -> Point<Pixels> {
    let angle = turn * TAU - FRAC_PI_2;
    point(center.x + px(RADIUS * angle.cos()), center.y + px(RADIUS * angle.sin()))
}

/// An arc from the top to `turn`, in at most half-turn pieces so a full
/// circle draws too.
fn arc(center: Point<Pixels>, turn: f32) -> PathBuilder {
    let mut path = stroke();
    let radii = point(px(RADIUS), px(RADIUS));
    path.move_to(at(center, 0.));
    let mut done = 0.;
    while done < turn {
        let next = (done + 0.5).min(turn);
        path.arc_to(radii, px(0.), false, true, at(center, next));
        done = next;
    }
    path
}

/// `fraction` of the ring filled in `fill` over a `track` circle; no fill
/// when the window is unknown.
pub fn context_ring(fraction: Option<f64>, track: Hsla, fill: Hsla) -> impl IntoElement {
    canvas(
        |_, _, _| {},
        move |bounds, _, window, _| {
            let center = bounds.center();
            if let Ok(path) = arc(center, 1.).build() {
                window.paint_path(path, track);
            }
            if let Some(fraction) = fraction.filter(|fraction| *fraction > 0.)
                && let Ok(path) = arc(center, fraction.min(1.) as f32).build()
            {
                window.paint_path(path, fill);
            }
        },
    )
    .size(px(SIZE))
    .flex_none()
}
