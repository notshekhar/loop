/**
 * One pull request: its state, branches and labels, the description (drawn
 * like a reply), checks, reviewers and the files it changes. A file opens its
 * diff; "View all changes" opens the whole patch; GitHub is one tap away for
 * anything this screen does not do yet (it is read-only).
 */
import type { LoopPullRequestDetail } from "@loop/contracts";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import * as Haptics from "expo-haptics";
import { Linking, Pressable, RefreshControl, ScrollView, View } from "react-native";
import { Markdown } from "react-native-nitro-markdown";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { useThemeColor } from "../../lib/useThemeColor";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { hasNativeSelectableMarkdownText, SelectableMarkdownText } from "../../native/SelectableMarkdownText";
import { useSelectedThreadWorktree } from "../../state/use-selected-thread-worktree";
import { useMarkdownStyles } from "../threads/ThreadFeed";
import {
  checkTone,
  checksTone,
  formatChangeSize,
  reviewerStateLabel,
  shortAge,
  splitPath,
  stateTone,
} from "./pullRequestPresentation";
import { usePullRequestDetail } from "./usePullRequests";

type Props = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
  readonly number: string;
}>;

function Section(props: { readonly title: string; readonly trailing?: string; readonly children: React.ReactNode }) {
  return (
    <View className="gap-1">
      <View className="flex-row items-baseline justify-between px-5 pb-1">
        <Text className="text-2xs font-t3-bold uppercase tracking-[0.9px] text-foreground-muted">{props.title}</Text>
        {props.trailing ? (
          <Text className="text-xs tabular-nums text-foreground-muted">{props.trailing}</Text>
        ) : null}
      </View>
      <View className="mx-4 overflow-hidden rounded-[18px] border border-border bg-card">{props.children}</View>
    </View>
  );
}

function Divider() {
  return <View className="ml-4 h-px bg-border" />;
}

function openUrl(url: string | null) {
  if (!url) return;
  void Haptics.selectionAsync();
  void Linking.openURL(url);
}

function Description(props: { readonly body: string }) {
  const styles = useMarkdownStyles((href) => void Linking.openURL(href));
  const body = props.body.trim();
  if (!body) {
    return <Text className="px-4 py-3.5 text-sm italic text-foreground-muted">No description.</Text>;
  }
  return (
    <View className="px-4 py-3">
      {hasNativeSelectableMarkdownText() ? (
        <SelectableMarkdownText
          markdown={body}
          textStyle={styles.assistant.nativeTextStyle}
          onLinkPress={(href) => void Linking.openURL(href)}
        />
      ) : (
        <Markdown
          options={{ gfm: true }}
          renderers={styles.assistant.renderers}
          styles={styles.assistant.styles}
          theme={styles.assistant.theme}
        >
          {body}
        </Markdown>
      )}
    </View>
  );
}

function Header(props: { readonly pr: LoopPullRequestDetail }) {
  const { pr } = props;
  const state = stateTone(pr);
  const checks = checksTone(pr.checks);
  return (
    <View className="gap-2 px-5 pt-4 pb-2">
      <Text className="text-xl font-t3-bold leading-7 text-foreground" selectable>
        {pr.title}
      </Text>
      <View className="flex-row flex-wrap items-center gap-x-2 gap-y-1">
        <View className="flex-row items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1">
          <View className={`size-2 rounded-full ${state.dotClass}`} />
          <Text className={`text-xs font-t3-bold ${state.textClass}`}>{state.label}</Text>
        </View>
        <Text className="text-xs font-t3-medium text-foreground-muted">
          #{pr.number}
          {pr.author ? ` · ${pr.author.login}` : ""} · updated {shortAge(pr.updatedAt)}
        </Text>
      </View>
      <Text className="font-mono text-xs text-foreground-muted" numberOfLines={2}>
        {pr.headRef} → {pr.baseRef}
      </Text>
      <View className="flex-row flex-wrap items-center gap-x-3 gap-y-1">
        <Text className="text-xs tabular-nums text-foreground-muted">
          {formatChangeSize(pr.additions, pr.deletions)} · {pr.changedFiles} file{pr.changedFiles === 1 ? "" : "s"} ·{" "}
          {pr.commitCount} commit{pr.commitCount === 1 ? "" : "s"}
        </Text>
        {checks ? <Text className={`text-xs font-t3-medium ${checks.textClass}`}>{checks.label}</Text> : null}
        {pr.state === "open" && pr.mergeable === "conflicting" ? (
          <Text className="text-xs font-t3-bold text-danger">Has conflicts</Text>
        ) : null}
      </View>
      {pr.labels.length > 0 ? (
        <View className="flex-row flex-wrap gap-1.5 pt-1">
          {pr.labels.map((label) => (
            <View key={label.name} className="rounded-full bg-subtle px-2.5 py-0.5">
              <Text className="text-2xs font-t3-medium text-foreground-secondary">{label.name}</Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

export function PullRequestScreen(props: Props) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const chevron = useThemeColor("--color-icon-subtle");
  const onPrimary = useThemeColor("--color-primary-foreground");
  const { environmentId, threadId } = props.route.params;
  const number = Number(props.route.params.number);
  const { selectedThreadCwd } = useSelectedThreadWorktree();
  const detail = usePullRequestDetail(environmentId, selectedThreadCwd, number);
  const pr = detail.data;

  const openDiff = (path?: string) => {
    void Haptics.selectionAsync();
    navigation.navigate("ThreadPullRequestDiff", {
      environmentId,
      threadId,
      number: String(number),
      ...(path ? { path } : {}),
    });
  };

  return (
    <>
      <NativeStackScreenOptions options={{ title: `#${number}` }} />
      <ScrollView
        className="flex-1 bg-screen"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ gap: 18, paddingBottom: Math.max(insets.bottom, 16) + 16 }}
        refreshControl={<RefreshControl refreshing={detail.isPending && pr !== null} onRefresh={detail.refresh} />}
      >
        {detail.error && !pr ? (
          <View className="px-4 pt-6">
            <EmptyState
              title={`Couldn't load #${number}`}
              detail={detail.error}
              actionLabel="Try again"
              onAction={detail.refresh}
            />
          </View>
        ) : !pr ? (
          <Text className="px-4 pt-10 text-center text-sm font-t3-medium text-foreground-muted">
            Loading #{number}…
          </Text>
        ) : (
          <>
            <Header pr={pr} />

            <View className="flex-row gap-2 px-4">
              <Pressable
                accessibilityRole="button"
                onPress={() => openDiff()}
                className="flex-1 flex-row items-center justify-center gap-2 rounded-full bg-primary py-2.5 active:opacity-80"
              >
                <SymbolView name="text.bubble" size={13} tintColor={onPrimary} type="monochrome" />
                <Text className="text-sm font-t3-bold text-primary-foreground">View all changes</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Open on GitHub"
                onPress={() => openUrl(pr.url)}
                className="flex-row items-center justify-center gap-2 rounded-full border border-border bg-card px-4 py-2.5 active:opacity-70"
              >
                <SymbolView name="arrow.up.right" size={12} tintColor={chevron} type="monochrome" />
                <Text className="text-sm font-t3-bold text-foreground">GitHub</Text>
              </Pressable>
            </View>

            <Section title="Description">
              <Description body={pr.body} />
            </Section>

            {pr.checkRuns.length > 0 ? (
              <Section title="Checks" trailing={`${pr.checkRuns.length}`}>
                {pr.checkRuns.map((check, index) => {
                  const tone = checkTone(check);
                  return (
                    <View key={`${check.name}-${index}`}>
                      {index > 0 ? <Divider /> : null}
                      <Pressable
                        accessibilityRole="button"
                        disabled={!check.url}
                        onPress={() => openUrl(check.url)}
                        className="flex-row items-center gap-3 px-4 py-3 active:bg-subtle"
                      >
                        <View className={`size-2 rounded-full ${tone.dotClass}`} />
                        <View className="flex-1">
                          <Text className="text-sm font-t3-medium text-foreground" numberOfLines={1}>
                            {check.name}
                          </Text>
                          {check.workflow ? (
                            <Text className="text-xs text-foreground-muted" numberOfLines={1}>
                              {check.workflow}
                            </Text>
                          ) : null}
                        </View>
                        <Text className={`text-xs font-t3-medium ${tone.textClass}`}>{tone.label}</Text>
                      </Pressable>
                    </View>
                  );
                })}
              </Section>
            ) : null}

            {pr.reviewers.length > 0 ? (
              <Section title="Reviewers">
                {pr.reviewers.map((reviewer, index) => (
                  <View key={reviewer.login}>
                    {index > 0 ? <Divider /> : null}
                    <View className="flex-row items-center justify-between gap-3 px-4 py-3">
                      <Text className="text-sm font-t3-medium text-foreground">{reviewer.login}</Text>
                      <Text className="text-xs text-foreground-muted">{reviewerStateLabel(reviewer.state)}</Text>
                    </View>
                  </View>
                ))}
              </Section>
            ) : null}

            <Section title="Files changed" trailing={`${pr.files.length}`}>
              {pr.files.map((file, index) => {
                const { name, folder } = splitPath(file.path);
                return (
                  <View key={file.path}>
                    {index > 0 ? <Divider /> : null}
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Open the diff of ${file.path}`}
                      onPress={() => openDiff(file.path)}
                      className="flex-row items-center gap-3 px-4 py-3 active:bg-subtle"
                    >
                      <View className="flex-1">
                        <Text className="font-mono text-[13px] text-foreground" numberOfLines={1}>
                          {name}
                        </Text>
                        {folder ? (
                          <Text className="font-mono text-2xs text-foreground-muted" numberOfLines={1}>
                            {folder}
                          </Text>
                        ) : null}
                      </View>
                      <Text className="text-xs tabular-nums text-foreground-muted">
                        {formatChangeSize(file.additions, file.deletions)}
                      </Text>
                      <SymbolView name="chevron.right" size={11} tintColor={chevron} type="monochrome" />
                    </Pressable>
                  </View>
                );
              })}
            </Section>
          </>
        )}
      </ScrollView>
    </>
  );
}
