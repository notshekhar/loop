/**
 * Something the thread team wrote into this chat, on the phone: a member's
 * brief from its lead, a message from a teammate, a report reaching the lead.
 * A card, never a user bubble — the user did not type it. The sender's name
 * opens their thread.
 */
import { useNavigation } from "@react-navigation/native";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../../components/AppSymbol";
import { AppText as Text } from "../../../components/AppText";
import type { ThreadFeedTeamCard } from "../../../lib/threadActivity";
import { useThemeColor } from "../../../lib/useThemeColor";
import { briefText } from "./teamPresentation";

function SenderLink(props: {
  readonly environmentId: string;
  readonly thread: { readonly threadId: string; readonly title: string };
}) {
  const navigation = useNavigation();
  return (
    <Text
      className="font-t3-bold text-sm text-foreground underline"
      onPress={() =>
        navigation.navigate("Thread", {
          environmentId: props.environmentId,
          threadId: props.thread.threadId,
        })
      }
      suppressHighlighting
    >
      {props.thread.title}
    </Text>
  );
}

export function ThreadTeamCard(props: {
  readonly team: ThreadFeedTeamCard;
  readonly environmentId: string;
}) {
  const navigation = useNavigation();
  const accent = useThemeColor("--color-icon-subtle");
  const { team } = props;

  if (team.kind === "spawn") {
    const lead = team.from;
    return (
      <View className="mb-3 overflow-hidden rounded-[18px] border border-border bg-card">
        <View className="flex-row items-center gap-2 border-b border-border bg-subtle px-3.5 py-2.5">
          <SymbolView
            name="point.3.connected.trianglepath.dotted"
            size={14}
            tintColor={accent}
            type="monochrome"
          />
          <Text className="flex-1 text-sm font-t3-medium text-foreground-muted" numberOfLines={1}>
            Brief from{" "}
            {lead ? <SenderLink environmentId={props.environmentId} thread={lead} /> : "the lead"}
          </Text>
          {lead ? (
            <Pressable
              accessibilityLabel="Back to lead"
              accessibilityRole="button"
              hitSlop={8}
              onPress={() =>
                navigation.navigate("Thread", {
                  environmentId: props.environmentId,
                  threadId: lead.threadId,
                })
              }
              className="flex-row items-center gap-1 rounded-full px-2 py-1 active:opacity-60"
            >
              <SymbolView
                name="arrow.turn.left.up"
                size={12}
                tintColor={accent}
                type="monochrome"
              />
              <Text className="text-xs font-t3-medium text-foreground-muted">Lead</Text>
            </Pressable>
          ) : null}
        </View>
        <View className="gap-1 px-3.5 py-3">
          {team.title ? (
            <Text className="text-2xs font-t3-bold uppercase tracking-[0.8px] text-foreground-muted">
              {team.title}
            </Text>
          ) : null}
          <Text className="text-[15px] leading-[22px] text-foreground" selectable>
            {briefText(team.text)}
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View className="mb-3 gap-2">
      {(team.mail ?? []).map((mail) => {
        const report = mail.kind === "report";
        const update = mail.kind === "update";
        return (
          <View
            className={
              report
                ? "overflow-hidden rounded-[18px] border border-emerald-500/30 bg-card"
                : "overflow-hidden rounded-[18px] border border-border bg-card"
            }
            key={mail.id}
          >
            <View className="flex-row items-center gap-2 px-3.5 pt-3">
              <SymbolView
                name={
                  report
                    ? "checkmark.circle"
                    : update
                      ? "point.3.connected.trianglepath.dotted"
                      : "text.bubble"
                }
                size={14}
                tintColor={accent}
                type="monochrome"
              />
              <Text
                className="flex-1 text-sm font-t3-medium text-foreground-muted"
                numberOfLines={1}
              >
                {update ? "Team update" : report ? "Report from " : "Message from "}
                {update ? null : (
                  <SenderLink environmentId={props.environmentId} thread={mail.from} />
                )}
              </Text>
            </View>
            <Text
              className="px-3.5 pt-1.5 pb-3 text-[15px] leading-[22px] text-foreground"
              selectable
            >
              {mail.text.trim()}
            </Text>
          </View>
        );
      })}
    </View>
  );
}
