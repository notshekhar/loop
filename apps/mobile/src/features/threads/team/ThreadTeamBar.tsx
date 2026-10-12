/**
 * The team bar: a full-width strip pinned just under the header of a chat
 * that is in a thread team. "Lead" goes back to the lead (in a thread); the
 * rest opens the team sheet. It is part of the layout, not a floating pill:
 * the feed is told its height (`TEAM_BAR_HEIGHT`) and starts below it, so it
 * never covers a message. Absent for every chat that is in no team.
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

/** The bar's height; the feed adds it to its top inset. */
export const TEAM_BAR_HEIGHT = 40;

export function ThreadTeamBar(props: {
  readonly environmentId: string;
  readonly threadId: string;
  /**
   * True when the feed scrolls under a transparent native header (iOS glass):
   * the bar then sits at the header's bottom edge. Otherwise the screen's
   * content already starts below the header, and so does the bar.
   */
  readonly underTransparentHeader: boolean;
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
  const top = props.underTransparentHeader ? headerHeight || insets.top + 44 : 0;

  return (
    <View
      className="absolute inset-x-0 z-20 flex-row items-center border-b border-border bg-screen px-3"
      style={{ top, height: TEAM_BAR_HEIGHT }}
    >
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
    </View>
  );
}
