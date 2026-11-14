/**
 * `/btw` side questions asked from this chat, on the phone. Each answers in
 * its own thread (loop copies the chat and asks there), so this chat's model
 * never sees them; the card shows the answer as it streams, above the
 * composer, until it is dismissed. "Open" goes to the side thread to follow up.
 */
import { useNavigation } from "@react-navigation/native";
import * as Haptics from "expo-haptics";
import { Pressable, View } from "react-native";
import Animated, { FadeInDown, FadeOut } from "react-native-reanimated";

import {
  btwStatusOf,
  clientThreadIdFor,
  dismissBtwThread,
  useBtwThreads,
  type BtwStatus,
  type BtwThreadView,
} from "@loop/btw";
import { SymbolView } from "../../../components/AppSymbol";
import { AppText as Text } from "../../../components/AppText";
import { useThemeColor } from "../../../lib/useThemeColor";

/** Lines of answer a card shows; the thread holds the rest. */
const ANSWER_LINES = 6;

/** Each status as the card's trailing word. */
const STATUS_WORD: Record<BtwStatus, string> = {
  thinking: "thinking…",
  answering: "answering…",
  answered: "answered",
  failed: "failed",
};

function BtwCard(props: { readonly view: BtwThreadView; readonly environmentId: string }) {
  const navigation = useNavigation();
  const tint = useThemeColor("--color-icon-subtle");
  const { view } = props;
  return (
    <Animated.View
      entering={FadeInDown.duration(200)}
      exiting={FadeOut.duration(120)}
      className="gap-1.5 rounded-2xl border border-border bg-card px-3 py-2.5"
    >
      <View className="flex-row items-center gap-2">
        <SymbolView name="arrow.turn.down.right" size={11} tintColor={tint} type="monochrome" />
        <Text className="flex-1 text-[13px] font-t3-bold text-foreground" numberOfLines={1}>
          {view.thread.question}
        </Text>
        <Text className="text-xs font-t3-medium text-foreground-muted">{STATUS_WORD[btwStatusOf(view)]}</Text>
        <Pressable
          accessibilityLabel="Dismiss side question"
          accessibilityRole="button"
          hitSlop={8}
          onPress={() => dismissBtwThread(view.thread.sessionId)}
          className="active:opacity-60"
        >
          <SymbolView name="xmark" size={11} tintColor={tint} type="monochrome" />
        </Pressable>
      </View>
      {view.error || view.answer ? (
        <Text className="text-sm text-foreground" numberOfLines={ANSWER_LINES}>
          {view.error ?? view.answer}
        </Text>
      ) : null}
      <Pressable
        accessibilityRole="button"
        onPress={() => {
          void Haptics.selectionAsync();
          navigation.navigate("Thread", {
            environmentId: props.environmentId,
            threadId: clientThreadIdFor(view.thread.sessionId),
          });
        }}
        className="self-start active:opacity-60"
      >
        <Text className="text-xs font-t3-medium text-foreground-muted">
          Not part of this chat · open to follow up
        </Text>
      </Pressable>
    </Animated.View>
  );
}

export function ThreadBtwCards(props: { readonly environmentId: string; readonly threadId: string }) {
  const views = useBtwThreads(props.threadId);
  if (views.length === 0) return null;
  return (
    <View className="shrink-0 gap-2 px-4 pb-3">
      {views.map((view) => (
        <BtwCard key={view.thread.sessionId} view={view} environmentId={props.environmentId} />
      ))}
    </View>
  );
}
