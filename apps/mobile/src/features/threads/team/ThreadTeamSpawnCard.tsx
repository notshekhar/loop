/**
 * A spawn_threads call in the lead's chat, on the phone: the threads it
 * started, then the rest of the team — earlier spawns stay listed, so every
 * thread the lead ever started is one tap away from anywhere in the chat.
 * The phone's version of the desktop's spawn card (apps/web LoopTeam.tsx).
 */
import type { TeamMember } from "@loop/contracts";
import { useNavigation } from "@react-navigation/native";
import * as Haptics from "expo-haptics";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../../components/AppSymbol";
import { AppText as Text } from "../../../components/AppText";
import type { ThreadFeedTeamSpawn } from "../../../lib/threadActivity";
import { useThemeColor } from "../../../lib/useThemeColor";
import {
  formatTeamUsd,
  isTeamMemberWorking,
  mobileTeamState,
  splitSpawnedMembers,
} from "./teamPresentation";
import { useThreadTeam } from "./useThreadTeam";

function Row(props: { readonly member: TeamMember; readonly onPress: () => void }) {
  const chevron = useThemeColor("--color-icon-subtle");
  const look = mobileTeamState(props.member.state, props.member.running);
  const working = isTeamMemberWorking(props.member);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open ${props.member.title}`}
      onPress={props.onPress}
      className="flex-row items-center gap-2.5 rounded-xl px-2 py-2 active:bg-subtle"
    >
      <View className={`size-2 rounded-full ${look.dotClass}`} />
      <View className="flex-1">
        <Text className="text-sm font-t3-medium text-foreground" numberOfLines={1}>
          {props.member.title}
        </Text>
        {working && props.member.activity ? (
          <Text className="font-mono text-2xs text-foreground-muted" numberOfLines={1}>
            {props.member.activity}
          </Text>
        ) : null}
      </View>
      <Text className={`text-xs font-t3-medium ${look.textClass}`}>{look.label}</Text>
      {props.member.usd > 0 ? (
        <Text className="w-12 text-right text-2xs tabular-nums text-foreground-muted">
          {formatTeamUsd(props.member.usd)}
        </Text>
      ) : null}
      <SymbolView name="chevron.right" size={11} tintColor={chevron} type="monochrome" />
    </Pressable>
  );
}

export function ThreadTeamSpawnCard(props: {
  readonly spawn: ThreadFeedTeamSpawn;
  readonly environmentId: string;
  readonly threadId: string;
}) {
  const navigation = useNavigation();
  const accent = useThemeColor("--color-icon-subtle");
  const team = useThreadTeam(props.environmentId, props.threadId);
  const members = team?.members ?? [];
  const { started, others } = splitSpawnedMembers(members, props.spawn.output, props.spawn.titles);
  const count = props.spawn.titles.length || started.length;
  const working = members.filter(isTeamMemberWorking).length;
  const verb = props.spawn.partial
    ? "Starting"
    : props.spawn.failed
      ? "Could not start"
      : "Started";

  const open = (member: TeamMember) => {
    void Haptics.selectionAsync();
    navigation.navigate("Thread", {
      environmentId: props.environmentId,
      threadId: member.threadId,
    });
  };

  return (
    <View className="mb-3 overflow-hidden rounded-[18px] border border-border bg-card">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Open the team"
        onPress={() => {
          void Haptics.selectionAsync();
          navigation.navigate("ThreadTeam", {
            environmentId: props.environmentId,
            threadId: props.threadId,
          });
        }}
        className="flex-row items-center gap-2 border-b border-border bg-subtle px-3.5 py-2.5 active:opacity-70"
      >
        <SymbolView
          name="point.3.connected.trianglepath.dotted"
          size={14}
          tintColor={accent}
          type="monochrome"
        />
        <Text className="flex-1 text-sm font-t3-bold text-foreground" numberOfLines={1}>
          {verb} {count} thread{count === 1 ? "" : "s"}
        </Text>
        <Text className="text-xs font-t3-medium text-foreground-muted">
          {working > 0 ? `${working} working` : team ? formatTeamUsd(team.cost.usd) : ""}
        </Text>
      </Pressable>
      <View className="px-1.5 py-1.5">
        {started.length > 0
          ? started.map((member) => (
              <Row key={member.id} member={member} onPress={() => open(member)} />
            ))
          : props.spawn.failed
            ? null
            : props.spawn.titles.map((title) => (
                <View className="flex-row items-center gap-2.5 px-2 py-2" key={title}>
                  <View className="size-2 rounded-full bg-sky-500" />
                  <Text className="text-sm font-t3-medium text-foreground-muted">{title}</Text>
                </View>
              ))}
        {props.spawn.failed && props.spawn.output ? (
          <Text className="px-2 py-1.5 text-xs text-danger">{props.spawn.output}</Text>
        ) : null}
        {others.length > 0 ? (
          <>
            <Text className="px-2 pt-2 pb-0.5 text-2xs font-t3-bold uppercase tracking-[0.8px] text-foreground-muted">
              Also in the team
            </Text>
            {others.map((member) => (
              <Row key={member.id} member={member} onPress={() => open(member)} />
            ))}
          </>
        ) : null}
      </View>
    </View>
  );
}
