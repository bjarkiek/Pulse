"use client";
import type { FunctionComponent } from "react";
import { PageIntro, type Company, type ReleaseItem } from "./shared";

type Props = {
  companies: Company[];
  releases: ReleaseItem[];
  onToast: (message: string) => void;
};

// Placeholder: the shell, the navigation and the build are wired before the page itself lands.
export const CommunicationsPage: FunctionComponent<Props> = () => (
  <PageIntro
    eyebrow="Customer communication"
    title="Communications"
    description="Loading…"
  />
);
