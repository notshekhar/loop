/**
 * The team sheet: the thread team a chat is in, in one place — every thread
 * with its state and cost, the shared board, the whole team's spend, and
 * Stop. The phone's version of the desktop's team panel, opened from the
 * team pill over the chat. Tapping a thread opens it.
 */
import { EnvironmentId, type TeamMember } from "@loop/contracts";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import * as Haptics from "expo-haptics";
import { Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidSheetHeader } from "../../../components/AndroidScreenHeader";
import { SymbolView } from "../../../components/AppSymbol";
import { AppText as Text } from "../../../components/AppText";
import { useThemeColor } from "../../../lib/useThemeColor";
import { useAtomCommand } from "../../../state/use-atom-command";
import { teamAtoms } from "../../../state/team";
import { formatTeamUsd, isTeamMemberWorking, mobileTeamState } from "./teamPresentation";
import { useThreadTeam } from "./useThreadTeam";

type ThreadTeamSheetProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
}>;

function Card(props: { readonly title: string; readonly children: React.ReactNode }) {
  return (
    <View className="gap-1 rounded-[22px] border border-border bg-card px-2 py-3">
      <Text className="px-2 pb-1 text-2xs font-t3-bold uppercase tracking-[0.9px] text-foreground-muted">
        {props.title}
      </Text>
      {props.children}
    </View>
  );
}

function MemberRow(props: {
  readonly member: TeamMember;
  readonly here: boolean;
  readonly onPress: () => void;
}) {
  const chevron = useThemeColor("--color-icon-subtle");
  const look = mobileTeamState(props.member.state, props.member.running);
  const working = isTeamMemberWorking(props.member);
  return (
    <Pressable
      accessibilityRole="button"
      onPress={props.onPress}
      className={
        props.here
          ? "flex-row items-center gap-3 rounded-2xl bg-subtle px-2 py-2.5"
          : "flex-row items-center gap-3 rounded-2xl px-2 py-2.5 active:bg-subtle"
      }
    >
      <View className={`size-2 rounded-full ${look.dotClass}`} />
      <View className="flex-1 gap-0.5">
        <View className="flex-row items-baseline gap-1.5">
          <Text className="flex-shrink text-[15px] font-t3-bold text-foreground" numberOfLines={1}>
            {props.member.title}
          </Text>
          {props.member.role === "lead" ? (
            <Text className="text-2xs font-t3-bold uppercase tracking-[0.6px] text-foreground-muted">
              lead
            </Text>
          ) : null}
        </View>
        <Text className="text-xs font-t3-medium text-foreground-muted" numberOfLines={1}>
          <Text className={`text-xs font-t3-medium ${look.textClass}`}>{look.label}</Text>
          {working && props.member.activity ? ` · ${props.member.activity}` : ""}
          {props.here ? " · here" : ""}
        </Text>
      </View>
      <Text className="text-xs font-t3-medium tabular-nums text-foreground-muted">
        {formatTeamUsd(props.member.usd)}
      </Text>
      <SymbolView name="chevron.right" size={12} tintColor={chevron} type="monochrome" />
    </Pressable>
  );
}

export function ThreadTeamSheet(props: ThreadTeamSheetProps) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { environmentId, threadId } = props.route.params;
  const team = useThreadTeam(environmentId, threadId);
  const stop = useAtomCommand(teamAtoms.stop, "Stop the team");

  const open = (member: TeamMember) => {
    void Haptics.selectionAsync();
    navigation.goBack();
    if (member.threadId !== threadId)
      navigation.navigate("Thread", { environmentId, threadId: member.threadId });
  };

  const working = team ? team.members.filter(isTeamMemberWorking).length : 0;
  const all = team ? [team.lead, ...team.members] : [];

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <AndroidSheetHeader
        title="Team"
        subtitle={team ? team.lead.title : null}
        onBack={() => navigation.goBack()}
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
      >
        {team === null ? (
          <Text className="text-sm font-t3-medium text-foreground-muted">
            This chat isn't in a thread team. With “thread teams” on in Settings, the agent can
            split a big job across threads that work in parallel.
          </Text>
        ) : (
          <>
            <View className="flex-row items-center gap-3 px-1">
              <View className="flex-1 gap-0.5">
                <Text className="text-2xl font-t3-bold tabular-nums text-foreground">
                  {formatTeamUsd(team.cost.usd)}
                </Text>
                <Text className="text-sm font-t3-medium text-foreground-muted">
                  {team.members.length} thread{team.members.length === 1 ? "" : "s"}
                  {working > 0
                    ? ` · ${working} working`
                    : team.stopped
                      ? " · stopped"
                      : " · all finished"}
                </Text>
              </View>
              {working > 0 && !team.stopped ? (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => {
                    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                    void stop({
                      environmentId: EnvironmentId.make(environmentId),
                      input: { threadId },
                    });
                  }}
                  className="flex-row items-center gap-1.5 rounded-full border border-border bg-card px-3.5 py-2 active:opacity-70"
                >
                  <SymbolView name="stop.fill" size={11} tintColor="#ef4444" type="monochrome" />
                  <Text className="text-sm font-t3-bold text-foreground">Stop</Text>
                </Pressable>
              ) : null}
            </View>

            <Card title="Threads">
              {all.map((member) => (
                <MemberRow
                  here={member.threadId === threadId}
                  key={member.id}
                  member={member}
                  onPress={() => open(member)}
                />
              ))}
            </Card>

            {team.board.length > 0 ? (
              <Card title="Board">
                {team.board.map((note) => (
                  <View className="gap-1 rounded-2xl bg-subtle px-3 py-2.5" key={note.key}>
                    <View className="flex-row items-baseline justify-between gap-2">
                      <Text
                        className="flex-shrink font-mono text-xs font-t3-bold text-foreground"
                        numberOfLines={1}
                      >
                        {note.key}
                      </Text>
                      <Text
                        className="text-2xs font-t3-medium text-foreground-muted"
                        numberOfLines={1}
                      >
                        {note.fromTitle}
                      </Text>
                    </View>
                    <Text
                      className="text-sm leading-5 text-foreground-secondary"
                      numberOfLines={8}
                      selectable
                    >
                      {note.body}
                    </Text>
                  </View>
                ))}
              </Card>
            ) : null}

            <Card title="Cost">
              {all.map((member) => {
                const yours = member.usd - member.teamUsd;
                return (
                  <View
                    className="flex-row items-baseline justify-between gap-3 px-2 py-1"
                    key={member.id}
                  >
                    <Text
                      className="flex-1 text-sm font-t3-medium text-foreground-secondary"
                      numberOfLines={1}
                    >
                      {member.title}
                    </Text>
                    {member.role === "member" && yours > 0.00005 ? (
                      <Text className="text-xs font-t3-medium text-foreground-muted">
                        incl. {formatTeamUsd(yours)} yours
                      </Text>
                    ) : null}
                    <Text className="text-sm font-t3-bold tabular-nums text-foreground">
                      {formatTeamUsd(member.usd)}
                    </Text>
                  </View>
                );
              })}
              <View className="mx-2 mt-1 flex-row items-baseline justify-between border-t border-border pt-2">
                <Text className="text-sm font-t3-bold text-foreground">Team total</Text>
                <Text className="text-sm font-t3-bold tabular-nums text-foreground">
                  {formatTeamUsd(team.cost.usd)}
                </Text>
              </View>
            </Card>
          </>
        )}
      </ScrollView>
    </View>
  );
}
