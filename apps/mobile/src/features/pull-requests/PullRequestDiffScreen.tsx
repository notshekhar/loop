/**
 * A pull request's diff: the whole patch, or one file of it. Parsed with the
 * review feature's own unified-diff parser and drawn as a virtualized list of
 * lines — a PR can be tens of thousands of them — with additions and
 * deletions tinted the way the review screen tints them.
 */
import type { StaticScreenProps } from "@react-navigation/native";
import { useMemo } from "react";
import { FlatList, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useSelectedThreadWorktree } from "../../state/use-selected-thread-worktree";
import type { ParsedDiffLine } from "../review/diffParser";
import { diffRows } from "./pullRequestDiff";
import { splitPath } from "./pullRequestPresentation";
import { usePullRequestDiff } from "./usePullRequests";

type Props = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
  readonly number: string;
  readonly path?: string;
}>;

const LINE_CLASS: Record<ParsedDiffLine["type"], string> = {
  add: "bg-emerald-500/12",
  delete: "bg-red-500/12",
  hunk: "bg-sky-500/10",
  meta: "",
  context: "",
};
const TEXT_CLASS: Record<ParsedDiffLine["type"], string> = {
  add: "text-emerald-700 dark:text-emerald-300",
  delete: "text-red-700 dark:text-red-300",
  hunk: "text-sky-700 dark:text-sky-300",
  meta: "text-foreground-muted",
  context: "text-foreground-secondary",
};
const MARK: Record<ParsedDiffLine["type"], string> = { add: "+", delete: "−", hunk: "", meta: "", context: " " };

export function PullRequestDiffScreen(props: Props) {
  const insets = useSafeAreaInsets();
  const { environmentId, path } = props.route.params;
  const number = Number(props.route.params.number);
  const { selectedThreadCwd } = useSelectedThreadWorktree();
  const diff = usePullRequestDiff(environmentId, selectedThreadCwd, number);
  const rows = useMemo(() => (diff.data ? diffRows(diff.data.patch, path) : []), [diff.data, path]);
  const title = path ? splitPath(path).name : `#${number} changes`;

  return (
    <>
      <NativeStackScreenOptions options={{ title }} />
      {diff.error && !diff.data ? (
        <View className="flex-1 bg-screen px-4 pt-6">
          <EmptyState title="Couldn't load the diff" detail={diff.error} actionLabel="Try again" onAction={diff.refresh} />
        </View>
      ) : !diff.data ? (
        <View className="flex-1 bg-screen">
          <Text className="px-4 pt-10 text-center text-sm font-t3-medium text-foreground-muted">Loading changes…</Text>
        </View>
      ) : rows.length === 0 ? (
        <View className="flex-1 bg-screen px-4 pt-6">
          <EmptyState
            title="No textual changes"
            detail={path ? "This file has no line changes to show (it may be binary or renamed)." : "This pull request changes no text."}
          />
        </View>
      ) : (
        <FlatList
          className="flex-1 bg-screen"
          contentInsetAdjustmentBehavior="automatic"
          data={rows}
          keyExtractor={(row) => row.id}
          initialNumToRender={60}
          windowSize={11}
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 16) + 16 }}
          ListFooterComponent={
            diff.data.truncated ? (
              <Text className="px-4 py-4 text-center text-xs text-foreground-muted">
                This diff is too large to show in full — open it on GitHub for the rest.
              </Text>
            ) : null
          }
          renderItem={({ item }) =>
            item.kind === "file" ? (
              <View className="border-y border-border bg-subtle px-4 py-2">
                <Text className="font-mono text-xs font-t3-bold text-foreground" numberOfLines={2}>
                  {item.path}
                </Text>
              </View>
            ) : (
              <View className={`flex-row px-2 ${LINE_CLASS[item.line.type]}`}>
                <Text className="w-10 pr-2 text-right font-mono text-2xs leading-5 text-foreground-muted">
                  {item.line.type === "hunk" ? "" : (item.line.newLine ?? item.line.oldLine ?? "")}
                </Text>
                <Text className={`w-3 font-mono text-xs leading-5 ${TEXT_CLASS[item.line.type]}`}>
                  {MARK[item.line.type]}
                </Text>
                <Text className={`flex-1 font-mono text-xs leading-5 ${TEXT_CLASS[item.line.type]}`} selectable>
                  {item.line.content}
                </Text>
              </View>
            )
          }
        />
      )}
    </>
  );
}
