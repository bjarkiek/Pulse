"use client";
import { useEffect, useState } from "react";
import { apiFetch, errorMessage } from "@/lib/api-client";
export function useResource<T>(url: string, pollMs = 0) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    const load = () =>
      apiFetch<T>(url, { signal: controller.signal })
        .then((value) => {
          if (!controller.signal.aborted) {
            setData(value);
            setError("");
          }
        })
        .catch((reason) => {
          if (!controller.signal.aborted) setError(errorMessage(reason));
        });
    void load();
    const timer = pollMs ? window.setInterval(load, pollMs) : undefined;
    return () => {
      controller.abort();
      if (timer) window.clearInterval(timer);
    };
  }, [url, attempt, pollMs]);
  return { data, error, retry: () => setAttempt((n) => n + 1) };
}
