// Lightweight UI localization for the customer-facing app surface.
//
// Keys are the English source strings exactly as they appear in JSX — so call
// sites read naturally (t("Browse ideas")) and an untranslated string falls
// back to English instead of breaking. Icelandic follows the vocabulary
// already established by lib/server/tour-catalog.ts and /help (beiðni,
// hugmynd, vegvísir, tilkynningar, „“ quotation marks, informal þú).
// English is the source language; Icelandic is the only other locale
// (settings-repository defaultLocale: "en" | "is").

export type UiLocale = "en" | "is";

export const IS: Record<string, string> = {
  // --- navigation & shell ---
  "Home": "Heim",
  "Browse ideas": "Skoða hugmyndir",
  "Roadmap": "Vegvísir",
  "My requests": "Mínar beiðnir",
  "Updates": "Uppfærslur",
  "Help": "Hjálp",
  "Pulse help": "Pulse hjálp",
  "Submit a request": "Senda inn beiðni",
  "Primary navigation": "Aðalvalmynd",
  "Open navigation": "Opna valmynd",
  "Close navigation": "Loka valmynd",
  "Notifications": "Tilkynningar",
  "Resolving your authorized organization…": "Staðfesti aðgang fyrirtækisins þíns…",
  "Choose an organization": "Veldu fyrirtæki",
  "Organization": "Fyrirtæki",
  "Pulse could not resolve your organization access.": "Pulse gat ekki staðfest aðgang fyrirtækisins þíns.",
  "That organization context is no longer available.": "Þetta fyrirtækjasamhengi er ekki lengur í boði.",
  "Pulse is using the local preview data.": "Pulse notar staðbundin sýnigögn.",

  // --- home ---
  "Customer feedback": "Ábendingar viðskiptavina",
  "Good morning": "Góðan daginn",
  "Good afternoon": "Góðan dag",
  "Good evening": "Gott kvöld",
  "Track your requests and help shape what DataCentral builds next.":
    "Fylgstu með beiðnunum þínum og taktu þátt í að móta það sem DataCentral byggir næst.",
  "Last updated": "Síðast uppfært",
  "What would make DataCentral work better for your team?":
    "Hvað myndi láta DataCentral virka betur fyrir teymið þitt?",
  "Search existing ideas or describe a new requirement.":
    "Leitaðu í hugmyndum sem til eru eða lýstu nýrri þörf.",
  "Search ideas and requests": "Leita í hugmyndum og beiðnum",
  "Active requests": "Virkar beiðnir",
  "Across your organization": "Hjá þínu fyrirtæki",
  "Needs your input": "Bíður svars frá þér",
  "Response requested": "Óskað eftir svari",
  "Recently released": "Nýlega útgefið",
  "In the last 30 days": "Síðustu 30 daga",
  "Your requests": "Beiðnirnar þínar",
  "Latest activity from": "Nýjasta virkni frá",
  "View all": "Sjá allt",
  "Recently shipped": "Nýkomið út",
  "View release notes": "Skoða útgáfulýsingu",
  "Released": "Útgefið",

  // --- ideas ---
  "Browse customer-driven ideas": "Skoðaðu hugmyndir frá viðskiptavinum",
  "Built from governed customer evidence": "Byggt á staðfestum ábendingum viðskiptavina",
  "Search ideas": "Leita í hugmyndum",
  "All statuses": "Allar stöður",
  "Filter by product area": "Sía eftir vörusviði",
  "Product area": "Vörusvið",
  "Follow": "Fylgjast með",
  "Following": "Fylgist með",
  "Followers": "Fylgjendur",
  "No ideas match these filters": "Engar hugmyndir passa við þessar síur",
  "Try a different phrase, product area, or status.":
    "Prófaðu annað orðalag, vörusvið eða stöðu.",
  "You are now following this idea.": "Þú fylgist nú með þessari hugmynd.",
  "You will no longer receive updates.": "Þú færð ekki fleiri uppfærslur.",
  "The follow preference could not be changed.": "Ekki tókst að breyta fylgnistillingunni.",
  "Related ideas": "Skyldar hugmyndir",
  "Related ideas already exist": "Skyldar hugmyndir eru þegar til",
  "Considering": "Til skoðunar",

  // --- roadmap ---
  "Where the product is heading": "Hvert varan stefnir",
  "Product direction": "Stefna vörunnar",
  "Planned": "Á áætlun",
  "In progress": "Í vinnslu",
  "Recently delivered": "Nýlega afhent",
  "Latest update": "Nýjasta uppfærsla",
  "Last update": "Síðasta uppfærsla",

  // --- requests list & detail ---
  "Requests from": "Beiðnir frá",
  "Search requests": "Leita í beiðnum",
  "Search request number, title, or problem": "Leita eftir númeri, titli eða lýsingu",
  "No requests match these filters": "Engar beiðnir passa við þessar síur",
  "Adjust the search or submit the requirement your team needs.":
    "Breyttu leitinni eða sendu inn þörfina sem teymið þitt vantar.",
  "Status": "Staða",
  "Request": "Beiðni",
  "Submitted": "Innsend",
  "Under review": "Í skoðun",
  "Needs information": "Vantar upplýsingar",
  "Declined": "Hafnað",
  "Withdrawn": "Dregin til baka",
  "Merged": "Sameinuð",
  "Discussion": "Umræða",
  "History": "Ferill",
  "Attachments": "Viðhengi",
  "Edit": "Breyta",
  "Edited": "Breytt",
  "Close": "Loka",
  "Cancel": "Hætta við",
  "Save": "Vista",
  "Saving…": "Vista…",
  "Reply to DataCentral or add relevant information":
    "Svaraðu DataCentral eða bættu við upplýsingum",
  "Your response was added to the request.": "Svarið þitt var skráð á beiðnina.",
  "Your response could not be saved.": "Ekki tókst að vista svarið þitt.",
  "Request updated. The previous revision is preserved.":
    "Beiðnin var uppfærð. Fyrri útgáfa er varðveitt.",
  "The request could not be edited.": "Ekki tókst að breyta beiðninni.",
  "Withdraw this request? Its audit history will remain.":
    "Draga þessa beiðni til baka? Ferillinn verður áfram í endurskoðunarskrá.",
  "Request withdrawn. Its history remains available.":
    "Beiðnin var dregin til baka. Ferill hennar er áfram aðgengilegur.",
  "The request could not be withdrawn.": "Ekki tókst að draga beiðnina til baka.",
  "Comment updated. The previous version is preserved.":
    "Athugasemdin var uppfærð. Fyrri útgáfa er varðveitt.",
  "The comment could not be edited.": "Ekki tókst að breyta athugasemdinni.",
  "Remove this comment? Its audit tombstone will remain.":
    "Fjarlægja þessa athugasemd? Ummerki verða áfram í endurskoðunarskrá.",
  "The comment could not be removed.": "Ekki tókst að fjarlægja athugasemdina.",
  "DataCentral needs more context": "DataCentral vantar frekara samhengi",
  "Internal owner": "Ábyrgðaraðili",
  "Linked product idea": "Tengd vöruhugmynd",
  "Original customer need": "Upphafleg þörf viðskiptavinar",
  "Add context": "Bæta við samhengi",

  // --- composer ---
  "New customer request": "Ný beiðni viðskiptavinar",
  "For example: Scheduled report delivery to SharePoint":
    "Til dæmis: Tímasett skýrslusending á SharePoint",
  "Describe the outcome you need": "Lýstu útkomunni sem þú þarft",
  "What are you trying to achieve, who is affected, and what happens today?":
    "Hverju viltu ná fram, hverja varðar það og hvað gerist í dag?",
  "Request type": "Tegund beiðni",
  "Feature": "Nýjung",
  "Improvement": "Umbót",
  "Integration": "Samtenging",
  "Compliance": "Regluvarsla",
  "Business impact": "Viðskiptaáhrif",
  "Low": "Lítil",
  "Medium": "Miðlungs",
  "High": "Mikil",
  "Critical": "Krítísk",
  "Affected users": "Notendur sem málið varðar",
  "Optional estimate": "Valfrjálst mat",
  "Current workaround": "Núverandi hjáleið",
  "How do you handle this today?": "Hvernig leysið þið þetta í dag?",
  "Desired timing": "Æskileg tímasetning",
  "For example Q4 or 2026-11-01": "Til dæmis Q4 eða 2026-11-01",
  "Add screenshots or files": "Bættu við skjámyndum eða skrám",
  "Required": "Skylda",
  "Private": "Einkamál",
  "Submitting…": "Sendi inn…",

  // --- updates & notifications ---
  "Changes that matter to your team": "Breytingar sem skipta teymið þitt máli",
  "No unread product updates.": "Engar ólesnar uppfærslur.",
  "Notification preferences": "Tilkynningastillingar",
  "Choose when email updates arrive for this company context.":
    "Veldu hvenær tölvupóstuppfærslur berast fyrir þetta fyrirtækjasamhengi.",
  "Immediate": "Strax",
  "Daily": "Daglega",
  "Weekly": "Vikulega",
  "Off": "Slökkt",
  "Preferences saved.": "Stillingar vistaðar.",
  "Could not save this preference.": "Ekki tókst að vista stillinguna.",

  // --- page intros & filters ---
  "Product ideas": "Vöruhugmyndir",
  "See what DataCentral is reviewing, planning, and delivering. Follow an idea to receive meaningful updates.":
    "Sjáðu hvað DataCentral er að skoða, skipuleggja og afhenda. Fylgstu með hugmynd til að fá uppfærslur sem skipta máli.",
  "Directional roadmap": "Stefnumiðaður vegvísir",
  "Roadmap horizons express current intent and may change as customer evidence and delivery constraints evolve.":
    "Tímabil vegvísisins lýsa núverandi áformum og geta breyst eftir ábendingum viðskiptavina og aðstæðum í afhendingu.",
  "Roadmap items combine related requests while keeping each customer’s context private.":
    "Atriði á vegvísinum sameina skyldar beiðnir en halda samhengi hvers viðskiptavinar út af fyrir sig.",
  "Your organization": "Fyrirtækið þitt",
  "Requests from Origo": "Beiðnir frá Origo",
  "Every request keeps its original context, status history, and link to the corresponding product idea.":
    "Hver beiðni heldur upprunalegu samhengi, stöðusögu og tengingu við viðkomandi vöruhugmynd.",
  "All": "Allar",
  "Active": "Virkar",
  "Closed": "Lokaðar",
  "Clear filters": "Hreinsa síur",
  "All areas": "Öll svið",
  "Now": "Núna",
  "Next": "Næst",
  "Later": "Síðar",
  "Active delivery": "Í virkri afhendingu",
  "Approved and sequenced": "Samþykkt og í röð",
  "Validated, not committed": "Staðfest en ekki lofað",
  "ideas": "hugmyndir",
  "requests": "beiðnir",
  "organizations": "fyrirtæki",

  // --- product areas (display only; stored values stay English) ---
  "Distribution": "Dreifing",
  "Governance": "Stjórnhættir",
  "Authentication": "Auðkenning",
  "Display": "Birting",
  "Experience": "Upplifun",
  "Embedding": "Innfelling",
  "Administration": "Stjórnun",
  "Start with the problem. DataCentral will assess the right product response.":
    "Byrjaðu á vandamálinu. DataCentral metur hvaða lausn hentar best.",
  "Short title": "Stuttur titill",
  "Problem or desired outcome": "Vandamál eða óskuð útkoma",
};

export function makeT(locale: string): (s: string) => string {
  if (locale !== "is") return (s) => s;
  return (s) => IS[s] ?? s;
}
