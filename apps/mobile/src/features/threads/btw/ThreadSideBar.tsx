/**
 * The side-thread bar (a ThreadTopBar) of a `/btw` thread: where the question
 * was asked, and a tap back to that chat. A parent that is no longer listed
 * (archived or deleted) still gets the bar — the feed reserved its height —
 * just without the way back.
 */
import type { EnvironmentId, ThreadId } from "@loop/contracts";
import { scopeThreadRef } from "@loop/runtime/environment";
import { useNavigation } from "@react-navigation/native";
import * as Haptics from "expo-haptics";
import { useMemo } from "react";
import { Pressable } from "react-native";

import { SymbolView } from "../../../components/AppSymbol";
import { AppText as Text } from "../../../components/AppText";
import { useThemeColor } from "../../../lib/useThemeColor";
import { useThreadShell } from "../../../state/entities";
import { ThreadTopBar } from "../ThreadTopBar";

export function ThreadSideBar(props: {
  readonly environmentId: EnvironmentId;
  readonly parentThreadId: ThreadId;
  /** See ThreadTopBar. */
  readonly underTransparentHeader: boolean;
}) {
  const navigation = useNavigation();
  const tint = useThemeColor("--color-icon-subtle");
  const parent = useThreadShell(
    useMemo(
      () => scopeThreadRef(props.environmentId, props.parentThreadId),
      [props.environmentId, props.parentThreadId],
    ),
  );
  return (
    <ThreadTopBar underTransparentHeader={props.underTransparentHeader}>
      <Pressable
        accessibilityLabel={parent ? `Back to ${parent.title}` : "Side question"}
        accessibilityRole="button"
        disabled={!parent}
        onPress={() => {
          void Haptics.selectionAsync();
          navigation.navigate("Thread", {
            environmentId: String(props.environmentId),
            threadId: String(props.parentThreadId),
          });
        }}
        className="h-full flex-1 flex-row items-center gap-2 active:opacity-60"
      >
        <SymbolView name="arrow.turn.left.up" size={11} tintColor={tint} type="monochrome" />
        <Text className="text-xs font-t3-medium text-foreground-muted">Side question from</Text>
        <Text className="flex-1 text-[13px] font-t3-bold text-foreground" numberOfLines={1}>
          {parent?.title ?? "a chat that is no longer listed"}
        </Text>
        {parent ? <SymbolView name="chevron.right" size={11} tintColor={tint} type="monochrome" /> : null}
      </Pressable>
    </ThreadTopBar>
  );
}
