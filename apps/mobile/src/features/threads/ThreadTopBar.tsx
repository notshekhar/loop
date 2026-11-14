/**
 * A full-width strip pinned just under a chat's header — the team bar and
 * the side-thread bar both sit here. It is part of the layout, not a floating
 * pill: the feed is told its height (`THREAD_TOP_BAR_HEIGHT`) and starts below
 * it, so it never covers a message.
 */
import { HeaderHeightContext } from "@react-navigation/elements";
import { useContext, type ReactNode } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

/** The bar's height; the feed adds it to its top inset. */
export const THREAD_TOP_BAR_HEIGHT = 40;

export function ThreadTopBar(props: {
  /**
   * True when the feed scrolls under a transparent native header (iOS glass):
   * the bar then sits at the header's bottom edge. Otherwise the screen's
   * content already starts below the header, and so does the bar.
   */
  readonly underTransparentHeader: boolean;
  readonly children: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const headerHeight = useContext(HeaderHeightContext);
  const top = props.underTransparentHeader ? headerHeight || insets.top + 44 : 0;
  return (
    <View
      className="absolute inset-x-0 z-20 flex-row items-center border-b border-border bg-screen px-3"
      style={{ top, height: THREAD_TOP_BAR_HEIGHT }}
    >
      {props.children}
    </View>
  );
}
