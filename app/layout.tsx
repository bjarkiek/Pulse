import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "DataCentral Pulse",
  description: "Customer-driven product feedback and roadmap management for DataCentral.",
  other: { "codex-preview": "development" },
  icons: { icon: "/brand/favicon-32x32.png", shortcut: "/brand/favicon-32x32.png" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
