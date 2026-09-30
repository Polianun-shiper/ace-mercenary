import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { UiScaler } from "@/components/UiScaler";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "ACE/SKY — 空战模拟器",
  description: "Ace Combat 风格的 3D 空战游戏，基于 Three.js 开发。驾驶 F-16 拦截 B-52 轰炸机，精通专家级操控。",
  keywords: ["Ace Combat", "飞行模拟", "3D 游戏", "Three.js", "F-16", "B-52"],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        <UiScaler />
        {children}
        <Toaster />
      </body>
    </html>
  );
}
