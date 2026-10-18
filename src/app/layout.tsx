import type { Metadata, Viewport } from "next";
import "./globals.css";
import PwaRegister from "@/components/PwaRegister";
import { Toaster } from "@/components/Toast";

export const metadata: Metadata = {
  title: "二周目协会",
  description: "一间只有一个人的小协会。你说话，它运营。",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "二周目",
    statusBarStyle: "black-translucent",
  },
  icons: {
    icon: "/icons/icon-192.png",
    apple: "/icons/apple-touch-icon.png",
  },
};

export const viewport: Viewport = {
  themeColor: "#0B0810",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN">
      <body>
        {children}
        <PwaRegister />
        <Toaster />
      </body>
    </html>
  );
}
