"use client";
import { useState } from "react";
import { apiFetch, errorMessage } from "@/lib/api-client";
import { useResource } from "./use-resource";
import { Button, useT } from "./shared";
export function DeliveryStatus() {
  const t = useT();
  const resource = useResource<{
    items: Array<{
      channel: "Email" | "Webhook";
      state: string;
      count: number;
    }>;
  }>("/api/v1/admin/delivery", 30000);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  async function retry(channel: "Email" | "Webhook") {
    setBusy(true);
    try {
      await apiFetch("/api/v1/admin/delivery", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channel }),
      });
      setMessage(t("Failed deliveries queued for retry."));
      resource.retry();
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <article className="settings-card" data-tour="settings-delivery">
      <h3>{t("Background delivery")}</h3>
      <p>
        {t(
          "Failed deliveries stay visible until an administrator retries them. The scheduled worker performs delivery.",
        )}
      </p>
      {resource.error && (
        <p role="alert">
          {t(resource.error)}{" "}
          <button onClick={resource.retry}>{t("Retry")}</button>
        </p>
      )}
      {!resource.data && !resource.error && (
        <p role="status">{t("Loading…")}</p>
      )}
      {resource.data?.items.length === 0 && (
        <p>{t("No pending or failed deliveries.")}</p>
      )}
      {resource.data?.items.map((item) => (
        <div key={item.channel + item.state}>
          <span>
            {t(item.channel)} · {t(item.state)}: {item.count}
          </span>
          {item.state === "Dead letter" && (
            <Button disabled={busy} onClick={() => void retry(item.channel)}>
              {t("Retry failed deliveries")}
            </Button>
          )}
        </div>
      ))}
      {message && <p role="status">{t(message)}</p>}
    </article>
  );
}
