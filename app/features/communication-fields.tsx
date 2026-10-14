"use client";
import { useState, type ReactNode } from "react";
import { Button, useT } from "./shared";

/** One body of a communication as the server stores it: the fields of the product update, the service notice or the announcement. */
export type TemplateBody = Record<string, unknown>;
/** Merges changes into the body of the language being edited. */
export type PatchBody = (next: TemplateBody) => void;

/** The name an author knows each template by (the keys are translated where they are shown). */
export const COMMUNICATION_TEMPLATE_LABELS = {
  "product-update": "Product update",
  "service-notice": "Service notice",
  plain: "Announcement",
} as const;

/** The tone each status is shown in, in the list and in the detail view (the status itself is translated where it is shown). */
export const COMMUNICATION_STATUS_TONE = {
  Draft: "neutral",
  Scheduled: "warning",
  Sending: "violet",
  Sent: "success",
  Cancelled: "error",
} as const;

type Link = { label: string; url: string };
type Callout = { tone: "warning" | "info"; label?: string; text: string };
type Section = {
  heading: string;
  body: string;
  callout?: Callout;
  link?: Link;
};

/** The most each text may hold, as `lib/contracts.ts` has it: a longer one is refused on save, so the inputs stop at the limit. */
const MAX = {
  eyebrow: 60,
  title: 140,
  subtitle: 200,
  intro: 2000,
  heading: 120,
  text: 2000,
  calloutLabel: 80,
  calloutText: 600,
  linkLabel: 120,
  url: 2000,
  note: 600,
  signOff: 200,
  summary: 2000,
  window: 40,
  impact: 1000,
  contact: 200,
};

export function Field({
  label,
  hint,
  wide,
  children,
}: {
  label: string;
  hint?: string;
  wide?: boolean;
  children: ReactNode;
}) {
  const t = useT();
  return (
    <label className={wide ? "form-field form-field-wide" : "form-field"}>
      <span>
        {t(label)}
        {hint && (
          <em className={hint === "Required" ? undefined : "field-hint"}>
            {t(hint)}
          </em>
        )}
      </span>
      {children}
    </label>
  );
}

const textOf = (body: TemplateBody, key: string) =>
  typeof body[key] === "string" ? (body[key] as string) : "";
const linkOf = (value: unknown) =>
  value && typeof value === "object" ? (value as Link) : undefined;
const listOf = (value: unknown) =>
  Array.isArray(value) ? (value as string[]) : [];

/** A single-line field, or a text area when `rows` is given. */
function Text({
  label,
  hint,
  value,
  onChange,
  rows,
  type,
  placeholder,
  max,
  wide,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  rows?: number;
  type?: "url";
  placeholder?: string;
  max?: number;
  wide?: boolean;
}) {
  return (
    <Field label={label} hint={hint} wide={wide}>
      {rows ? (
        <textarea
          rows={rows}
          value={value}
          maxLength={max}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <input
          type={type}
          value={value}
          maxLength={max}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </Field>
  );
}

/**
 * One text area for a list: a line (or a paragraph) per entry. The list drops empty entries, so a field that showed only the list could
 * not hold the line break the author types to start the next entry. The text being typed is therefore kept here, and shown for as long as
 * it still makes the list the draft holds; when the draft's list is replaced from outside (the other language, a reloaded draft) the
 * list's own text is shown instead.
 */
function ListText({
  label,
  hint,
  rows,
  items,
  by,
  onChange,
}: {
  label: string;
  hint?: string;
  rows: number;
  items: string[];
  by: "line" | "paragraph";
  onChange: (items: string[]) => void;
}) {
  // An entry per line, or per paragraph (blank lines, which may hold spaces, separate them).
  const { splitOn, joinWith } =
    by === "line"
      ? { splitOn: /\n/, joinWith: "\n" }
      : { splitOn: /\n\s*\n/, joinWith: "\n\n" };
  const [typed, setTyped] = useState(() => items.join(joinWith));
  const parse = (text: string) =>
    text
      .split(splitOn)
      .map((part) => part.trim())
      .filter(Boolean);
  const typedItems = parse(typed);
  const current =
    typedItems.length === items.length &&
    typedItems.every((part, index) => part === items[index]);
  return (
    <Field label={label} hint={hint}>
      <textarea
        rows={rows}
        value={current ? typed : items.join(joinWith)}
        onChange={(event) => {
          setTyped(event.target.value);
          onChange(parse(event.target.value));
        }}
      />
    </Field>
  );
}

/** A label and an address that only count together: both empty means no link at all. */
function LinkFields({
  labelText,
  urlText,
  value,
  onChange,
}: {
  labelText: string;
  urlText: string;
  value: Link | undefined;
  onChange: (next: Link | undefined) => void;
}) {
  const set = (key: keyof Link, entered: string) => {
    const next = {
      label: value?.label ?? "",
      url: value?.url ?? "",
      [key]: entered,
    };
    onChange(next.label || next.url ? next : undefined);
  };
  return (
    <>
      <Text
        label={labelText}
        max={MAX.linkLabel}
        value={value?.label ?? ""}
        onChange={(entered) => set("label", entered)}
      />
      <Text
        label={urlText}
        type="url"
        max={MAX.url}
        placeholder="https://"
        value={value?.url ?? ""}
        onChange={(entered) => set("url", entered)}
      />
    </>
  );
}

/** The label and the text of a section's callout; its tone is chosen where the callout is switched on. */
function CalloutFields({
  callout,
  onChange,
}: {
  callout: Callout;
  onChange: (next: Callout) => void;
}) {
  return (
    <>
      <Text
        label="Callout label"
        max={MAX.calloutLabel}
        value={callout.label ?? ""}
        onChange={(value) =>
          onChange({ ...callout, label: value || undefined })
        }
      />
      <Text
        label="Callout text"
        hint="Required"
        rows={2}
        max={MAX.calloutText}
        wide
        value={callout.text}
        onChange={(value) => onChange({ ...callout, text: value })}
      />
    </>
  );
}

export function ProductUpdateFields({
  body,
  patchBody,
}: {
  body: TemplateBody;
  patchBody: PatchBody;
}) {
  const t = useT();
  const sections = Array.isArray(body.sections)
    ? (body.sections as Section[])
    : [];
  const setSection = (index: number, next: Partial<Section>) =>
    patchBody({
      sections: sections.map((section, i) =>
        i === index ? { ...section, ...next } : section,
      ),
    });
  return (
    <>
      <Text
        label="Eyebrow"
        max={MAX.eyebrow}
        placeholder={t("Product update")}
        value={textOf(body, "eyebrow")}
        onChange={(value) => patchBody({ eyebrow: value || undefined })}
      />
      <Text
        label="Title"
        hint="Required"
        max={MAX.title}
        value={textOf(body, "title")}
        onChange={(value) => patchBody({ title: value })}
      />
      <Text
        label="Subtitle"
        max={MAX.subtitle}
        value={textOf(body, "subtitle")}
        onChange={(value) => patchBody({ subtitle: value || undefined })}
      />
      <Text
        label="Introduction"
        hint="Required"
        rows={4}
        max={MAX.intro}
        value={textOf(body, "intro")}
        onChange={(value) => patchBody({ intro: value })}
      />
      <fieldset className="communication-sections">
        <legend>{t("Highlights")}</legend>
        {sections.map((section, index) => (
          <div className="communication-section" key={index}>
            <Text
              label="Heading"
              hint="Required"
              max={MAX.heading}
              value={section.heading}
              onChange={(value) => setSection(index, { heading: value })}
            />
            <Text
              label="Text"
              hint="**bold** and [label](https://…) are supported"
              rows={4}
              max={MAX.text}
              value={section.body}
              onChange={(value) => setSection(index, { body: value })}
            />
            <div className="form-grid">
              <Field label="Callout">
                <select
                  value={section.callout?.tone ?? ""}
                  onChange={(event) =>
                    setSection(index, {
                      callout: event.target.value
                        ? {
                            tone: event.target.value as Callout["tone"],
                            label: section.callout?.label,
                            text: section.callout?.text ?? "",
                          }
                        : undefined,
                    })
                  }
                >
                  <option value="">{t("None")}</option>
                  <option value="warning">
                    {t("Action required (amber)")}
                  </option>
                  <option value="info">{t("Note (violet)")}</option>
                </select>
              </Field>
              {section.callout && (
                <CalloutFields
                  callout={section.callout}
                  onChange={(callout) => setSection(index, { callout })}
                />
              )}
            </div>
            <div className="form-grid">
              <LinkFields
                labelText="Link label"
                urlText="Link URL (https)"
                value={section.link}
                onChange={(link) => setSection(index, { link })}
              />
            </div>
            <Button
              variant="ghost"
              onClick={() =>
                patchBody({ sections: sections.filter((_, i) => i !== index) })
              }
              disabled={sections.length <= 1}
            >
              {t("Remove highlight")}
            </Button>
          </div>
        ))}
        <Button
          variant="secondary"
          icon="plus"
          onClick={() =>
            patchBody({ sections: [...sections, { heading: "", body: "" }] })
          }
          disabled={sections.length >= 8}
        >
          {t("Add highlight")}
        </Button>
      </fieldset>
      <Text
        label="Note (violet box)"
        rows={2}
        max={MAX.note}
        value={textOf(body, "note")}
        onChange={(value) => patchBody({ note: value || undefined })}
      />
      <div className="form-grid">
        <LinkFields
          labelText="Button label"
          urlText="Button URL (https)"
          value={linkOf(body.cta)}
          onChange={(cta) => patchBody({ cta })}
        />
      </div>
      <Text
        label="Sign-off (leave empty for the default)"
        max={MAX.signOff}
        value={textOf(body, "signOff")}
        onChange={(value) => patchBody({ signOff: value || undefined })}
      />
    </>
  );
}

type TimeWindow = { startsAt: string; endsAt: string; timezone: string };

export function ServiceNoticeFields({
  body,
  patchBody,
}: {
  body: TemplateBody;
  patchBody: PatchBody;
}) {
  const t = useT();
  const timeWindow = (body.window ?? undefined) as
    Partial<TimeWindow> | undefined;
  // The three parts of a window only count together: with all of them empty there is no window.
  const setWindow = (key: keyof TimeWindow, entered: string) => {
    const next = {
      startsAt: timeWindow?.startsAt ?? "",
      endsAt: timeWindow?.endsAt ?? "",
      timezone: timeWindow?.timezone ?? "",
      [key]: entered,
    };
    patchBody({
      window:
        next.startsAt.trim() || next.endsAt.trim() || next.timezone.trim()
          ? next
          : undefined,
    });
  };
  return (
    <>
      <Text
        label="Title"
        hint="Required"
        max={MAX.title}
        value={textOf(body, "title")}
        onChange={(value) => patchBody({ title: value })}
      />
      <Text
        label="Summary"
        hint="Required"
        rows={4}
        max={MAX.summary}
        value={textOf(body, "summary")}
        onChange={(value) => patchBody({ summary: value })}
      />
      <fieldset className="communication-sections">
        <legend>{t("Time window (all three fields, or none)")}</legend>
        <div className="form-grid communication-window">
          <Text
            label="Starts"
            max={MAX.window}
            placeholder="YYYY-MM-DD HH:mm"
            value={timeWindow?.startsAt ?? ""}
            onChange={(value) => setWindow("startsAt", value)}
          />
          <Text
            label="Ends"
            max={MAX.window}
            placeholder="YYYY-MM-DD HH:mm"
            value={timeWindow?.endsAt ?? ""}
            onChange={(value) => setWindow("endsAt", value)}
          />
          <Text
            label="Time zone"
            max={MAX.window}
            placeholder="UTC"
            value={timeWindow?.timezone ?? ""}
            onChange={(value) => setWindow("timezone", value)}
          />
        </div>
      </fieldset>
      <Text
        label="Impact"
        rows={3}
        max={MAX.impact}
        value={textOf(body, "impact")}
        onChange={(value) => patchBody({ impact: value || undefined })}
      />
      <ListText
        label="What customers should do (one step per line)"
        rows={4}
        items={listOf(body.actions)}
        by="line"
        onChange={(actions) => patchBody({ actions })}
      />
      <div className="form-grid">
        <LinkFields
          labelText="Link label"
          urlText="Link URL (https)"
          value={linkOf(body.link)}
          onChange={(link) => patchBody({ link })}
        />
      </div>
      <Text
        label="Contact"
        max={MAX.contact}
        value={textOf(body, "contact")}
        onChange={(value) => patchBody({ contact: value || undefined })}
      />
      <Text
        label="Sign-off (leave empty for the default)"
        max={MAX.signOff}
        value={textOf(body, "signOff")}
        onChange={(value) => patchBody({ signOff: value || undefined })}
      />
    </>
  );
}

export function PlainFields({
  body,
  patchBody,
}: {
  body: TemplateBody;
  patchBody: PatchBody;
}) {
  return (
    <>
      <Text
        label="Title"
        hint="Required"
        max={MAX.title}
        value={textOf(body, "title")}
        onChange={(value) => patchBody({ title: value })}
      />
      <ListText
        label="Paragraphs (separate with a blank line)"
        hint="Required"
        rows={8}
        items={listOf(body.paragraphs)}
        by="paragraph"
        onChange={(paragraphs) => patchBody({ paragraphs })}
      />
      <div className="form-grid">
        <LinkFields
          labelText="Button label"
          urlText="Button URL (https)"
          value={linkOf(body.cta)}
          onChange={(cta) => patchBody({ cta })}
        />
      </div>
      <Text
        label="Sign-off (leave empty for the default)"
        max={MAX.signOff}
        value={textOf(body, "signOff")}
        onChange={(value) => patchBody({ signOff: value || undefined })}
      />
    </>
  );
}
