import { getIdentity } from "@/lib/server/auth";
import { getHelpData, type HelpChapter } from "@/lib/server/tour-repository";
import { pick } from "@/lib/server/tour-catalog";

// The Pulse help site: a user manual (and, for internal/System-admin users, an
// admin manual) generated server-side from the onboarding tour catalog. Each
// chapter mirrors a guided tour step by step, with the screenshots produced by
// scripts/capture-help-screenshots.mjs (real Driver.js highlights). Reachable
// standalone at /help, from the ? tour menu, the sidebar, and the admin
// onboarding card. Audience-gated like the tours themselves: customers never
// receive the admin chapters. Detailed enough to narrate a video tutorial from.

function esc(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

type Lang = "en" | "is";

const STRINGS = {
  en: {
    title: "Pulse Help — user manual",
    heading: "DataCentral Pulse — Help",
    intro:
      "This manual mirrors the guided tours built into Pulse, step by step, with the same highlighted screenshots the tours show. Follow a chapter top to bottom — or press “Start this tour in the app” to replay it live. Each chapter doubles as a narration script for a video tutorial.",
    userManual: "User manual",
    adminManual: "Admin manual",
    contents: "Contents",
    aboutTitle: "The help system in one minute",
    about: [
      "<strong>The ? button</strong> (bottom-left) opens the guided-tours menu. Every tour can be re-run from there at any time; ✓ marks finished tours and ▶ marks one in progress.",
      "<strong>Resume chip</strong> — while a tour is unfinished, a “▶ Tour · 3/9” chip sits next to the ? button. One click continues exactly where you left off, even on another device.",
      "<strong>Deep links</strong> — opening the app with <code>/?tour=welcome</code> starts that tour immediately (used by links in this manual).",
      "<strong>Hide tours forever</strong> — the last item in the ? menu hides tours and the button permanently for you. Only a system administrator can bring them back.",
    ],
    chapterMeta: (steps: number, minutes: number) =>
      `${steps} steps · about ${minutes} min`,
    step: "Step",
    of: "of",
    startTour: "▶ Start this tour in the app",
    actionClick: "Do: click the highlighted element to continue.",
    actionNext: "Do: press Next.",
    actionDone: "Do: press Done to finish the tour.",
    screenshotAlt: (title: string) => `Screenshot: ${title} highlighted`,
    adminExtraTitle: "Administering onboarding",
    adminExtra: [
      "<strong>Master switch</strong> — Settings → “Onboarding tours”. When off, nobody sees tours, the ? menu or the resume chip, regardless of per-tour settings.",
      "<strong>Per tour</strong> you control <em>Enabled</em>, <em>Auto-start</em> (runs once for eligible users who never started it) and <em>Audience</em> (Everyone, Customers only, DataCentral team, System admins). Users only ever receive tours inside their audience.",
      "<strong>Progress grid</strong> — “Tour progress by user” shows every user × tour with status, furthest step, where they engaged (Standalone or DataCentral embed) and when. Completion percentages count only users in the tour's current audience.",
      "<strong>Restore</strong> — users who chose “Hide tours forever” appear in an amber bar above the grid; the Restore button next to their name brings tours back for them. There is deliberately no user-facing undo.",
      "<strong>DataCentral embeds</strong> — inside a DataCentral iframe, tours additionally require the launch to carry the <code>Onboard</code> role. Assign that role in DataCentral to control who gets onboarding there; standalone sign-ins are unaffected.",
    ],
    communicationsGuideTitle: "Customer communications",
    communicationsGuide: [
      "<strong>Where it lives</strong> — Communications, in the “DataCentral team” menu. Product managers and System admins write and send. The rest of the team can read the lists and the delivery results.",
      "<strong>Three templates</strong> — “New product update”, “Service notice” and “Announcement”. Each one is branded and holds English and Icelandic text. Recipients who prefer Icelandic get the English text until an Icelandic version exists. On the Releases page, “Draft customer email” starts a product update from a published release.",
      "<strong>Who receives it</strong> — On the Audience step you pick companies, or all customers. Pulse members receive it by their own topic preferences. Contacts, the people without a Pulse account kept on the Contacts tab, receive it by topic. Security advisories reach members even when they have turned the topic off.",
      "<strong>Suppressions and safe mode</strong> — An address on the Suppressions tab never receives anything, whatever company it belongs to. Bounces, spam reports and unsubscribes join the list by themselves. While safe mode is on, only allow-listed domains receive mail. The Audience and Review steps show who will receive it and who is left out, with the reason.",
      "<strong>Preview and test send</strong> — The preview beside the form shows the saved draft in the language you are editing. “Send test to me” mails the draft to your own address, marked [TEST]. Test mails never count in the results.",
      "<strong>Send, schedule, cancel</strong> — On the last step choose “Send now”, or pick a time and choose “Schedule”. Content and audience are locked once sending starts. A scheduled communication goes back to a draft with “Unschedule”. “Cancel sending” stops everyone SendGrid has not received yet. Mail already handed over is not recalled.",
      "<strong>Delivery states</strong> — Each recipient moves from Queued to Accepted to Delivered. Deferred means the receiving server asked for more time. Bounced and Dropped mean the mail did not arrive. Dead letter means every attempt failed; “Retry dead letters” tries again. Suppressed recipients were left out before sending. Opens and clicks are counted separately.",
      "<strong>Settings card</strong> — System admins use Settings → “Customer communications (SendGrid)”. Turn on “Enable sending”, choose the sender, keep safe mode on until the first real send, and press “Send configuration test”. The API key and the webhook key come from Key Vault, not from this page.",
    ],
    companyCommunicationsTitle: "Communications from DataCentral",
    companyCommunications: [
      "<strong>Your choices</strong> — DataCentral emails product updates, service notices and general announcements. On the Updates page, under “Notification preferences”, everyone switches each topic on or off for themselves. Security advisories are always delivered.",
      "<strong>For Company admins</strong> — The same page shows “Who receives DataCentral communications for your company”. Colleagues with a Pulse account receive email automatically. Add people without an account here, one at a time or with “Paste list”, and edit or remove them whenever you need to. Only Company admins see this section.",
    ],
    printHint: "Tip: this page prints cleanly — use it as a hand-out or a video-recording script.",
    languageToggle: "Íslenska",
    languageToggleHref: "?lang=is",
    backToApp: "← Back to Pulse",
  },
  is: {
    title: "Pulse hjálp — notendahandbók",
    heading: "DataCentral Pulse — Hjálp",
    intro:
      "Þessi handbók speglar innbyggðu leiðsagnirnar í Pulse, skref fyrir skref, með sömu skjámyndum og leiðsagnirnar sýna. Farðu í gegnum kafla frá byrjun til enda — eða smelltu á „Ræsa þessa leiðsögn í appinu“ til að spila hana í beinni. Hver kafli nýtist beint sem handrit að myndbandsleiðbeiningum.",
    userManual: "Notendahandbók",
    adminManual: "Stjórnendahandbók",
    contents: "Efnisyfirlit",
    aboutTitle: "Hjálparkerfið á einni mínútu",
    about: [
      "<strong>?-hnappurinn</strong> (neðst til vinstri) opnar leiðsagnavalmyndina. Allar leiðsagnir má endurtaka þaðan hvenær sem er; ✓ merkir kláraðar leiðsagnir og ▶ þá sem er í gangi.",
      "<strong>Áfram-flís</strong> — á meðan leiðsögn er ókláruð situr „▶ Leiðsögn · 3/9“ flís við ?-hnappinn. Einn smellur heldur áfram nákvæmlega þar sem frá var horfið, jafnvel á öðru tæki.",
      "<strong>Djúptenglar</strong> — sé appið opnað með <code>/?tour=welcome</code> ræsist sú leiðsögn strax (notað í tenglum þessarar handbókar).",
      "<strong>Fela leiðsagnir fyrir fullt og allt</strong> — neðsti valkosturinn í ?-valmyndinni felur leiðsagnir og hnappinn varanlega fyrir þig. Aðeins kerfisstjóri getur birt þær aftur.",
    ],
    chapterMeta: (steps: number, minutes: number) =>
      `${steps} skref · um ${minutes} mín`,
    step: "Skref",
    of: "af",
    startTour: "▶ Ræsa þessa leiðsögn í appinu",
    actionClick: "Gera: smelltu á upplýsta hlutann til að halda áfram.",
    actionNext: "Gera: ýttu á Áfram.",
    actionDone: "Gera: ýttu á Ljúka til að klára leiðsögnina.",
    screenshotAlt: (title: string) => `Skjámynd: ${title} upplýst`,
    adminExtraTitle: "Umsýsla nýliðaleiðsagna",
    adminExtra: [
      "<strong>Aðalrofi</strong> — Settings → „Onboarding tours“. Þegar slökkt er sér enginn leiðsagnir, ?-valmyndina né áfram-flísina, óháð stillingum einstakra leiðsagna.",
      "<strong>Fyrir hverja leiðsögn</strong> stýrir þú <em>Enabled</em>, <em>Auto-start</em> (keyrir einu sinni fyrir gjaldgenga notendur sem aldrei byrjuðu) og <em>Audience</em> (allir, aðeins viðskiptavinir, DataCentral-teymið, kerfisstjórar). Notendur fá aldrei leiðsagnir utan síns markhóps.",
      "<strong>Framvindutafla</strong> — „Tour progress by user“ sýnir hvern notanda × leiðsögn með stöðu, lengsta skrefi, hvar var unnið (Standalone eða DataCentral) og hvenær. Prósentur telja aðeins notendur í núverandi markhópi leiðsagnarinnar.",
      "<strong>Endurvirkja</strong> — notendur sem völdu „Fela leiðsagnir fyrir fullt og allt“ birtast í gulri rönd fyrir ofan töfluna; Restore-hnappurinn við nafnið þeirra kveikir aftur á leiðsögnum fyrir þá. Það er viljandi engin afturköllun fyrir notandann sjálfan.",
      "<strong>DataCentral-innfellingar</strong> — inni í DataCentral-iframe þurfa leiðsagnir að auki að ræsingin beri <code>Onboard</code>-hlutverkið. Úthlutaðu því hlutverki í DataCentral til að stýra hverjir fá leiðsögn þar; bein innskráning er óbreytt.",
    ],
    communicationsGuideTitle: "Samskipti við viðskiptavini",
    communicationsGuide: [
      "<strong>Staðsetning</strong> — Samskipti eru í valmyndinni „DataCentral-teymið“. Vörustjórar og kerfisstjórar semja og senda. Aðrir í teyminu geta skoðað listana og niðurstöður sendinga.",
      "<strong>Þrjú sniðmát</strong> — „Ný vöruuppfærsla“, „Þjónustutilkynning“ og „Tilkynning“. Öll eru með vörumerki og geyma texta á ensku og íslensku. Viðtakendur sem kjósa íslensku fá enska textann þar til íslensk útgáfa er til. Á útgáfusíðunni er hægt að velja „Semja tölvupóst til viðskiptavina“ fyrir útgefnar útgáfur; þá byrjar vöruuppfærsla með texta úr útgáfunni.",
      "<strong>Hverjir fá sendinguna</strong> — Í skrefinu „Viðtakendur“ velur þú fyrirtæki eða öll fyrirtæki viðskiptavina. Meðlimir í Pulse fá hana eftir eigin stillingum. Tengiliðir, fólk án Pulse-aðgangs á flipanum „Tengiliðir“, fá hana eftir efnisflokki. Öryggistilkynningar ná til meðlima þótt þeir hafi slökkt á efnisflokknum.",
      "<strong>Útilokanir og öruggur hamur</strong> — Netfang á flipanum „Útilokanir“ fær aldrei neitt, sama hvaða fyrirtæki það tilheyrir. Netföng sem skila sér ekki, ruslpóstskvartanir og afskráningar bætast sjálfkrafa á listann. Meðan öruggur hamur er á fá aðeins leyfð lén póst. Skrefin „Viðtakendur“ og „Yfirfara og senda“ sýna hverjir fá sendinguna og hverjir eru útilokaðir, með ástæðu.",
      "<strong>Forskoðun og prófun</strong> — Forskoðunin við hliðina á forminu sýnir vistuðu drögin á tungumálinu sem þú ert að breyta. „Senda prófun á mig“ sendir drögin á þitt eigið netfang, merkt [TEST]. Prófanir telja aldrei með í niðurstöðum.",
      "<strong>Senda, tímasetja, hætta við</strong> — Í síðasta skrefinu velur þú „Senda núna“, eða velur tíma og „Tímasetja“. Efni og viðtakendur læsast þegar sending hefst. Tímasetta sendingu má gera aftur að drögum með „Aftengja tímasetningu“. „Hætta við sendingu“ stöðvar alla sem SendGrid hefur ekki enn fengið. Póstur sem þegar er farinn er ekki kallaður til baka.",
      "<strong>Sendingarstöður</strong> — Hver viðtakandi fer úr „Í biðröð“ í „Móttekið“ og svo „Afhent“. „Frestað“ þýðir að móttökuþjónninn bað um meiri tíma. „Skiluðu sér ekki“ og „Fellt niður“ þýða að pósturinn barst ekki. „Endurtilraunir tæmdar“ þýðir að allar tilraunir mistókust; „Reyna aftur sendingar sem mistókust“ reynir aftur. „Útilokað“ merkir að viðtakandinn var undanskilinn áður en sending hófst. Opnanir og smellir eru talin sérstaklega.",
      "<strong>Stillingaspjaldið</strong> — Kerfisstjórar nota Stillingar → „Samskipti við viðskiptavini (SendGrid)“. Þar kveikja þeir á „Virkja sendingar“, velja sendanda, halda öruggum ham á þar til fyrsta raunverulega sendingin fer út og ýta á „Senda prófun á uppsetningu“. API-lykillinn og lykillinn fyrir atburðavefkrókinn koma úr Key Vault, ekki héðan.",
    ],
    companyCommunicationsTitle: "Samskipti frá DataCentral",
    companyCommunications: [
      "<strong>Þínar stillingar</strong> — DataCentral sendir vöruuppfærslur, þjónustutilkynningar og almennar tilkynningar í tölvupósti. Á uppfærslusíðunni, undir „Tilkynningastillingar“, kveikir eða slekkur hver og einn á hverjum efnisflokki fyrir sig. Öryggistilkynningar eru alltaf sendar.",
      "<strong>Fyrir fyrirtækisstjóra</strong> — Á sömu síðu er hlutinn „Hverjir fá samskipti frá DataCentral fyrir fyrirtækið þitt“. Samstarfsfólk með Pulse-aðgang fær tölvupóst sjálfkrafa. Bættu hér við fólki án aðgangs, einu í einu eða með „Líma lista“, og breyttu þeim eða fjarlægðu þegar þörf krefur. Aðeins fyrirtækisstjórar sjá þennan hluta.",
    ],
    printHint: "Ábending: síðan prentast hreint — nýttu hana sem dreifiblað eða upptökuhandrit.",
    languageToggle: "English",
    languageToggleHref: "?lang=en",
    backToApp: "← Til baka í Pulse",
  },
} as const;

// Chapter intros keyed by tour key (narration-style openers for video scripts).
const CHAPTER_INTROS: Record<string, { en: string; is: string }> = {
  welcome: {
    en: "Your first minute in Pulse: where things are, how to search before you ask, and where your requests live. This tour starts automatically on first sign-in.",
    is: "Fyrsta mínútan þín í Pulse: hvar hlutirnir eru, hvernig þú leitar áður en þú biður og hvar beiðnirnar þínar búa. Þessi leiðsögn ræsist sjálfkrafa við fyrstu innskráningu.",
  },
  "submit-request": {
    en: "Filing a great request end to end: a sharp title, the duplicate suggestions, describing the outcome, and what happens after you submit.",
    is: "Að senda inn góða beiðni frá A til Ö: hnitmiðaður titill, ábendingar um tvítekningar, lýsing á útkomunni og hvað gerist eftir innsendingu.",
  },
  "team-workspace": {
    en: "The internal side of Pulse for the DataCentral team: triage, product ideas, releases and analytics. Customers never see these views.",
    is: "Innri hlið Pulse fyrir DataCentral-teymið: forgangsröðun, vöruhugmyndir, útgáfur og greiningar. Viðskiptavinir sjá aldrei þessi svæði.",
  },
  "admin-settings": {
    en: "System administration: product settings and the onboarding controls — the master switch, per-tour audiences, and the per-user progress grid with Restore.",
    is: "Kerfisstjórnun: vörustillingar og stýringar nýliðaleiðsagna — aðalrofinn, markhópar hverrar leiðsagnar og framvindutafla með endurvirkjun.",
  },
  "customer-communications": {
    en: "Writing to customer companies from Pulse: where Communications lives, how a draft starts from a template, who receives it, and where System admins set up sending. Customers never see these views.",
    is: "Að skrifa til fyrirtækja viðskiptavina í Pulse: hvar Samskipti eru, hvernig drög byrja á sniðmáti, hverjir fá þau og hvar kerfisstjórar setja upp sendingar. Viðskiptavinir sjá aldrei þessi svæði.",
  },
};

function renderChapter(chapter: HelpChapter, lang: Lang) {
  const t = STRINGS[lang];
  const { def } = chapter;
  const title = pick(def.title, lang);
  const intro = CHAPTER_INTROS[def.key]
    ? CHAPTER_INTROS[def.key][lang]
    : "";
  const minutes = Math.max(1, Math.round(def.steps.length / 3));
  const steps = def.steps
    .map((step, index) => {
      const last = index === def.steps.length - 1;
      const action = step.advanceOnClick
        ? t.actionClick
        : last
          ? t.actionDone
          : t.actionNext;
      const stepTitle = pick(step.title, lang);
      return `
      <div class="step" id="${esc(def.key)}-step-${index + 1}">
        <div class="step-head">
          <span class="step-number">${index + 1}</span>
          <div>
            <h4>${esc(stepTitle)}</h4>
            <p class="step-count">${t.step} ${index + 1} ${t.of} ${def.steps.length}</p>
          </div>
        </div>
        <p class="step-description">${esc(pick(step.description, lang))}</p>
        <p class="step-action">${esc(action)}</p>
        <figure>
          <img src="/help/${esc(def.key)}-step-${index + 1}.png"
               alt="${esc(t.screenshotAlt(stepTitle))}" loading="lazy" />
        </figure>
      </div>`;
    })
    .join("");
  return `
  <section class="chapter" id="${esc(def.key)}">
    <header class="chapter-head">
      <h3>${esc(title)}</h3>
      <span class="chapter-meta">${esc(t.chapterMeta(def.steps.length, minutes))} · ${esc(def.key)} · v${def.version}</span>
    </header>
    ${intro ? `<p class="chapter-intro">${esc(intro)}</p>` : ""}
    <p><a class="start-link" href="/?tour=${encodeURIComponent(def.key)}">${esc(t.startTour)}</a></p>
    ${steps}
  </section>`;
}

// A block of short prose after the chapters of a manual. The class is the manual's prose-block style, which is not only for the admin manual.
function renderExtra(title: string, items: readonly string[], id?: string) {
  return `<div class="admin-extra"${id ? ` id="${esc(id)}"` : ""}>
    <h5>${esc(title)}</h5>
    <ul>${items.map((item) => `<li>${item}</li>`).join("")}</ul>
  </div>`;
}

function tocEntry(chapter: HelpChapter, lang: Lang) {
  const title = pick(chapter.def.title, lang);
  return `<li><a href="#${esc(chapter.def.key)}">${esc(title)}</a> <span>${chapter.def.steps.length}</span></li>`;
}

export async function GET(request: Request) {
  let data;
  try {
    data = await getHelpData(await getIdentity(request));
  } catch {
    // no session (or no active user row): send the browser through sign-in
    return Response.redirect(
      new URL("/auth/login?returnUrl=%2Fhelp", request.url),
      302,
    );
  }
  const url = new URL(request.url);
  const langParam = url.searchParams.get("lang");
  const lang: Lang =
    langParam === "is" || langParam === "en"
      ? langParam
      : data.locale === "is"
        ? "is"
        : "en";
  const t = STRINGS[lang];
  const showAdmin = data.adminChapters.length > 0;

  const html = `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(t.title)}</title>
<style>
  :root{--violet-600:#7c3aed;--violet-700:#6d28d9;--violet-50:#f5f3ff;--amber-50:#fffbeb;--amber-200:#fde68a;--amber-700:#b45309;
    --page:#fafafa;--card:#fff;--text:#171717;--muted:#737373;--border:#e5e5e5;
    --font-heading:"Space Grotesk",sans-serif;--font-body:"IBM Plex Sans",sans-serif;--font-mono:"IBM Plex Mono",monospace}
  @font-face{font-family:"Space Grotesk";font-style:normal;font-weight:700;src:url("/fonts/SpaceGrotesk-700.woff2") format("woff2");font-display:swap}
  @font-face{font-family:"IBM Plex Sans";font-style:normal;font-weight:400;src:url("/fonts/IBMPlexSans-400.woff2") format("woff2");font-display:swap}
  @font-face{font-family:"IBM Plex Sans";font-style:normal;font-weight:600;src:url("/fonts/IBMPlexSans-600.woff2") format("woff2");font-display:swap}
  *{box-sizing:border-box}
  body{margin:0;background:var(--page);color:var(--text);font-family:var(--font-body);font-size:15px;line-height:1.6}
  .wrap{max-width:860px;margin:0 auto;padding:32px 20px 80px}
  .top{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:6px}
  .top a{color:var(--violet-700);text-decoration:none;font-size:13px}
  h1{font-family:var(--font-heading);font-size:28px;margin:6px 0 10px}
  h2{font-family:var(--font-heading);font-size:21px;margin:44px 0 6px;padding-top:22px;border-top:2px solid var(--violet-600)}
  h3{font-family:var(--font-heading);font-size:18px;margin:0}
  .lead{color:var(--muted);max-width:64ch}
  .hint{font-size:12px;color:var(--muted)}
  .toc{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:16px 20px;margin:20px 0}
  .toc h5{margin:0 0 8px;font-family:var(--font-heading);font-size:13px}
  .toc ol{margin:4px 0;padding-left:20px}
  .toc li{margin:3px 0}
  .toc a{color:var(--text);text-decoration:none}
  .toc a:hover{color:var(--violet-700)}
  .toc li span{color:var(--muted);font-size:12px}
  .about,.admin-extra{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:18px 20px;margin:16px 0}
  .about h5,.admin-extra h5{margin:0 0 10px;font-family:var(--font-heading);font-size:15px}
  .about ul,.admin-extra ul{margin:0;padding-left:18px}
  .about li,.admin-extra li{margin:7px 0}
  code{font-family:var(--font-mono);font-size:12px;background:var(--violet-50);border-radius:4px;padding:1px 5px}
  .chapter{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:22px 24px;margin:18px 0}
  .chapter-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap}
  .chapter-meta{font-family:var(--font-mono);font-size:11px;color:var(--muted)}
  .chapter-intro{color:var(--muted);max-width:64ch}
  .start-link{display:inline-block;background:var(--violet-600);color:#fff;text-decoration:none;border-radius:8px;padding:7px 14px;font-size:13px;font-weight:600}
  .start-link:hover{background:var(--violet-700)}
  .step{border-top:1px solid var(--border);padding:18px 0 6px;margin-top:16px}
  .step-head{display:flex;align-items:center;gap:12px}
  .step-number{flex-shrink:0;width:30px;height:30px;border-radius:50%;background:var(--violet-600);color:#fff;display:grid;place-items:center;font-family:var(--font-heading);font-weight:700;font-size:14px}
  .step-head h4{margin:0;font-family:var(--font-heading);font-size:15px}
  .step-count{margin:1px 0 0;font-size:11px;color:var(--muted)}
  .step-description{margin:10px 0 4px;max-width:66ch}
  .step-action{margin:2px 0 12px;font-size:13px;color:var(--violet-700);font-weight:600}
  figure{margin:0}
  figure img{width:100%;border:1px solid var(--border);border-radius:10px;box-shadow:0 2px 8px rgba(23,23,23,.08)}
  @media print{
    body{background:#fff}
    .wrap{max-width:none;padding:0}
    .top,.start-link{display:none}
    .chapter,.about,.admin-extra,.toc{border:0;box-shadow:none;padding:0}
    .step{break-inside:avoid}
    h2{break-before:page}
  }
</style>
</head>
<body>
<div class="wrap">
  <div class="top">
    <a href="/">${esc(t.backToApp)}</a>
    <a href="${esc(t.languageToggleHref)}">${esc(t.languageToggle)}</a>
  </div>
  <h1>${esc(t.heading)}</h1>
  <p class="lead">${esc(t.intro)}</p>
  <p class="hint">${esc(t.printHint)}</p>

  <nav class="toc">
    <h5>${esc(t.contents)}</h5>
    <strong>${esc(t.userManual)}</strong>
    <ol>${data.userChapters.map((chapter) => tocEntry(chapter, lang)).join("")}</ol>
    ${
      showAdmin
        ? `<strong>${esc(t.adminManual)}</strong>
    <ol>${data.adminChapters.map((chapter) => tocEntry(chapter, lang)).join("")}</ol>`
        : ""
    }
  </nav>

  <div class="about">
    <h5>${esc(t.aboutTitle)}</h5>
    <ul>${t.about.map((item) => `<li>${item}</li>`).join("")}</ul>
    <figure>
      <img src="/help/help-menu.png" alt="${esc(lang === "is" ? "Skjámynd: leiðsagnavalmyndin opin" : "Screenshot: the guided-tours menu open")}" loading="lazy" />
    </figure>
  </div>

  <h2 id="user">${esc(t.userManual)}</h2>
  ${data.userChapters.map((chapter) => renderChapter(chapter, lang)).join("")}
  ${renderExtra(t.companyCommunicationsTitle, t.companyCommunications, "company-communications")}

  ${
    showAdmin
      ? `<h2 id="admin">${esc(t.adminManual)}</h2>
  ${data.adminChapters.map((chapter) => renderChapter(chapter, lang)).join("")}
  ${renderExtra(t.adminExtraTitle, t.adminExtra)}
  ${renderExtra(t.communicationsGuideTitle, t.communicationsGuide, "communications-guide")}`
      : ""
  }
</div>
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}
