import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import Animated, { FadeInUp, FadeOutUp } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { C, Fonts, R } from "@/constants/theme";

type Tone = "info" | "ok" | "err";
interface ToastItem {
  id: number;
  text: string;
  tone: Tone;
}

const ToastCtx = createContext<(text: string, tone?: Tone) => void>(() => {});

export function useToast() {
  return useContext(ToastCtx);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const insets = useSafeAreaInsets();

  const push = useCallback((text: string, tone: Tone = "info") => {
    const id = ++seq.current;
    setItems((prev) => [...prev.slice(-2), { id, text, tone }]);
    setTimeout(() => setItems((prev) => prev.filter((x) => x.id !== id)), 2600);
  }, []);

  const value = useMemo(() => push, [push]);

  return (
    <ToastCtx.Provider value={value}>
      {children}
      <View pointerEvents="none" style={[styles.wrap, { top: insets.top + 10 }]}>
        {items.map((t) => (
          <Animated.View
            key={t.id}
            entering={FadeInUp.duration(180)}
            exiting={FadeOutUp.duration(180)}
            style={[
              styles.toast,
              t.tone === "ok" && { borderColor: C.accentLine, backgroundColor: C.accentSoft },
              t.tone === "err" && { borderColor: C.danger, backgroundColor: C.dangerSoft },
            ]}
          >
            <Text
              style={[
                styles.text,
                t.tone === "ok" && { color: C.accent },
                t.tone === "err" && { color: C.dangerText },
              ]}
            >
              {t.text}
            </Text>
          </Animated.View>
        ))}
      </View>
    </ToastCtx.Provider>
  );
}

const styles = StyleSheet.create({
  wrap: { position: "absolute", left: 16, right: 16, gap: 6, zIndex: 999 },
  toast: {
    borderRadius: R.tile,
    borderWidth: 1,
    borderColor: C.goldLine,
    backgroundColor: C.surface,
    paddingHorizontal: 14,
    paddingVertical: 10,
    shadowColor: "#000",
    shadowOpacity: 0.4,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 12,
  },
  text: { fontFamily: Fonts.body, fontSize: 12, color: C.gold, lineHeight: 18, textAlign: "center" },
});
