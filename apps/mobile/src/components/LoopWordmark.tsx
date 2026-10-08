import type { ColorValue } from "react-native";
import { Text } from "react-native";

/**
 * loop's wordmark: the name, set in the app's own DM Sans Bold. `height` is
 * the cap height the T3 mark it replaces was laid out for, so headers keep
 * their alignment.
 */
export function LoopWordmark(props: { readonly height: number; readonly color: ColorValue }) {
  return (
    <Text
      accessibilityLabel="loop"
      allowFontScaling={false}
      style={{
        color: props.color,
        fontFamily: "DMSans-Bold",
        fontSize: Math.round(props.height * 1.45),
        lineHeight: Math.round(props.height * 1.6),
        letterSpacing: -0.4,
      }}
    >
      loop
    </Text>
  );
}
