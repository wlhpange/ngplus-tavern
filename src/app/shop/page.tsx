import type { Metadata } from "next";
import ShopClient from "./shop";

export const metadata: Metadata = { title: "协会商店 · 二周目协会" };

export const dynamic = "force-dynamic";

export default function ShopPage() {
  return <ShopClient />;
}
