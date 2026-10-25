import { Image } from "expo-image";
import { StyleSheet, Text, View } from "react-native";

import { C, Fonts } from "@/constants/theme";

export function Avatar({
  src,
  name,
  size = 44,
  active,
}: {
  src?: string | null;
  name: string;
  size?: number;
  active?: boolean;
}) {
  if (src) {
    return (
      <Image
        source={{ uri: src }}
        style={{
          width: size,
          height: size,
          borderRadius: size / 2,
          borderWidth: 1,
          borderColor: active ? C.goldLine : C.border,
          backgroundColor: C.surface3,
        }}
        contentFit="cover"
        transition={120}
      />
    );
  }
  return (
    <View
      style={[
        styles.fallback,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          borderColor: active ? C.goldLine : C.border,
          backgroundColor: active ? C.goldSoft : C.surface3,
        },
      ]}
    >
      <Text style={[styles.initial, { color: active ? C.gold : C.fg, fontSize: size * 0.4 }]}>
        {name.slice(0, 1)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  fallback: { alignItems: "center", justifyContent: "center", borderWidth: 1 },
  initial: { fontFamily: Fonts.display },
});
