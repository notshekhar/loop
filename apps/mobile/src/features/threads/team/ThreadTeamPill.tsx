/**
 * The pill a chat in a thread team wears just under the header: "Lead" (the
 * way back, in a thread) and the team's state ("Team · 2 working"), which
 * opens the team sheet. Floating rather than part of the layout, so the
 * chat's scroll insets — tuned against the native header — stay untouched.
 * Absent for every chat that is in no team.
 */
import { HeaderHeightContext } from "@react-navigation/elements";
import { useNavigation } from "@react-navigation/native";
import * as Haptics from "expo-haptics";
import { useContext } from "react";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../../components/AppSymbol";
import { AppText as Text } from "../../../components/AppText";
import { useThemeColor } from "../../../lib/useThemeColor";
import { formatTeamUsd, isTeamMemberWorking } from "./teamPresentation";
import { useThreadTeam } from "./useThreadTeam";

export function ThreadTeamPill(props: {
  readonly environmentId: string;
  readonly threadId: string;
}) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const headerHeight = useContext(HeaderHeightContext);
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
    <View
      pointerEvents="box-none"
      className="absolute inset-x-0 z-20 items-center"
      style={{ top: (headerHeight || insets.top + 44) + 6 }}
    >
      <View className="flex-row items-center overflow-hidden rounded-full border border-border bg-card shadow-sm">
        {!isLead ? (
          <Pressable
            accessibilityLabel="Back to lead"
            accessibilityRole="button"
            onPress={() => {
              void Haptics.selectionAsync();
              navigation.navigate("Thread", {
                environmentId: props.environmentId,
                threadId: team.lead.threadId,
              });
            }}
            className="flex-row items-center gap-1.5 border-r border-border px-3 py-1.5 active:opacity-60"
          >
            <SymbolView name="arrow.turn.left.up" size={12} tintColor={tint} type="monochrome" />
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
          className="flex-row items-center gap-1.5 px-3 py-1.5 active:opacity-60"
        >
          <SymbolView
            name="point.3.connected.trianglepath.dotted"
            size={12}
            tintColor={tint}
            type="monochrome"
          />
          <Text className="text-xs font-t3-bold text-foreground">
            Team · {isLead ? `${team.members.length} threads` : "thread"}
          </Text>
          <Text className="text-xs font-t3-medium text-foreground-muted">
            {status ? `· ${status} ` : ""}· {formatTeamUsd(team.cost.usd)}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}
