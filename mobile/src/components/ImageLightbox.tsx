import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { Image } from "expo-image";
import { SafeAreaView } from "react-native-safe-area-context";

import { C, Fonts } from "@/constants/theme";

export function ImageLightbox({ src, onClose }: { src: string | null; onClose: () => void }) {
  return (
    <Modal visible={!!src} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <SafeAreaView style={styles.safe}>
        <Pressable style={styles.close} onPress={onClose}>
          <Text style={styles.closeText}>关闭</Text>
        </Pressable>
        {src ? <Image source={{ uri: src }} style={styles.image} contentFit="contain" /> : null}
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "rgba(0,0,0,0.94)", justifyContent: "center" },
  close: { position: "absolute", top: 54, right: 20, zIndex: 2, padding: 8 },
  closeText: { fontFamily: Fonts.body, fontSize: 14, color: C.gold },
  image: { width: "100%", height: "100%" },
});
