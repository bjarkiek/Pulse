import type { Metadata } from "next";
import "./globals.css";
import EmbedAuthInstaller from "./embed-auth-installer";

export const metadata: Metadata = {
  title: "DataCentral Pulse",
  description: "Customer-driven product feedback and roadmap management for DataCentral.",
  other: { "codex-preview": "development" },
  icons: { icon: "/brand/favicon-32x32.png", shortcut: "/brand/favicon-32x32.png" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // suppressHydrationWarning covers THIS element only: browser extensions stamp
  // attributes onto <html> before React hydrates (e.g. data-sml-extension-installed),
  // which would otherwise trip the dev overlay with a false hydration mismatch.
  return <html lang="en" suppressHydrationWarning><body><EmbedAuthInstaller />{children}</body></html>;
}
