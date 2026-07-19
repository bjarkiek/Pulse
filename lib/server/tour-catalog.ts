import type { TourAudience, TourStepPayload } from "@/lib/tours";

// The Pulse tour catalog (DataCentralEmbedOnboardingTours.md §5.3). Server-only:
// definitions are filtered per user and localized before they reach the client,
// so a customer never downloads internal-audience tour content.
//
// Anchor convention: steps target data-tour="…" attributes in app/page.tsx and
// app/chat-panel.tsx — never utility class chains. Pulse is a single-page view
// switcher, so `route` values are pseudo-routes ("/home", "/triage", …) that the
// TourHost glue maps to the AppShell `page` state; they intentionally never equal
// window.location.pathname ("/"), which makes the engine call navigate() before
// each step — the glue's navigate is idempotent.

type Localized = { en: string; is: string };

export type TourStepDef = {
  title: Localized;
  description: Localized;
  element?: string;
  route?: string;
  side?: string;
  align?: string;
  advanceOnClick?: boolean;
};

export type TourDefinition = {
  key: string;
  version: number;
  title: Localized;
  defaultAutoStart: boolean;
  defaultAudience: TourAudience;
  reofferOnNewVersion: boolean;
  steps: TourStepDef[];
};

export function pick(value: Localized, locale: string) {
  return locale === "is" ? value.is : value.en;
}

export function localizeSteps(
  def: TourDefinition,
  locale: string,
): TourStepPayload[] {
  return def.steps.map((step) => ({
    element: step.element,
    route: step.route,
    title: pick(step.title, locale),
    description: pick(step.description, locale),
    side: step.side || "bottom",
    align: step.align || "start",
    advanceOnClick: Boolean(step.advanceOnClick),
  }));
}

export const tourStrings = (locale: string) =>
  locale === "is"
    ? {
        next: "Áfram",
        previous: "Til baka",
        done: "Ljúka",
        progress: "{{current}} af {{total}}",
      }
    : {
        next: "Next",
        previous: "Previous",
        done: "Done",
        progress: "{{current}} of {{total}}",
      };

export const TOUR_CATALOG: TourDefinition[] = [
  {
    key: "welcome",
    version: 1,
    title: { en: "Welcome to Pulse", is: "Velkomin í Pulse" },
    defaultAutoStart: true,
    defaultAudience: "All",
    reofferOnNewVersion: false,
    steps: [
      {
        title: { en: "Welcome to DataCentral Pulse", is: "Velkomin í DataCentral Pulse" },
        description: {
          en: "This short tour shows you around — it takes about a minute. You can stop any time and pick it up later from the ? button in the corner.",
          is: "Þessi stutta leiðsögn sýnir þér helstu svæðin — hún tekur um eina mínútu. Þú getur hætt hvenær sem er og haldið áfram síðar með ?-hnappnum í horninu.",
        },
      },
      {
        element: "[data-tour='nav']",
        route: "/home",
        side: "right",
        title: { en: "Getting around", is: "Ratað um" },
        description: {
          en: "Home, Browse ideas, Roadmap, My requests and Updates all live in this menu.",
          is: "Heim, hugmyndir, vegvísirinn, beiðnirnar þínar og uppfærslur — allt er í þessari valmynd.",
        },
      },
      {
        element: "[data-tour='ask-card']",
        title: { en: "Start with a search", is: "Byrjaðu á leit" },
        description: {
          en: "Search existing ideas before submitting a new request — another team may already have asked for the same thing.",
          is: "Leitaðu fyrst í hugmyndum sem þegar eru til — annað teymi gæti hafa beðið um það sama.",
        },
      },
      {
        element: "[data-tour='submit-request']",
        side: "bottom",
        align: "end",
        title: { en: "Submit a request", is: "Sendu inn beiðni" },
        description: {
          en: "Describe the outcome you need. The DataCentral team triages every request and keeps you posted.",
          is: "Lýstu því sem þú þarft. DataCentral-teymið fer yfir hverja beiðni og lætur þig vita af framvindu.",
        },
      },
      {
        element: "[data-tour='metrics']",
        title: { en: "Your status at a glance", is: "Staðan í fljótu bragði" },
        description: {
          en: "Active requests, items waiting on your input, and what shipped recently.",
          is: "Virkar beiðnir, atriði sem bíða eftir svari frá þér og það sem kom út nýlega.",
        },
      },
      {
        element: "[data-tour='your-requests']",
        side: "top",
        title: { en: "Follow your requests", is: "Fylgstu með beiðnunum þínum" },
        description: {
          en: "The latest activity on your organization's requests — open one to see its full history and add comments.",
          is: "Nýjasta virknin á beiðnum fyrirtækisins — opnaðu beiðni til að sjá sögu hennar og bæta við athugasemdum.",
        },
      },
      {
        element: "[data-tour='notifications']",
        side: "bottom",
        align: "end",
        title: { en: "Notifications", is: "Tilkynningar" },
        description: {
          en: "Status changes and responses land here, so you never miss a question from the team.",
          is: "Stöðubreytingar og svör birtast hér svo þú missir ekki af spurningum frá teyminu.",
        },
      },
      {
        element: "[data-tour='assistant']",
        side: "top",
        align: "end",
        title: { en: "Meet the assistant", is: "Aðstoðarmaðurinn" },
        description: {
          en: "Ask the AI assistant to find ideas, summarize requests or draft a new one for you.",
          is: "Biddu gervigreindar­aðstoðarmanninn um að finna hugmyndir, taka saman beiðnir eða semja nýja fyrir þig.",
        },
      },
      {
        element: "[data-tour='tour-help']",
        side: "top",
        title: { en: "Tours live here", is: "Leiðsagnir eru hér" },
        description: {
          en: "Rerun this tour or start task guides any time from this button. That's it — enjoy Pulse!",
          is: "Endurtaktu þessa leiðsögn eða opnaðu aðrar leiðbeiningar hvenær sem er með þessum hnappi. Það er allt — njóttu Pulse!",
        },
      },
    ],
  },
  {
    key: "submit-request",
    version: 1,
    title: { en: "Submitting a request", is: "Að senda inn beiðni" },
    defaultAutoStart: false,
    defaultAudience: "All",
    reofferOnNewVersion: false,
    steps: [
      {
        element: "[data-tour='submit-request']",
        route: "/home",
        side: "bottom",
        align: "end",
        advanceOnClick: true,
        title: { en: "Open the request form", is: "Opnaðu beiðnaformið" },
        description: {
          en: "Click this button to open the request form now.",
          is: "Smelltu á þennan hnapp til að opna beiðnaformið.",
        },
      },
      {
        element: "[data-tour='composer-title']",
        title: { en: "Start with a short title", is: "Byrjaðu á stuttum titli" },
        description: {
          en: "As you type, Pulse suggests existing ideas — following one is often faster than filing a new request.",
          is: "Á meðan þú skrifar stingur Pulse upp á hugmyndum sem þegar eru til — oft er fljótlegra að fylgja einni þeirra en að stofna nýja beiðni.",
        },
      },
      {
        element: "[data-tour='composer-problem']",
        side: "top",
        title: { en: "Describe the outcome", is: "Lýstu útkomunni" },
        description: {
          en: "Explain what you are trying to achieve, who is affected, and what happens today. Impact and context help triage.",
          is: "Útskýrðu hverju þú vilt ná fram, hverja þetta snertir og hvernig staðan er í dag. Samhengi hjálpar við forgangsröðun.",
        },
      },
      {
        element: "[data-tour='composer-submit']",
        side: "top",
        align: "end",
        title: { en: "Submit when ready", is: "Sendu þegar allt er klárt" },
        description: {
          en: "Attachments are malware-scanned and your organization's context stays private. The team picks it up in triage.",
          is: "Viðhengi eru vírusskönnuð og samhengi fyrirtækisins helst leynt. Teymið tekur beiðnina fyrir í forgangsröðun.",
        },
      },
    ],
  },
  {
    key: "team-workspace",
    version: 1,
    title: { en: "The team workspace", is: "Vinnusvæði teymisins" },
    defaultAutoStart: false,
    defaultAudience: "Internal",
    reofferOnNewVersion: false,
    steps: [
      {
        title: { en: "DataCentral team tools", is: "Verkfæri DataCentral-teymisins" },
        description: {
          en: "This tour covers the internal side of Pulse. Customers never see these views — they are gated to the internal organization.",
          is: "Þessi leiðsögn fer yfir innri hlið Pulse. Viðskiptavinir sjá aldrei þessi svæði — þau eru bundin við innra skipulagið.",
        },
      },
      {
        element: "[data-tour='nav-triage']",
        route: "/home",
        side: "right",
        title: { en: "Triage inbox", is: "Forgangsröðun" },
        description: {
          en: "Every new customer request lands here for assessment, routing and response.",
          is: "Allar nýjar beiðnir viðskiptavina lenda hér til mats, flokkunar og svörunar.",
        },
      },
      {
        element: "[data-tour='triage-inbox']",
        route: "/triage",
        side: "right",
        title: { en: "Work the queue", is: "Vinnsluröðin" },
        description: {
          en: "Pick a request, review the customer's context, link it to a product idea or route it to support.",
          is: "Veldu beiðni, skoðaðu samhengi viðskiptavinarins, tengdu hana við vöruhugmynd eða vísaðu henni á þjónustuver.",
        },
      },
      {
        element: "[data-tour='nav-product-ideas']",
        side: "right",
        title: { en: "Product ideas", is: "Vöruhugmyndir" },
        description: {
          en: "The internal workflow behind the public roadmap — scoring, merging and publishing ideas.",
          is: "Innra vinnuflæðið á bak við opinbera vegvísinn — stigagjöf, sameining og útgáfa hugmynda.",
        },
      },
      {
        element: "[data-tour='nav-releases']",
        side: "right",
        title: { en: "Releases", is: "Útgáfur" },
        description: {
          en: "Publish release notes; customers see them on the Updates page.",
          is: "Gefðu út útgáfulýsingar; viðskiptavinir sjá þær á uppfærslusíðunni.",
        },
      },
      {
        element: "[data-tour='nav-analytics']",
        side: "right",
        title: { en: "Analytics", is: "Greiningar" },
        description: {
          en: "Request volumes, response times and score distributions across the portfolio.",
          is: "Fjöldi beiðna, svartímar og dreifing stiga yfir vörusafnið.",
        },
      },
    ],
  },
  {
    key: "admin-settings",
    version: 1,
    title: { en: "Admin controls", is: "Stjórnandastillingar" },
    defaultAutoStart: false,
    defaultAudience: "SystemAdmins",
    reofferOnNewVersion: false,
    steps: [
      {
        element: "[data-tour='nav-settings']",
        route: "/settings",
        side: "right",
        title: { en: "Product settings", is: "Vörustillingar" },
        description: {
          en: "System administration lives here: attachment policy, scoring weights, taxonomy, webhooks — and onboarding.",
          is: "Kerfisstjórnun er hér: viðhengjastefna, stigavægi, flokkunarkerfi, vefkrókar — og nýliðaleiðsögn.",
        },
      },
      {
        element: "[data-tour='settings-onboarding']",
        side: "right",
        title: { en: "Onboarding tours", is: "Nýliðaleiðsagnir" },
        description: {
          en: "The master switch turns the whole tour system on or off. Per tour you control availability, audience and auto-start.",
          is: "Aðalrofinn kveikir eða slekkur á öllu leiðsagnakerfinu. Fyrir hverja leiðsögn stýrir þú aðgengi, markhópi og sjálfvirkri ræsingu.",
        },
      },
      {
        element: "[data-tour='onboarding-progress']",
        side: "top",
        title: { en: "Who has seen what", is: "Hver hefur séð hvað" },
        description: {
          en: "Per-user progress for every tour. Users who chose “hide tours forever” appear here — and only you can restore them.",
          is: "Framvinda hvers notanda í hverri leiðsögn. Notendur sem völdu að fela leiðsagnir birtast hér — og aðeins þú getur endurvirkjað þær.",
        },
      },
    ],
  },
];
