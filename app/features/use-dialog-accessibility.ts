"use client";
import { useEffect } from "react";

/** Focus and keyboard behavior shared by every modal and drawer in the shell. */
export function useDialogAccessibility() {
  useEffect(() => {
    const previous = new Map<HTMLElement, HTMLElement | null>();
    const originalOverflow = document.body.style.overflow;
    let current: HTMLElement | undefined;
    const focusable = (dialog: HTMLElement) =>
      Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]',
        ),
      ).filter((e) => e.getClientRects().length);
    const sync = () => {
      const dialogs = Array.from(
        document.querySelectorAll<HTMLElement>(
          '[role="dialog"][aria-modal="true"],.driver-popover[role="dialog"]',
        ),
      );
      for (const [dialog, trigger] of previous)
        if (!dialogs.includes(dialog)) {
          previous.delete(dialog);
          if (trigger?.isConnected) trigger.focus();
        }
      current = dialogs.at(-1);
      for (const dialog of dialogs)
        if (!previous.has(dialog)) {
          previous.set(
            dialog,
            document.activeElement instanceof HTMLElement
              ? document.activeElement
              : null,
          );
          if (
            !dialog.getAttribute("aria-labelledby") &&
            !dialog.getAttribute("aria-label")
          ) {
            const heading = dialog.querySelector("h2,h3");
            if (heading) {
              heading.id ||= `dialog-${crypto.randomUUID()}`;
              dialog.setAttribute("aria-labelledby", heading.id);
            }
          }
          dialog.tabIndex = -1;
          (focusable(dialog)[0] || dialog).focus();
        }
      document.body.style.overflow = current ? "hidden" : originalOverflow;
    };
    const keydown = (event: KeyboardEvent) => {
      if (!current) return;
      if (event.key === "Escape") {
        if (current.matches(".driver-popover")) { current.querySelector<HTMLButtonElement>(".driver-popover-close-btn")?.click(); return; }
        event.preventDefault();
        current
          .closest(".modal-layer,.drawer-layer")
          ?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      }
      if (event.key === "Tab") {
        const elements = focusable(current);
        const first = elements[0] || current;
        const last = elements.at(-1) || current;
        if (
          event.shiftKey &&
          (document.activeElement === first ||
            !current.contains(document.activeElement))
        ) {
          event.preventDefault();
          last.focus();
        } else if (
          !event.shiftKey &&
          (document.activeElement === last ||
            !current.contains(document.activeElement))
        ) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    const focusin = (event: FocusEvent) => {
      if (current && !current.contains(event.target as Node))
        (focusable(current)[0] || current).focus();
    };
    const observer = new MutationObserver(sync);
    observer.observe(document.body, { childList: true, subtree: true });
    document.addEventListener("keydown", keydown);
    document.addEventListener("focusin", focusin);
    sync();
    return () => {
      observer.disconnect();
      document.removeEventListener("keydown", keydown);
      document.removeEventListener("focusin", focusin);
      document.body.style.overflow = originalOverflow;
    };
  }, []);
}
