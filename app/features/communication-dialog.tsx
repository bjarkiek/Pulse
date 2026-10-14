"use client";
import { useState, type ReactNode } from "react";
import { Button, Icon, useT } from "./shared";

/** The frame the shell's dialog behaviour (focus, Tab, Escape, the backdrop) expects: a `modal-layer` around a `role="dialog"` section. */
export function ModalDialog({
  id,
  title,
  onClose,
  children,
}: {
  id: string;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const t = useT();
  return (
    <div
      className="modal-layer"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="management-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={id}
      >
        <header>
          <div>
            <p className="eyebrow">{t("Confirm")}</p>
            <h2 id={id}>{title}</h2>
          </div>
          <button
            className="icon-button"
            onClick={onClose}
            aria-label={t("Close")}
          >
            <Icon name="x" />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}

/**
 * A question for what cannot be undone, in place of `window.confirm`: a sandboxed frame such as DataCentral's may refuse native dialogs, and
 * the answer is then "no" without anyone having been asked. As in the editor's discard dialog the way out is the violet button and the
 * confirmation the plain one. `children` say what the question is about and what will happen. `onConfirm` does it; the confirm button waits
 * until it is done, so a second click cannot do it twice. When `onConfirm` is done, whatever came of it, the dialog calls `onClose`: a
 * rejection is not shown here (whoever asked tells the person what went wrong, usually with a toast), but it cannot leave the dialog stuck.
 */
export function ConfirmDialog({
  id,
  title,
  keepLabel,
  confirmLabel,
  onConfirm,
  onClose,
  children,
}: {
  id: string;
  title: string;
  /** The way out: say what is kept ("Keep contact"), not "Cancel", which would read as the thing being cancelled. */
  keepLabel: string;
  confirmLabel: string;
  onConfirm: () => Promise<void> | void;
  onClose: () => void;
  children: ReactNode;
}) {
  const [pending, setPending] = useState(false);
  return (
    <ModalDialog id={id} title={title} onClose={onClose}>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setPending(true);
          try {
            await onConfirm();
          } catch (error) {
            // Nothing to show here: the caller reports its own failure. The dialog closes all the same, but a rejection is not expected, so it is logged.
            console.error("The confirmed action was rejected.", error);
          } finally {
            setPending(false);
            onClose();
          }
        }}
      >
        <div className="communication-confirm">{children}</div>
        <footer>
          <span />
          <div>
            <Button onClick={onClose}>{keepLabel}</Button>
            <Button variant="secondary" type="submit" disabled={pending}>
              {confirmLabel}
            </Button>
          </div>
        </footer>
      </form>
    </ModalDialog>
  );
}
