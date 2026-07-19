// Client-safe onboarding-tour contracts shared by the API payloads, the
// TourHost glue, and the admin settings UI. Tour definitions themselves are
// server-only (lib/server/tour-catalog.ts) so customers never download the
// content of tours outside their audience.

export type TourAudience = "All" | "Customers" | "Internal" | "SystemAdmins";
export type TourStatus = "InProgress" | "Completed" | "Dismissed";
export type TourStatusOrNew = TourStatus | "NotStarted";

export const TOUR_AUDIENCES: TourAudience[] = [
  "All",
  "Customers",
  "Internal",
  "SystemAdmins",
];

export type TourStepPayload = {
  element?: string;
  route?: string;
  title: string;
  description: string;
  side: string;
  align: string;
  advanceOnClick: boolean;
};

export type TourPayload = {
  key: string;
  version: number;
  title: string;
  autoStart: boolean;
  resumeAt: number | null;
  status: TourStatusOrNew;
  steps: TourStepPayload[];
};

export type TourStatePayload = {
  suppressed: boolean;
  tours: TourPayload[];
  strings: { next: string; previous: string; done: string; progress: string };
};

export type TourSettingItem = {
  tourKey: string;
  title: string;
  version: number;
  stepCount: number;
  enabled: boolean;
  audience: TourAudience;
  autoStart: boolean;
};

export type OnboardingUserItem = {
  id: string;
  name: string;
  email: string;
  isInternal: boolean;
  isSystemAdmin: boolean;
  toursHiddenAt: string | null;
};

export type TourProgressItem = {
  userId: string;
  tourKey: string;
  version: number;
  status: TourStatus;
  lastStepIndex: number;
  stepCount: number;
  source: string;
  updatedAt: string;
};

export type OnboardingAdminPayload = {
  enabled: boolean;
  settings: TourSettingItem[];
  users: OnboardingUserItem[];
  progress: TourProgressItem[];
};

// Mirror of the server-side eligibility rule so the admin funnel counts are
// scoped to each tour's *current* audience (kit invariant §5.6.7).
export function audienceMatches(
  audience: TourAudience,
  user: { isInternal: boolean; isSystemAdmin: boolean },
) {
  switch (audience) {
    case "Customers":
      return !user.isInternal;
    case "Internal":
      return user.isInternal;
    case "SystemAdmins":
      return user.isSystemAdmin;
    default:
      return true;
  }
}
