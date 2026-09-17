"use client";

import { useT, type NotificationItem, Icon } from "./shared";

export function NotificationsPopover({
  items,
  onRead,
  onOpenUpdates,
}: {
  items: NotificationItem[];
  onRead: (id: string) => void;
  onOpenUpdates: () => void;
}) {
  const t = useT();
  return (
    <div className="notification-popover">
      <header>
        <strong>{t("Updates")}</strong>
        <button onClick={onOpenUpdates}>{t("View all")}</button>
      </header>
      {items.length === 0 ? (
        <div className="notification-empty">
          {t("No unread product updates.")}
        </div>
      ) : (
        items.slice(0, 5).map((item) => (
          <button
            key={item.id}
            onClick={() => onRead(item.id)}
            className={item.readAt ? "read" : ""}
          >
            <span
              className={`mini-icon ${item.eventType.includes("release") ? "success" : item.eventType.includes("needs") ? "warning" : "violet"}`}
            >
              <Icon
                name={
                  item.eventType.includes("release")
                    ? "check"
                    : item.eventType.includes("needs")
                      ? "message"
                      : "spark"
                }
                size={14}
              />
            </span>
            <span>
              <strong>
                {item.eventType
                  .replaceAll(".", " ")
                  .replace(/\b\w/g, (letter) => letter.toUpperCase())}
              </strong>
              <small>{new Date(item.createdAt).toLocaleString()}</small>
            </span>
          </button>
        ))
      )}
    </div>
  );
}
