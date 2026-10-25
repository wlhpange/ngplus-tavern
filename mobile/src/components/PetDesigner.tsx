import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";

import type { PetDescriptor } from "@/weblib/petCatalog";
import { C, Fonts, S } from "@/constants/theme";
import { Chip } from "./ui";
import { PixelPet, PET_BOTTOM, PET_FACE, PET_HAIR, PET_SHOES, PET_TOP, defaultDescriptor, type PetAnim } from "./PixelPet";

const BODY = [
  ["female", "女相"],
  ["male", "男相"],
] as const;
const BODY_COLOR = [
  ["light", "#F2C9A0"],
  ["tan", "#D9A066"],
  ["bronze", "#B97C50"],
  ["brown", "#8C5A3C"],
] as const;
const HAIR_COLOR = [
  ["blonde", "#E8C97A"],
  ["brown", "#7B4B2A"],
  ["black", "#2B2430"],
  ["silver", "#C9CED6"],
  ["red", "#B5543F"],
  ["purple", "#8C6BB1"],
  ["blue", "#4E6B9B"],
] as const;
const CLOTH_COLOR = [
  ["purple", "#6B4E9B"],
  ["teal", "#3F8C82"],
  ["red", "#A84A4A"],
  ["blue", "#4A6FA8"],
  ["black", "#2E2A36"],
  ["green", "#4E7B5A"],
  ["gold", "#B8913F"],
] as const;
const EYE_COLOR = [
  ["green", "#4E9B6B"],
  ["blue", "#5A8FC9"],
  ["amber", "#C98A4E"],
  ["red", "#B5544E"],
  ["purple", "#8C6BB1"],
] as const;

function Row<T extends readonly (readonly [string, string])[]>({
  title,
  options,
  value,
  onChange,
}: {
  title: string;
  options: T;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <View style={{ gap: 5 }}>
      <Text style={styles.label}>{title}</Text>
      <View style={styles.wrap}>
        {options.map(([key, label]) => (
          <Chip key={key} label={label} active={value === key} onPress={() => onChange(key)} tone="gold" />
        ))}
      </View>
    </View>
  );
}

function ColorRow({
  title,
  options,
  value,
  onChange,
}: {
  title: string;
  options: readonly (readonly [string, string])[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <View style={{ gap: 5 }}>
      <Text style={styles.label}>{title}</Text>
      <View style={styles.wrap}>
        {options.map(([key, color]) => (
          <Chip key={key} label={key} active={value === key} onPress={() => onChange(key)} tone="gold" />
        ))}
      </View>
    </View>
  );
}

export function PetDesigner({
  value,
  onChange,
  display = 128,
  showAnimationSwitch,
}: {
  value: PetDescriptor;
  onChange: (d: PetDescriptor) => void;
  display?: number;
  showAnimationSwitch?: boolean;
}) {
  const [anim, setAnim] = useState<PetAnim>("idle");
  const base = value.items ?? {};
  const colors = value.colors ?? {};
  const setItem = (slot: string, id: string) => onChange({ ...value, items: { ...base, [slot]: id } });
  const setColor = (mat: string, name: string) => onChange({ ...value, colors: { ...colors, [mat]: name } });

  return (
    <View style={{ gap: S.md }}>
      <View style={styles.preview}>
        <PixelPet descriptor={value} display={display} animation={anim} />
        {showAnimationSwitch ? (
          <View style={styles.animRow}>
            <Chip label="待机" active={anim === "idle"} onPress={() => setAnim("idle")} />
            <Chip label="动作" active={anim === "emote"} onPress={() => setAnim("emote")} />
          </View>
        ) : null}
      </View>
      <Row title="体型" options={BODY} value={value.bodyType} onChange={(v) => onChange({ ...value, bodyType: v })} />
      <Row title="发型" options={PET_HAIR} value={base.hair ?? "hair_ponytail"} onChange={(v) => setItem("hair", v)} />
      <Row title="上衣" options={PET_TOP} value={base.top ?? "torso_clothes_tshirt"} onChange={(v) => setItem("top", v)} />
      <Row title="下装" options={PET_BOTTOM} value={base.bottom ?? "legs_pants"} onChange={(v) => setItem("bottom", v)} />
      <Row title="鞋" options={PET_SHOES} value={base.shoes ?? "feet_boots_basic"} onChange={(v) => setItem("shoes", v)} />
      <Row title="表情" options={PET_FACE} value={base.face ?? "face_neutral"} onChange={(v) => setItem("face", v)} />
      <ColorRow title="肤色" options={BODY_COLOR} value={colors.body ?? "light"} onChange={(v) => setColor("body", v)} />
      <ColorRow title="发色" options={HAIR_COLOR} value={colors.hair ?? "blonde"} onChange={(v) => setColor("hair", v)} />
      <ColorRow title="衣色" options={CLOTH_COLOR} value={colors.cloth ?? "purple"} onChange={(v) => setColor("cloth", v)} />
      <ColorRow title="瞳色" options={EYE_COLOR} value={colors.eye ?? "green"} onChange={(v) => setColor("eye", v)} />
    </View>
  );
}

export { defaultDescriptor };

const styles = StyleSheet.create({
  preview: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: S.sm,
    borderRadius: 16,
    backgroundColor: C.surface2,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: C.border,
    gap: S.sm,
  },
  animRow: { flexDirection: "row", gap: S.sm },
  label: { fontFamily: Fonts.body, fontSize: 10, color: C.muted, letterSpacing: 0.5 },
  wrap: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
});
