"use client";

import { useState } from "react";

import { useResource } from "./use-resource";
import ReactMarkdown from "react-markdown";

import {
  useT,
  mutationHeaders,
  type Idea,
  type RequestItem,
  type RequestAttachment,
  type RequestComment,
  type RequestHistoryItem,
  Icon,
  Status,
  Button,
  Drawer,
} from "./shared";

export function RequestDrawer({
  request,
  idea,
  onClose,
  onToast,
  onChange,
}: {
  request: RequestItem;
  idea?: Idea;
  onClose: () => void;
  onToast: (message: string) => void;
  onChange: (request: RequestItem) => void;
}) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(request.title);
  const [editProblem, setEditProblem] = useState(request.problem);
  const [editError, setEditError] = useState("");
  const [editVersion, setEditVersion] = useState(request.version);
  const [reply, setReply] = useState("");
  const [localComments, setComments] = useState<RequestComment[] | null>(null);

  const [commentFiles, setCommentFiles] = useState<File[]>([]);
  const attachmentResource = useResource<{ items: RequestAttachment[] }>(
    `/api/v1/requests/${request.id}/attachments`,
    5000,
  );
  const commentResource = useResource<{ items: RequestComment[] }>(
    `/api/v1/requests/${request.id}/comments`,
  );
  const historyResource = useResource<{ history: RequestHistoryItem[] }>(
    `/api/v1/requests/${request.id}`,
  );

  const attachments = attachmentResource.data?.items || [];
  const comments = localComments || commentResource.data?.items || [];
  const history = historyResource.data?.history || [];

  async function sendReply() {
    const attachmentIds: string[] = [];
    for (const file of commentFiles) {
      const init = await fetch(`/api/v1/requests/${request.id}/attachments`, {
        method: "POST",
        headers: mutationHeaders(),
        body: JSON.stringify({
          fileName: file.name,
          contentType: file.type || "application/octet-stream",
          sizeBytes: file.size,
        }),
      });
      const target = await init.json();
      if (!init.ok) {
        onToast(target?.error?.message || `Could not prepare ${file.name}.`);
        return;
      }
      const upload = await fetch(target.uploadUrl, {
        method: "PUT",
        headers: {
          "content-type": file.type || "application/octet-stream",
          ...(target.uploadUrl.startsWith("http")
            ? { "x-ms-blob-type": "BlockBlob" }
            : {}),
        },
        body: file,
      });
      if (!upload.ok) {
        onToast(`Could not upload ${file.name}.`);
        return;
      }
      if (target.uploadUrl.startsWith("http"))
        await fetch(`/api/v1/attachments/${target.attachment.id}/complete`, {
          method: "POST",
        });
      attachmentIds.push(target.attachment.id);
    }
    const response = await fetch(`/api/v1/requests/${request.id}/comments`, {
      method: "POST",
      headers: mutationHeaders(),
      body: JSON.stringify({
        body: reply,
        visibility: "Customer",
        attachmentIds,
      }),
    });
    if (!response.ok) {
      onToast("Your response could not be saved.");
      return;
    }
    const data = await response.json();
    setComments((items) => [
      ...(items || comments),
      { ...data.item, canEdit: true },
    ]);
    setReply("");
    setCommentFiles([]);
    onToast("Your response was added to the request.");
  }
  async function editReply(comment: RequestComment) {
    const body = window.prompt("Edit comment", comment.body)?.trim();
    if (!body || body === comment.body) return;
    const response = await fetch(
      `/api/v1/requests/${request.id}/comments/${comment.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body }),
      },
    );
    if (!response.ok) {
      onToast("The comment could not be edited.");
      return;
    }
    setComments((items) =>
      (items || comments).map((item) =>
        item.id === comment.id
          ? { ...item, body, editedAt: new Date().toISOString() }
          : item,
      ),
    );
    onToast("Comment updated. The previous version is preserved.");
  }
  async function removeReply(comment: RequestComment) {
    if (
      !window.confirm("Remove this comment? Its audit tombstone will remain.")
    )
      return;
    const response = await fetch(
      `/api/v1/requests/${request.id}/comments/${comment.id}`,
      {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "Removed by author" }),
      },
    );
    if (!response.ok) {
      onToast("The comment could not be removed.");
      return;
    }
    setComments((items) =>
      (items || comments).map((item) =>
        item.id === comment.id
          ? {
              ...item,
              body: "[Comment removed]",
              removed: true,
              canEdit: false,
            }
          : item,
      ),
    );
  }
  async function editRequestDetails() {
    const title = editTitle.trim();
    const problem = editProblem.trim();
    if (!title || !problem) return;
    const response = await fetch(`/api/v1/requests/${request.id}`, {
      method: "PATCH",
      headers: mutationHeaders(true, editVersion),
      body: JSON.stringify({ title, problem }),
    });
    const data = await response.json();
    if (!response.ok) {
      setEditError(data?.error?.message || "The request could not be edited.");
      return;
    }
    onChange({ ...request, ...data.item });
    setEditVersion(data.item.version);
    setEditing(false);
    setEditError("");
    onToast("Request updated. The previous revision is preserved.");
  }
  async function withdrawRequest() {
    if (
      !window.confirm("Withdraw this request? Its audit history will remain.")
    )
      return;
    const response = await fetch(`/api/v1/requests/${request.id}`, {
      method: "PATCH",
      headers: mutationHeaders(true, request.version),
      body: JSON.stringify({ status: "Withdrawn" }),
    });
    const data = await response.json();
    if (!response.ok) {
      onToast(data?.error?.message || "The request could not be withdrawn.");
      return;
    }
    onChange({ ...request, status: "Withdrawn", tone: "neutral" });
    onToast("Request withdrawn. Its history remains available.");
  }
  return (
    <Drawer onClose={onClose}>
      {[attachmentResource, commentResource, historyResource].map(
        (resource, index) =>
          resource.error && (
            <div key={index} role="alert">
              {t(resource.error)}{" "}
              <button onClick={resource.retry}>{t("Retry")}</button>
            </div>
          ),
      )}
      <header className="drawer-head">
        <div>
          <code>{request.id}</code>
          <h2>{request.title}</h2>
          <Status tone={request.tone}>{request.status}</Status>
        </div>
        <button className="icon-button" onClick={onClose}>
          <Icon name="x" />
        </button>
      </header>
      <div className="drawer-content">
        <section className="drawer-summary">
          <div>
            <span>{t("Product area")}</span>
            <strong>{request.area}</strong>
          </div>
          <div>
            <span>{t("Business impact")}</span>
            <strong>{request.impact}</strong>
          </div>
          <div>
            <span>{t("Submitted")}</span>
            <code>{request.submitted}</code>
          </div>
          <div>
            <span>{t("Internal owner")}</span>
            <strong>{request.owner}</strong>
          </div>
        </section>
        {request.status === "Needs information" && (
          <section className="action-callout">
            <Icon name="message" size={19} />
            <div>
              <strong>{t("DataCentral needs more context")}</strong>
              <p>
                {t(
                  "Review the comments below and add the requested information.",
                )}
              </p>
            </div>
          </section>
        )}
        {editing && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void editRequestDetails();
            }}
          >
            <label className="form-field">
              <span>{t("Short title")}</span>
              <input
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                maxLength={140}
                required
              />
            </label>
            <label className="form-field">
              <span>{t("Problem or desired outcome")}</span>
              <textarea
                value={editProblem}
                onChange={(e) => setEditProblem(e.target.value)}
                maxLength={5000}
                required
              />
            </label>
            {editError && <p role="alert">{t(editError)}</p>}
            <Button type="submit">{t("Save changes")}</Button>
            {editError && (
              <Button
                onClick={() => {
                  void fetch(`/api/v1/requests/${request.id}`)
                    .then((r) => (r.ok ? r.json() : Promise.reject()))
                    .then((data) => {
                      onChange(data.item);
                      setEditVersion(data.item.version);
                      setEditError("");
                    })
                    .catch(() =>
                      setEditError("Unable to load requests. Please retry."),
                    );
                }}
              >
                {t("Reload latest version")}
              </Button>
            )}
          </form>
        )}
        <section className="drawer-section">
          <p className="field-label">{t("Original customer need")}</p>
          <p>{request.problem}</p>
          {["Submitted", "Needs information"].includes(request.status) && (
            <div className="request-edit-actions">
              <Button
                variant="secondary"
                onClick={() => {
                  setEditing(true);
                  setEditVersion(request.version);
                }}
              >
                {t("Edit request")}
              </Button>
              <Button variant="ghost" onClick={withdrawRequest}>
                {t("Withdraw")}
              </Button>
            </div>
          )}
        </section>
        {attachments.length > 0 && (
          <section className="drawer-section">
            <p className="field-label">{t("Attachments")}</p>
            <div className="attachment-list">
              {attachments.map((attachment) => (
                <a
                  key={attachment.id}
                  href={
                    attachment.scanState === "Clean"
                      ? `/api/v1/attachments/${attachment.id}/content`
                      : undefined
                  }
                  aria-disabled={attachment.scanState !== "Clean"}
                >
                  <span>
                    <strong>{attachment.fileName}</strong>
                    <small>
                      {(attachment.sizeBytes / 1024 / 1024).toFixed(1)}{" "}
                      {t("MB ·")} {t(attachment.scanState)}
                    </small>
                  </span>
                  <Status
                    tone={
                      attachment.scanState === "Clean" ? "success" : "warning"
                    }
                  >
                    {t(attachment.scanState)}
                  </Status>
                </a>
              ))}
            </div>
          </section>
        )}
        {idea && (
          <section className="linked-idea">
            <p className="field-label">{t("Linked product idea")}</p>
            <div>
              <span>
                <Status tone={idea.tone}>{idea.status}</Status>
                <code>{idea.id}</code>
              </span>
              <strong>{idea.title}</strong>
              <p>{idea.description}</p>
            </div>
          </section>
        )}
        {comments.length > 0 && (
          <section className="drawer-section">
            <p className="field-label">{t("Discussion")}</p>
            <div className="comment-list">
              {comments.map((comment) => (
                <article key={comment.id}>
                  <header>
                    <strong>{comment.author}</strong>
                    <code>{new Date(comment.createdAt).toLocaleString()}</code>
                  </header>
                  <div className="comment-markdown">
                    <ReactMarkdown
                      skipHtml
                      components={{
                        a: ({ href, children }) => (
                          <a
                            href={href}
                            target="_blank"
                            rel="noreferrer noopener"
                          >
                            {children}
                          </a>
                        ),
                      }}
                    >
                      {comment.body}
                    </ReactMarkdown>
                  </div>
                  {comment.editedAt && !comment.removed && (
                    <small>{t("Edited")}</small>
                  )}
                  {comment.attachments && comment.attachments.length > 0 && (
                    <div className="comment-attachments">
                      {comment.attachments.map((attachment) => (
                        <a
                          key={attachment.id}
                          href={
                            attachment.scanState === "Clean"
                              ? `/api/v1/attachments/${attachment.id}/content`
                              : undefined
                          }
                          aria-disabled={attachment.scanState !== "Clean"}
                        >
                          {attachment.fileName} · {t(attachment.scanState)}
                        </a>
                      ))}
                    </div>
                  )}
                  {comment.canEdit && !comment.removed && (
                    <div className="comment-actions">
                      <button onClick={() => editReply(comment)}>
                        {t("Edit")}
                      </button>
                      <button onClick={() => removeReply(comment)}>
                        {t("Remove")}
                      </button>
                    </div>
                  )}
                </article>
              ))}
            </div>
          </section>
        )}
        <section className="drawer-section">
          <p className="field-label">{t("History")}</p>
          <div className="history">
            {(history.length
              ? history
              : [
                  {
                    id: "submitted",
                    action: "request.created",
                    actor: "Requester",
                    createdAt: request.submitted,
                  },
                ]
            ).map((entry) => (
              <div key={entry.id}>
                <span />
                <div>
                  <strong>
                    {entry.after?.status ||
                      entry.action
                        .replaceAll(".", " ")
                        .replace(/\b\w/g, (letter) => letter.toUpperCase())}
                  </strong>
                  <p>{entry.actor ? `By ${entry.actor}` : "System event"}</p>
                  <code>
                    {Number.isNaN(new Date(entry.createdAt).getTime())
                      ? entry.createdAt.toUpperCase()
                      : new Date(entry.createdAt).toLocaleString()}
                  </code>
                </div>
              </div>
            ))}
          </div>
        </section>
        <section className="reply-box">
          <label htmlFor="reply">{t("Add context")}</label>
          <textarea
            id="reply"
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            placeholder={t("Reply to DataCentral or add relevant information")}
          />
          <label className="comment-file-picker">
            <Icon name="plus" size={14} />
            {t("Attach files")}
            <input
              type="file"
              multiple
              accept="image/*,.pdf,.txt,.csv,.zip,.docx,.xlsx,.pptx"
              onChange={(event) =>
                setCommentFiles(
                  Array.from(event.target.files || [])
                    .filter((file) => file.size <= 25 * 1024 * 1024)
                    .slice(0, 5),
                )
              }
            />
          </label>
          {commentFiles.length > 0 && (
            <div className="comment-file-list">
              {commentFiles.map((file) => (
                <span key={`${file.name}-${file.lastModified}`}>
                  {file.name}
                </span>
              ))}
            </div>
          )}
          <div>
            <span>{t("Visible to your organization and DataCentral")}</span>
            <Button icon="send" disabled={!reply.trim()} onClick={sendReply}>
              {t("Send response")}
            </Button>
          </div>
        </section>
      </div>
    </Drawer>
  );
}

export function IdeaDrawer({
  idea,
  onClose,
  onFollow,
}: {
  idea: Idea;
  onClose: () => void;
  onFollow: (id: string) => void;
}) {
  const t = useT();
  return (
    <Drawer onClose={onClose}>
      <header className="drawer-head">
        <div>
          <code>{idea.id}</code>
          <h2>{idea.title}</h2>
          <Status tone={idea.tone}>{idea.status}</Status>
        </div>
        <button className="icon-button" onClick={onClose}>
          <Icon name="x" />
        </button>
      </header>
      <div className="drawer-content">
        <section className="idea-highlight">
          <p className="eyebrow">{t("Product direction")}</p>
          <h3>
            {idea.horizon === "Released"
              ? "Available now"
              : `${idea.horizon} horizon`}
          </h3>
          <p>{idea.description}</p>
        </section>
        <section className="drawer-summary">
          <div>
            <span>{t("Product area")}</span>
            <strong>{idea.area}</strong>
          </div>
          <div>
            <span>{t("Organizations")}</span>
            <strong>{idea.organizations}</strong>
          </div>
          <div>
            <span>{t("Followers")}</span>
            <strong>{idea.followers}</strong>
          </div>
          <div>
            <span>{t("Last update")}</span>
            <strong>{idea.updated.replace("Updated ", "")}</strong>
          </div>
        </section>
        <section className="drawer-section">
          <p className="field-label">{t("Latest update")}</p>
          <h3>
            {idea.status === "Released"
              ? "Released to eligible tenants"
              : `${idea.status}: scope is being refined`}
          </h3>
          <p>
            {idea.status === "In progress"
              ? "Delivery has started. The initial scope is focused on the highest-value customer workflow and governed administration."
              : idea.status === "Planned"
                ? "The capability has been approved for delivery. Detailed sequencing remains subject to technical dependencies and customer evidence."
                : "The product team is reviewing customer evidence, constraints, and the most appropriate implementation."}
          </p>
          <code>{idea.updated}</code>
        </section>
        <section className="organization-evidence">
          <Icon name="building" size={18} />
          <div>
            <strong>
              {t("Demand across")}
              {idea.organizations} {t("organizations")}
            </strong>
            <span>
              {t("Customer identities and raw request context remain private.")}
            </span>
          </div>
        </section>
      </div>
      <footer className="drawer-footer">
        <Button variant="secondary" onClick={onClose}>
          {t("Close")}
        </Button>
        <Button
          icon={idea.followed ? "check" : "bell"}
          onClick={() => onFollow(idea.id)}
        >
          {idea.followed ? "Following" : "Follow idea"}
        </Button>
      </footer>
    </Drawer>
  );
}
