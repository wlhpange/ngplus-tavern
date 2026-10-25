import { useMemo, useState } from "react";
import {
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { C, Fonts, R, S } from "@/constants/theme";
import catalogJson from "@/server/pet_catalog.json";
import palettesJson from "@/server/pet_palettes.json";
import {
  SLOT_ORDER,
  availableAnims,
  usedMaterials,
  type PetCatalog,
  type PetDescriptor,
  type PetMaterial,
  type PetPalettes,
} from "@/weblib/petCatalog";
import { PixelPet, defaultDescriptor, type PetAnim } from "./PixelPet";
import { Chip } from "./ui";

const catalog = catalogJson as unknown as PetCatalog;
const palettes = palettesJson as unknown as PetPalettes;

const SLOT_LABELS: Record<string, string> = Object.fromEntries(
  catalog.slots.map((s) => [s.key, s.label]),
);
const OPTIONAL_SLOTS = new Set(["face", "hair", "top", "bottom", "shoes"]);
const BODY_LABELS: Record<string, string> = { female: "女相", male: "男相" };
const MATERIAL_LABELS: Record<string, string> = {
  body: "肤色",
  hair: "发色",
  cloth: "衣色",
  eye: "瞳色",
  metal: "金属色",
};
const ANIM_LABELS: Record<string, string> = { idle: "待机", emote: "动作", walk: "走路" };

type Option = { id: string; label: string; hint?: string };
type PickerState = {
  title: string;
  options: Option[];
  selected?: string;
  onPick: (id: string) => void;
};

function firstFor(slot: string, bodyType: string): string | undefined {
  return Object.entries(catalog.items).find(
    ([, it]) => it.slot === slot && it.bodyTypes.includes(bodyType),
  )?.[0];
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
  const [picker, setPicker] = useState<PickerState | null>(null);
  const [query, setQuery] = useState("");

  const slots = useMemo(() => {
    return SLOT_ORDER.map((key) => {
      const item = catalog.items[value.items[key] ?? ""];
      const valid = item && item.bodyTypes.includes(value.bodyType) ? item : null;
      return { key, item: valid };
    });
  }, [value]);

  const materials = useMemo(() => usedMaterials(catalog, value), [value]);

  function openPicker(state: PickerState) {
    setQuery("");
    setPicker(state);
  }

  function setItem(slot: string, id: string) {
    const item = id ? catalog.items[id] : null;
    const items = { ...value.items, [slot]: id || undefined };
    const itemVariants = { ...(value.itemVariants ?? {}) };
    if (item?.layout === "variant" && item.variants?.length) {
      itemVariants[slot] = item.variants[0];
    } else {
      delete itemVariants[slot];
    }
    onChange({ ...value, items, itemVariants });
  }

  function setBodyType(bodyType: string) {
    const items = { ...value.items };
    for (const slot of SLOT_ORDER) {
      const id = items[slot];
      const item = id ? catalog.items[id] : null;
      if (item && !item.bodyTypes.includes(bodyType)) {
        items[slot] = OPTIONAL_SLOTS.has(slot) ? undefined : firstFor(slot, bodyType);
      }
      if (!items[slot] && (slot === "body" || slot === "head")) {
        items[slot] = firstFor(slot, bodyType);
      }
    }
    const itemVariants = { ...(value.itemVariants ?? {}) };
    for (const slot of SLOT_ORDER) {
      const item = items[slot] ? catalog.items[items[slot]!] : null;
      if (item?.layout === "variant" && item.variants?.length) {
        itemVariants[slot] = itemVariants[slot] ?? item.variants[0];
      } else {
        delete itemVariants[slot];
      }
    }
    onChange({ ...value, bodyType, items, itemVariants });
  }

  function slotOptions(slot: string): Option[] {
    const out: Option[] = Object.entries(catalog.items)
      .filter(([, it]) => it.slot === slot && it.bodyTypes.includes(value.bodyType))
      .map(([id, it]) => ({ id, label: it.label, hint: it.category }));
    if (OPTIONAL_SLOTS.has(slot)) out.unshift({ id: "", label: "无" });
    return out;
  }

  function variantOptions(slot: string, item: NonNullable<(typeof slots)[number]["item"]>): Option[] {
    return (item.variants ?? []).map((v) => ({ id: v, label: v }));
  }

  function colorOptions(mat: PetMaterial): Option[] {
    const p = palettes[mat];
    if (!p) return [];
    return [
      { id: "", label: "默认（基色）" },
      ...Object.keys(p.colors).map((c) => ({ id: c, label: c, hint: p.label })),
    ];
  }

  const anims = availableAnims(catalog, value);
  const animOptions: PetAnim[] = (["idle", "emote", "walk"] as PetAnim[]).filter(
    (a) => a === "idle" || a === "emote" || anims.includes("walk"),
  );

  const filtered = picker
    ? picker.options.filter(
        (o) =>
          !query.trim() ||
          o.label.toLowerCase().includes(query.trim().toLowerCase()) ||
          o.id.toLowerCase().includes(query.trim().toLowerCase()),
      )
    : [];

  return (
    <View style={{ gap: S.md }}>
      <View style={styles.preview}>
        <PixelPet descriptor={value} display={display} animation={anim} />
        {showAnimationSwitch ? (
          <View style={styles.animRow}>
            {animOptions.map((a) => (
              <Chip
                key={a}
                label={ANIM_LABELS[a] ?? a}
                active={anim === a}
                onPress={() => setAnim(a)}
                tone="gold"
              />
            ))}
          </View>
        ) : null}
      </View>

      <PickerRow
        title="体型"
        value={BODY_LABELS[value.bodyType] ?? value.bodyType}
        onPress={() =>
          openPicker({
            title: "体型",
            options: catalog.bodyTypes.map((b) => ({ id: b, label: BODY_LABELS[b] ?? b })),
            selected: value.bodyType,
            onPick: setBodyType,
          })
        }
      />

      {slots.map(({ key, item }) => (
        <View key={key} style={{ gap: S.sm }}>
          <PickerRow
            title={SLOT_LABELS[key] ?? key}
            value={item?.label ?? (OPTIONAL_SLOTS.has(key) ? "无" : "未选")}
            onPress={() =>
              openPicker({
                title: SLOT_LABELS[key] ?? key,
                options: slotOptions(key),
                selected: value.items[key] ?? "",
                onPick: (id) => setItem(key, id),
              })
            }
          />
          {item?.layout === "variant" && item.variants?.length ? (
            <PickerRow
              title={`${SLOT_LABELS[key] ?? key}颜色`}
              value={value.itemVariants?.[key] ?? item.variants[0]}
              onPress={() =>
                openPicker({
                  title: `${SLOT_LABELS[key] ?? key}颜色`,
                  options: variantOptions(key, item),
                  selected: value.itemVariants?.[key] ?? item.variants?.[0],
                  onPick: (id) =>
                    onChange({
                      ...value,
                      itemVariants: { ...(value.itemVariants ?? {}), [key]: id },
                    }),
                })
              }
            />
          ) : null}
        </View>
      ))}

      {materials.map((mat) => (
        <PickerRow
          key={mat}
          title={MATERIAL_LABELS[mat] ?? mat}
          value={value.colors[mat] ?? "默认（基色）"}
          onPress={() =>
            openPicker({
              title: MATERIAL_LABELS[mat] ?? mat,
              options: colorOptions(mat),
              selected: value.colors[mat] ?? "",
              onPick: (id) =>
                onChange({
                  ...value,
                  colors: { ...value.colors, [mat]: id || undefined },
                }),
            })
          }
        />
      ))}

      <Modal
        visible={!!picker}
        transparent
        animationType="fade"
        onRequestClose={() => setPicker(null)}
      >
        <Pressable style={styles.overlay} onPress={() => setPicker(null)}>
          <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
            <View style={styles.sheetHead}>
              <Text style={styles.sheetTitle}>{picker?.title}</Text>
              <Pressable onPress={() => setPicker(null)} hitSlop={10}>
                <Text style={styles.close}>关闭</Text>
              </Pressable>
            </View>
            {picker && picker.options.length > 12 ? (
              <TextInput
                style={styles.search}
                value={query}
                onChangeText={setQuery}
                placeholder="筛选…"
                placeholderTextColor={C.faint}
                autoCapitalize="none"
              />
            ) : null}
            <FlatList
              data={filtered}
              keyExtractor={(o) => o.id || "__none__"}
              style={{ maxHeight: 420 }}
              keyboardShouldPersistTaps="handled"
              renderItem={({ item: o }) => {
                const active = (picker?.selected ?? "") === o.id;
                return (
                  <Pressable
                    style={[styles.option, active && styles.optionActive]}
                    onPress={() => {
                      picker?.onPick(o.id);
                      setPicker(null);
                    }}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.optionLabel, active && { color: C.gold }]}>
                        {o.label}
                      </Text>
                      {o.hint ? <Text style={styles.optionHint}>{o.hint}</Text> : null}
                    </View>
                    {active ? <Text style={styles.check}>✓</Text> : null}
                  </Pressable>
                );
              }}
              ListEmptyComponent={<Text style={styles.empty}>没有匹配项</Text>}
            />
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

function PickerRow({
  title,
  value,
  onPress,
}: {
  title: string;
  value: string;
  onPress: () => void;
}) {
  return (
    <Pressable style={styles.row} onPress={onPress}>
      <Text style={styles.rowTitle}>{title}</Text>
      <Text style={styles.rowValue} numberOfLines={1}>
        {value}
      </Text>
      <Text style={styles.chevron}>›</Text>
    </Pressable>
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
  animRow: { flexDirection: "row", gap: 6 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: S.sm,
    paddingHorizontal: S.md,
    paddingVertical: 10,
    borderRadius: R.btn,
    backgroundColor: C.surface2,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: C.border,
  },
  rowTitle: { width: 76, fontFamily: Fonts.body, fontSize: 12, color: C.muted },
  rowValue: { flex: 1, fontFamily: Fonts.body, fontSize: 13, color: C.fg },
  chevron: { fontFamily: Fonts.body, fontSize: 18, color: C.faint },
  overlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
    justifyContent: "flex-end",
    padding: S.lg,
  },
  sheet: {
    backgroundColor: C.surface,
    borderRadius: R.card,
    borderWidth: 1,
    borderColor: C.borderStrong,
    padding: S.lg,
    gap: S.sm,
    maxHeight: "78%",
  },
  sheetHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  sheetTitle: { fontFamily: Fonts.display, fontSize: 18, color: C.fg },
  close: { fontFamily: Fonts.body, fontSize: 12, color: C.muted },
  search: {
    minHeight: 40,
    borderRadius: R.btn,
    backgroundColor: C.surface2,
    borderWidth: 1,
    borderColor: C.border,
    paddingHorizontal: 12,
    color: C.fg,
    fontFamily: Fonts.body,
    fontSize: 13,
  },
  option: {
    flexDirection: "row",
    alignItems: "center",
    gap: S.sm,
    paddingVertical: 10,
    paddingHorizontal: S.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: C.border,
  },
  optionActive: { backgroundColor: C.goldSoft },
  optionLabel: { fontFamily: Fonts.body, fontSize: 13, color: C.fg },
  optionHint: { fontFamily: Fonts.body, fontSize: 10, color: C.faint, marginTop: 1 },
  check: { fontFamily: Fonts.body, fontSize: 14, color: C.gold },
  empty: { fontFamily: Fonts.body, fontSize: 12, color: C.faint, padding: S.md },
});
