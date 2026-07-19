"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { TourPayload, TourStatePayload } from "@/lib/tours";

// Onboarding-kit glue (DataCentralEmbedOnboardingTours.md §4, non-Blazor form):
// loads the vendored Driver.js + tour-engine.js assets, feeds the server's tour
// state to the engine, persists progress via the tours API, and renders the
// floating "guided tours" help menu (bottom-left; the chat launcher owns
// bottom-right). Renders nothing when the server suppresses tours (master
// switch off, per-user opt-out, embed without the Onboard role).

type TourEngine = {
  init: (payload: {
    tours: TourPayload[];
    strings: TourStatePayload["strings"];
    callbacks: {
      onProgress: (
        key: string,
        version: number,
        stepIndex: number,
        stepCount: number,
        status: string,
      ) => void;
      navigate: (route: string) => Promise<unknown> | void;
    };
  }) => void;
  start: (key: string, atStep?: number) => void;
  resume: (key: string) => void;
  stop: () => void;
  active: () => string | null;
  highlight: (selector: string, title: string, description: string) => void;
};

declare global {
  interface Window {
    tourEngine?: TourEngine;
  }
}

function loadScript(src: string) {
  return new Promise<void>((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
      if (existing.getAttribute("data-loaded")) return resolve();
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject(new Error(src)));
      return;
    }
    const script = document.createElement("script");
    script.src = src;
    script.async = false;
    script.addEventListener("load", () => {
      script.setAttribute("data-loaded", "1");
      resolve();
    });
    script.addEventListener("error", () => reject(new Error(src)));
    document.head.appendChild(script);
  });
}

let assetsPromise: Promise<boolean> | null = null;
function ensureAssets() {
  assetsPromise ||= (async () => {
    try {
      if (!document.querySelector("link[data-tour-css]")) {
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = "/tours/driver.css";
        link.setAttribute("data-tour-css", "1");
        document.head.appendChild(link);
      }
      await loadScript("/tours/driver.js.iife.js");
      await loadScript("/tours/tour-engine.js");
      return Boolean(window.tourEngine);
    } catch {
      return false; // tours must never break the app — the menu just won't appear
    }
  })();
  return assetsPromise;
}

export function TourHost({
  ready,
  view,
  locale,
  onNavigate,
}: {
  ready: boolean;
  view: string;
  locale: string;
  onNavigate: (view: string) => void;
}) {
  const [state, setState] = useState<TourStatePayload | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const navigateRef = useRef(onNavigate);
  useEffect(() => {
    navigateRef.current = onNavigate;
  }, [onNavigate]);
  const initInFlight = useRef(false);
  const is = locale === "is";

  const refreshState = useCallback(async () => {
    try {
      const response = await fetch("/api/v1/tours/state");
      if (!response.ok) return null;
      const payload = (await response.json()).item as TourStatePayload;
      setState(payload);
      return payload;
    } catch {
      return null;
    }
  }, []);

  const reportProgress = useCallback(
    async (
      key: string,
      version: number,
      stepIndex: number,
      stepCount: number,
      status: string,
    ) => {
      try {
        await fetch("/api/v1/tours/progress", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ key, version, stepIndex, stepCount, status }),
        });
        if (status !== "InProgress") await refreshState(); // terminal → refresh menu badges
      } catch {
        // a lost progress write must not surface mid-tour
      }
    },
    [refreshState],
  );

  const initEngine = useCallback(async () => {
    if (initInFlight.current) return;
    initInFlight.current = true;
    try {
      if (!(await ensureAssets())) return;
      const payload = await refreshState();
      if (!payload) return;
      if (payload.suppressed || !payload.tours.length) {
        window.tourEngine?.stop();
        return;
      }
      window.tourEngine?.init({
        tours: payload.tours,
        strings: payload.strings,
        callbacks: {
          onProgress: (key, version, stepIndex, stepCount, status) => {
            void reportProgress(key, version, stepIndex, stepCount, status);
          },
          // Pulse is a single-page view switcher: catalog routes are pseudo-routes
          // ("/home", "/triage", …) mapped onto the AppShell page state. The engine
          // calls this before every step whose effective route differs from the URL
          // pathname — which is every routed step here — so it must stay idempotent.
          navigate: (route) => {
            navigateRef.current(route.replace(/^\//, ""));
            return new Promise((resolve) => window.setTimeout(resolve, 80));
          },
        },
      });
    } catch {
      // tours must never break the app
    } finally {
      initInFlight.current = false;
    }
  }, [refreshState, reportProgress]);

  // Initial load + re-evaluation on every view change (§5.6.8): a master-switch
  // flip or settings change reaches open sessions without a reload — but never
  // re-init while a tour is running (that would destroy it mid-flight; cross-view
  // tours change `view` as part of normal stepping).
  useEffect(() => {
    if (!ready) return;
    if (window.tourEngine?.active()) return;
    // deferred so state updates never run synchronously inside the effect; the
    // cleanup also collapses StrictMode's dev double-invoke into one init
    const timer = window.setTimeout(() => void initEngine(), 0);
    return () => window.clearTimeout(timer);
  }, [ready, view, initEngine]);

  if (!ready || !state || state.suppressed || !state.tours.length) return null;

  const unfinished = state.tours.find((tour) => tour.status === "InProgress");

  function startTour(tour: TourPayload) {
    setMenuOpen(false);
    const at = tour.status === "InProgress" ? (tour.resumeAt ?? 0) : 0;
    try {
      window.tourEngine?.start(tour.key, at);
    } catch {
      // engine unavailable — ignore
    }
  }

  async function hideForever() {
    const question = is
      ? "Fela leiðsagnir og þennan hnapp fyrir fullt og allt? Aðeins kerfisstjóri getur birt þær aftur."
      : "Hide tours and this button forever? Only a system administrator can bring them back.";
    if (!window.confirm(question)) return;
    try {
      window.tourEngine?.stop();
      await fetch("/api/v1/tours/hide", { method: "POST" });
    } catch {
      // ignore — worst case the menu reappears next session
    }
    setMenuOpen(false);
    setState(null);
  }

  function statusIcon(tour: TourPayload) {
    if (tour.status === "Completed") return "✓";
    if (tour.status === "InProgress") return "▶";
    if (tour.status === "Dismissed") return "◌";
    return "○";
  }

  return (
    <div className="tour-host no-print">
      {!menuOpen && unfinished && (
        <button
          type="button"
          className="tour-resume-chip"
          onClick={() => startTour(unfinished)}
        >
          ▶ {unfinished.title} · {(unfinished.resumeAt ?? 0) + 1}/
          {unfinished.steps.length}
        </button>
      )}
      {menuOpen && (
        <div className="tour-menu" role="menu" aria-label="Guided tours">
          <div className="tour-menu-title">
            {is ? "Leiðsagnir" : "Guided tours"}
          </div>
          {state.tours.map((tour) => (
            <button
              type="button"
              key={tour.key}
              className="tour-menu-item"
              role="menuitem"
              onClick={() => startTour(tour)}
            >
              <span className="tour-menu-icon">{statusIcon(tour)}</span>
              <span className="tour-menu-label">{tour.title}</span>
              {tour.status === "InProgress" && (
                <span className="tour-menu-progress">
                  {(tour.resumeAt ?? 0) + 1}/{tour.steps.length}
                </span>
              )}
            </button>
          ))}
          <button
            type="button"
            className="tour-menu-hide"
            role="menuitem"
            onClick={hideForever}
          >
            {is ? "Fela leiðsagnir fyrir fullt og allt" : "Hide tours forever"}
          </button>
        </div>
      )}
      <button
        type="button"
        className="tour-help"
        data-tour="tour-help"
        aria-expanded={menuOpen}
        aria-label={is ? "Leiðsagnir" : "Guided tours"}
        title={is ? "Leiðsagnir" : "Guided tours"}
        onClick={() => setMenuOpen((value) => !value)}
      >
        ?
      </button>
    </div>
  );
}
