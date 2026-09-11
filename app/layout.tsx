import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "聽懂學習廳",
  description: "Podcast 逐字稿與導學聊天機器人原型",
  other: {
    "codex-preview": "development",
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export const viewport = "width=device-width, initial-scale=1";

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-Hant">
      <body className="antialiased">{children}</body>
    </html>
  );
}
