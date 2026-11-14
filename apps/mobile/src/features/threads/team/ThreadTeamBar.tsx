/**
 * The team bar (a ThreadTopBar) of a chat that is in a thread team. "Lead"
 * goes back to the lead (in a thread); the rest opens the team sheet. Absent
 * for every chat that is in no team.
 */
import { useNavigation } from "@react-navigation/native";
import * as Haptics from "expo-haptics";
import { Pressable } from "react-native";

import { SymbolView } from "../../../components/AppSymbol";
import { AppText as Text } from "../../../components/AppText";
import { useThemeColor } from "../../../lib/useThemeColor";
import { ThreadTopBar } from "../ThreadTopBar";
import { formatTeamUsd, isTeamMemberWorking } from "./teamPresentation";
import { useThreadTeam } from "./useThreadTeam";

export function ThreadTeamBar(props: {
  readonly environmentId: string;
  readonly threadId: string;
  /** See ThreadTopBar. */
  readonly underTransparentHeader: boolean;
}) {
  const navigation = useNavigation();
  const tint = useThemeColor("--color-icon-subtle");
  const team = useThreadTeam(props.environmentId, props.threadId);
  if (!team) return null;

  const here = [team.lead, ...team.members].find((m) => m.threadId === props.threadId);
  const isLead = !here || here.role === "lead";
  const working = team.members.filter(isTeamMemberWorking).length;
  const status =
    working > 0
      ? `${working} working`
      : team.stopped
        ? "stopped"
        : isLead
          ? "all finished"
          : (here?.state ?? "");

  return (
    <ThreadTopBar underTransparentHeader={props.underTransparentHeader}>
      {!isLead ? (
        <Pressable
          accessibilityLabel="Back to lead"
          accessibilityRole="button"
          hitSlop={6}
          onPress={() => {
            void Haptics.selectionAsync();
            navigation.navigate("Thread", {
              environmentId: props.environmentId,
              threadId: team.lead.threadId,
            });
          }}
          className="mr-2 flex-row items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 active:opacity-60"
        >
          <SymbolView name="arrow.turn.left.up" size={11} tintColor={tint} type="monochrome" />
          <Text className="text-xs font-t3-bold text-foreground">Lead</Text>
        </Pressable>
      ) : null}
      <Pressable
        accessibilityLabel="Open the team"
        accessibilityRole="button"
        onPress={() => {
          void Haptics.selectionAsync();
          navigation.navigate("ThreadTeam", {
            environmentId: props.environmentId,
            threadId: props.threadId,
          });
        }}
        className="h-full flex-1 flex-row items-center gap-2 active:opacity-60"
      >
        <SymbolView
          name="point.3.connected.trianglepath.dotted"
          size={13}
          tintColor={tint}
          type="monochrome"
        />
        <Text className="text-[13px] font-t3-bold text-foreground" numberOfLines={1}>
          {isLead
            ? `Team · ${team.members.length} thread${team.members.length === 1 ? "" : "s"}`
            : `Team of ${team.lead.title}`}
        </Text>
        <Text className="flex-1 text-xs font-t3-medium text-foreground-muted" numberOfLines={1}>
          {status ? `${status} · ` : ""}
          {formatTeamUsd(team.cost.usd)}
        </Text>
        <SymbolView name="chevron.right" size={11} tintColor={tint} type="monochrome" />
      </Pressable>
    </ThreadTopBar>
  );
}
