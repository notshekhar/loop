import { fromInstanceId } from "@loop/handlers/ids";
import {
  customProviderName,
  customProviderShape,
  providerInitials,
  providerPresentation,
} from "@loop/providers/presentation";
import { Text, useColorScheme, View } from "react-native";
import { SvgXml } from "react-native-svg";

import { MARK_FOR_ICON_KEY, MARK_FOR_SHAPE, PROVIDER_MARKS } from "./providerMarks.generated";

type ProviderIconProps = {
  /** The provider instance id the thread or model option carries (a loop provider id). */
  readonly provider: string | null | undefined;
  readonly size?: number;
};

/**
 * The mark for a loop provider, the same one the web and desktop draw
 * (apps/web/src/loop/providers/index.ts): the vendor's mark, the native
 * agent's own for claude-code / cursor-agent, the API shape's for a gateway,
 * and a lettermark for anything with none.
 */
function markFor(providerId: string): string | undefined {
  const gateway = customProviderName(providerId);
  if (gateway !== null) {
    const shape = customProviderShape(gateway);
    return shape === undefined ? undefined : PROVIDER_MARKS[MARK_FOR_SHAPE[shape] ?? ""];
  }
  const key = providerPresentation(providerId).iconKey;
  return key === undefined ? undefined : PROVIDER_MARKS[MARK_FOR_ICON_KEY[key] ?? ""];
}

export function ProviderIcon(props: ProviderIconProps) {
  const isDarkMode = useColorScheme() === "dark";
  const size = props.size ?? 16;
  const color = isDarkMode ? "#e5e5e5" : "#171717";
  const providerId = props.provider ? fromInstanceId(props.provider) : "";
  const xml = providerId ? markFor(providerId) : undefined;

  if (xml) return <SvgXml xml={xml} width={size} height={size} color={color} />;

  const label = providerId ? providerPresentation(providerId).label : "?";
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 4,
        borderWidth: 1,
        borderColor: color,
        alignItems: "center",
        justifyContent: "center",
        opacity: 0.8,
      }}
    >
      <Text style={{ color, fontSize: size * 0.45, fontWeight: "600" }} allowFontScaling={false}>
        {providerInitials(label)}
      </Text>
    </View>
  );
}
