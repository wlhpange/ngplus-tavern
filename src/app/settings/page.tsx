import type { Metadata } from "next";
import SettingsClient from "./settings";

export const metadata: Metadata = { title: "设置 · 二周目协会" };

export const dynamic = "force-dynamic";

export default function SettingsPage() {
  return <SettingsClient />;
}
