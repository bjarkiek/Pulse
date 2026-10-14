"use client";
import type { FunctionComponent } from "react";
import type { Company } from "./shared";

// Placeholders: the contacts and suppressions tabs land in the next task.
export const CommunicationContactsTab: FunctionComponent<{
  companies: Company[];
  onToast: (message: string) => void;
}> = () => <p>The contacts list is coming in the next task.</p>;

export const SuppressionsTab: FunctionComponent<{
  onToast: (message: string) => void;
}> = () => <p>The suppression list is coming in the next task.</p>;
