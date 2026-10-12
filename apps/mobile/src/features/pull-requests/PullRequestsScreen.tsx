/**
 * The project's pull requests, read through `gh` on the host: open, closed,
 * merged or all, and all / yours / waiting on your review. A row shows what a
 * glance needs — state, checks, review, size, age — and opens the PR.
 */
import type {
  LoopPullRequestInvolvement,
  LoopPullRequestListState,
  LoopPullRequestSummary,
} from "@loop/contracts";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import * as Haptics from "expo-haptics";
import { useState } from "react";
import { Pressable, RefreshControl, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { useThemeColor } from "../../lib/useThemeColor";
import { useSelectedThreadWorktree } from "../../state/use-selected-thread-worktree";
import {
  checksTone,
  formatChangeSize,
  reviewLabel,
  shortAge,
  stateTone,
} from "./pullRequestPresentation";
import { usePullRequestList } from "./usePullRequests";

type Props = StaticScreenProps<{ readonly environmentId: string; readonly threadId: string }>;

const STATES: ReadonlyArray<{ readonly value: LoopPullRequestListState; readonly label: string }> = [
  { value: "open", label: "Open" },
  { value: "merged", label: "Merged" },
  { value: "closed", label: "Closed" },
  { value: "all", label: "All" },
];
const INVOLVEMENT: ReadonlyArray<{ readonly value: LoopPullRequestInvolvement; readonly label: string }> = [
  { value: "all", label: "Everyone" },
  { value: "authored", label: "Mine" },
  { value: "reviewing", label: "To review" },
];

function Chip(props: { readonly label: string; readonly active: boolean; readonly onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: props.active }}
      onPress={props.onPress}
      className={
        props.active
          ? "rounded-full bg-primary px-3.5 py-1.5"
          : "rounded-full border border-border bg-card px-3.5 py-1.5 active:opacity-70"
      }
    >
      <Text
        className={
          props.active
            ? "text-xs font-t3-bold text-primary-foreground"
            : "text-xs font-t3-medium text-foreground"
        }
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

function Row(props: { readonly pr: LoopPullRequestSummary; readonly onPress: () => void }) {
  const { pr } = props;
  const state = stateTone(pr);
  const checks = checksTone(pr.checks);
  const review = reviewLabel(pr.reviewDecision);
  const chevron = useThemeColor("--color-icon-subtle");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Pull request ${pr.number}: ${pr.title}`}
      onPress={props.onPress}
      className="flex-row gap-3 px-4 py-3.5 active:bg-subtle"
    >
      <View className={`mt-1.5 size-2.5 rounded-full ${state.dotClass}`} />
      <View className="flex-1 gap-1">
        <Text className="text-[15px] font-t3-bold leading-5 text-foreground" numberOfLines={2}>
          {pr.title}
        </Text>
        <Text className="text-xs font-t3-medium text-foreground-muted" numberOfLines={1}>
          #{pr.number}
          {pr.author ? ` · ${pr.author.login}` : ""} · {pr.headRef} · {shortAge(pr.updatedAt)}
        </Text>
        <View className="flex-row flex-wrap items-center gap-x-3 gap-y-1">
          <Text className={`text-xs font-t3-bold ${state.textClass}`}>{state.label}</Text>
          {checks ? (
            <View className="flex-row items-center gap-1">
              <View className={`size-1.5 rounded-full ${checks.dotClass}`} />
              <Text className={`text-xs font-t3-medium ${checks.textClass}`}>{checks.label}</Text>
            </View>
          ) : null}
          {review ? <Text className="text-xs font-t3-medium text-foreground-muted">{review}</Text> : null}
          <Text className="text-xs tabular-nums text-foreground-muted">
            {formatChangeSize(pr.additions, pr.deletions)}
          </Text>
        </View>
      </View>
      <SymbolView name="chevron.right" size={12} tintColor={chevron} type="monochrome" />
    </Pressable>
  );
}

export function PullRequestsScreen(props: Props) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { environmentId, threadId } = props.route.params;
  const { selectedThreadCwd } = useSelectedThreadWorktree();
  const [state, setState] = useState<LoopPullRequestListState>("open");
  const [involvement, setInvolvement] = useState<LoopPullRequestInvolvement>("all");
  const list = usePullRequestList(environmentId, selectedThreadCwd, { state, involvement });
  const rows = list.data ?? [];

  const pick = <T,>(set: (value: T) => void, value: T) => {
    void Haptics.selectionAsync();
    set(value);
  };

  return (
    <ScrollView
      className="flex-1 bg-screen"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 16) + 16 }}
      refreshControl={<RefreshControl refreshing={list.isPending && rows.length > 0} onRefresh={list.refresh} />}
    >
      <View className="gap-2 px-4 pt-3 pb-2">
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
          {STATES.map((s) => (
            <Chip key={s.value} label={s.label} active={state === s.value} onPress={() => pick(setState, s.value)} />
          ))}
        </ScrollView>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
          {INVOLVEMENT.map((s) => (
            <Chip
              key={s.value}
              label={s.label}
              active={involvement === s.value}
              onPress={() => pick(setInvolvement, s.value)}
            />
          ))}
        </ScrollView>
      </View>

      {list.error ? (
        <View className="px-4 pt-6">
          <EmptyState
            title="Couldn't load pull requests"
            detail={list.error}
            actionLabel="Try again"
            onAction={list.refresh}
          />
        </View>
      ) : rows.length === 0 && list.isPending ? (
        <View className="px-4 pt-10">
          <Text className="text-center text-sm font-t3-medium text-foreground-muted">Loading pull requests…</Text>
        </View>
      ) : rows.length === 0 ? (
        <View className="px-4 pt-6">
          <EmptyState
            title="No pull requests"
            detail={
              involvement === "reviewing"
                ? "Nothing is waiting on your review."
                : involvement === "authored"
                  ? "You have no pull requests here."
                  : `No ${state === "all" ? "" : `${state} `}pull requests in this repository.`
            }
          />
        </View>
      ) : (
        <View className="mx-4 mt-1 overflow-hidden rounded-[18px] border border-border bg-card">
          {rows.map((pr, index) => (
            <View key={pr.number}>
              {index > 0 ? <View className="ml-9 h-px bg-border" /> : null}
              <Row
                pr={pr}
                onPress={() => {
                  void Haptics.selectionAsync();
                  navigation.navigate("ThreadPullRequest", {
                    environmentId,
                    threadId,
                    number: String(pr.number),
                  });
                }}
              />
            </View>
          ))}
        </View>
      )}
    </ScrollView>
  );
}
