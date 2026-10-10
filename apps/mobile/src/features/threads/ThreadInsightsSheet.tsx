/**
 * Context & usage for one thread: the terminal's `/context`, `/cost` and
 * `/steak`, read from the thread's host (`session.insights`) — the same
 * numbers the desktop's context popover and usage page show.
 */
import { EnvironmentId } from "@loop/contracts";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useCallback, useState } from "react";
import { Platform, RefreshControl, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidSheetHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text } from "../../components/AppText";
import {
  contextPercent,
  formatDay,
  formatDays,
  formatPercent,
  formatTokens,
  formatUsd,
} from "../../lib/sessionInsights";
import { sessionInsights } from "../../state/insights";
import { useEnvironmentQuery } from "../../state/query";

type ThreadInsightsSheetProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
}>;

function Card(props: { readonly title: string; readonly children: React.ReactNode }) {
  return (
    <View className="gap-3 rounded-[22px] border border-border bg-card px-4 py-4">
      <Text className="text-2xs font-t3-bold uppercase tracking-[0.9px] text-foreground-muted">
        {props.title}
      </Text>
      {props.children}
    </View>
  );
}

function Row(props: { readonly label: string; readonly value: string; readonly note?: string }) {
  return (
    <View className="flex-row items-baseline justify-between gap-3">
      <Text className="text-sm font-t3-medium text-foreground-secondary">{props.label}</Text>
      <View className="flex-row items-baseline gap-2">
        {props.note ? (
          <Text className="text-xs font-t3-medium text-foreground-muted">{props.note}</Text>
        ) : null}
        <Text className="text-sm font-t3-bold tabular-nums text-foreground">{props.value}</Text>
      </View>
    </View>
  );
}

function Unavailable(props: { readonly text: string }) {
  return <Text className="text-sm font-t3-medium text-foreground-muted">{props.text}</Text>;
}

export function ThreadInsightsSheet(props: ThreadInsightsSheetProps) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const environmentId = EnvironmentId.make(props.route.params.environmentId);
  const query = useEnvironmentQuery(
    sessionInsights.read({ environmentId, input: { threadId: props.route.params.threadId } }),
  );
  const insights = query.data;
  const [refreshing, setRefreshing] = useState(false);
  const refresh = useCallback(() => {
    setRefreshing(true);
    query.refresh();
    setTimeout(() => setRefreshing(false), 600);
  }, [query]);

  const context = insights?.context ?? null;
  const percent = context ? contextPercent(context.totalTokens, context.contextWindow) : null;
  const compactAt =
    context && context.contextWindow > 0
      ? Math.floor(context.contextWindow * context.autoCompactThreshold)
      : null;

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <AndroidSheetHeader
        title="Context & usage"
        subtitle={context?.modelId || null}
        onBack={() => navigation.goBack()}
        actions={[
          {
            accessibilityLabel: "Refresh",
            icon: "arrow.clockwise",
            onPress: refresh,
          },
        ]}
      />
      <ScrollView
        className="flex-1 bg-screen"
        contentInsetAdjustmentBehavior={Platform.OS === "ios" ? "automatic" : "never"}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          paddingHorizontal: 20,
          paddingTop: 12,
          paddingBottom: Math.max(insets.bottom, 18) + 18,
          gap: 14,
        }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
      >
        {insights === null && query.error ? <Unavailable text={query.error} /> : null}
        {insights === null && !query.error ? <Unavailable text="Asking the host…" /> : null}

        {insights ? (
          <>
            <Card title="Context">
              {context ? (
                <>
                  <View className="flex-row items-baseline gap-2">
                    <Text className="text-2xl font-t3-bold tabular-nums text-foreground">
                      {formatTokens(context.totalTokens)}
                    </Text>
                    {context.contextWindow > 0 ? (
                      <Text className="text-sm font-t3-medium tabular-nums text-foreground-muted">
                        / {formatTokens(context.contextWindow)} tokens
                        {percent !== null ? ` · ${formatPercent(percent)}` : ""}
                      </Text>
                    ) : (
                      <Text className="text-sm font-t3-medium text-foreground-muted">tokens</Text>
                    )}
                  </View>
                  {percent !== null ? (
                    <View className="h-2 overflow-hidden rounded-full bg-subtle">
                      <View
                        className={percent >= 90 ? "h-2 bg-danger" : "h-2 bg-primary"}
                        style={{ width: `${Math.max(percent, 1)}%` }}
                      />
                    </View>
                  ) : null}
                  {context.categories
                    .filter((category) => category.tokens > 0)
                    .map((category) => (
                      <Row
                        key={category.key}
                        label={category.label}
                        value={formatTokens(category.tokens)}
                        {...(context.contextWindow > 0
                          ? {
                              note: formatPercent((category.tokens / context.contextWindow) * 100),
                            }
                          : {})}
                      />
                    ))}
                  {compactAt !== null ? (
                    <Text className="text-xs font-t3-medium text-foreground-muted">
                      Compacts on its own at {Math.round(context.autoCompactThreshold * 100)}% (
                      {formatTokens(compactAt)}). Categories are estimates.
                    </Text>
                  ) : null}
                </>
              ) : (
                <Unavailable text="Starts counting once this chat has a message." />
              )}
            </Card>

            <Card title="This session">
              {insights.cost ? (
                <>
                  <Text className="text-2xl font-t3-bold tabular-nums text-foreground">
                    {formatUsd(insights.cost.usd, insights.cost.estimated === true)}
                  </Text>
                  <Row label="Input" value={formatTokens(insights.cost.inputTokens)} />
                  <Row label="Cached input" value={formatTokens(insights.cost.cachedInputTokens)} />
                  <Row label="Output" value={formatTokens(insights.cost.outputTokens)} />
                </>
              ) : (
                <Unavailable text="Nothing spent in this session yet." />
              )}
            </Card>

            {insights.spend ? (
              <Card title="Spend">
                <Row label="Today" value={formatUsd(insights.spend.todayUsd)} />
                <Row label="Last 7 days" value={formatUsd(insights.spend.last7Usd)} />
                <Row label="This month" value={formatUsd(insights.spend.monthUsd)} />
                <Row label="All time" value={formatUsd(insights.spend.lifetimeUsd)} />
              </Card>
            ) : null}

            {insights.usage ? (
              <Card title="🥩 Tokens this year">
                <Text className="text-2xl font-t3-bold tabular-nums text-foreground">
                  {formatTokens(insights.usage.totalTokens)}
                </Text>
                <Row
                  label="Current streak"
                  value={formatDays(insights.usage.currentStreak)}
                  {...(insights.usage.currentStreak >= 3 ? { note: "🔥" } : {})}
                />
                <Row label="Longest streak" value={formatDays(insights.usage.longestStreak)} />
                <Row label="Active days" value={String(insights.usage.activeDays)} />
                {insights.usage.busiestDay ? (
                  <Row
                    label="Busiest day"
                    value={formatTokens(insights.usage.busiestDayTokens)}
                    note={formatDay(insights.usage.busiestDay)}
                  />
                ) : null}
              </Card>
            ) : null}
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}
