"use client";

// Self-contained floating assistant launcher + panel. Deliberately does not
// import anything from page.tsx (own inline glyph icons, own styling hooks
// via the .chat-* classes in globals.css) so it can be reasoned about and
// tested in isolation from the 6000+ line AppShell component.

import {
  ChangeEvent,
  JSX,
  KeyboardEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import ReactMarkdown from "react-markdown";

type ChatRole = "user" | "assistant";

type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
};

type ChatHistoryResponse = {
  configured?: boolean;
  messages?: Array<{ id: string; role: ChatRole; content: string }>;
};

const EXAMPLE_PROMPTS = [
  "Submit a request: exports to Excel time out for large orders",
  "Sýndu mér hugmyndirnar sem ég fylgist með",
];

function friendlyErrorText(locale: string): string {
  return locale === "is"
    ? "Því miður tókst ekki að senda skilaboðin. Reyndu aftur síðar."
    : "Sorry, something went wrong sending that. Please try again.";
}

export function ChatPanel(props: {
  locale: string;
  onDataChanged: () => void;
}): JSX.Element {
  const { locale, onDataChanged } = props;
  const [open, setOpen] = useState(false);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  // Web Speech API support varies by browser. Computed lazily on first
  // render, which for this component only ever happens client-side (it is
  // mounted deep inside AppShell's post-`identityReady` tree), so `window`
  // is always available by then — no server/client markup mismatch.
  const [speechSupported] = useState<boolean>(
    () =>
      typeof window !== "undefined" &&
      !!(window.SpeechRecognition ?? window.webkitSpeechRecognition),
  );

  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const historyRequestedRef = useRef(false);

  // Stop any in-flight dictation if the panel unmounts (e.g. navigation away).
  useEffect(() => () => recognitionRef.current?.stop(), []);

  // Auto-scroll to the newest message only — NOT on every keystroke or busy
  // toggle, so typing doesn't fight the user's scroll position.
  useEffect(() => {
    const el = messagesRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  // Lazy-load history (and the `configured` flag) the first time the panel
  // is opened, not on mount. A ref (not state) guards against re-fetching so
  // this effect never needs to setState synchronously on entry.
  useEffect(() => {
    if (!open || historyRequestedRef.current) return;
    historyRequestedRef.current = true;
    fetch("/api/v1/chat/messages")
      .then((response) =>
        response.ok
          ? (response.json() as Promise<ChatHistoryResponse>)
          : Promise.reject(new Error("history load failed")),
      )
      .then((data) => {
        setConfigured(Boolean(data.configured));
        setMessages(
          (data.messages ?? []).map((message) => ({
            id: message.id,
            role: message.role,
            content: message.content,
          })),
        );
      })
      .catch(() => setConfigured(false));
  }, [open]);

  function resizeTextarea() {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }

  function handleInputChange(event: ChangeEvent<HTMLTextAreaElement>) {
    setInput(event.target.value);
    resizeTextarea();
  }

  async function sendText(rawText: string) {
    const text = rawText.trim();
    if (!text || busy) return;
    setInput("");
    resizeTextarea();
    setMessages((current) => [
      ...current,
      { id: crypto.randomUUID(), role: "user", content: text },
    ]);
    setBusy(true);
    try {
      const response = await fetch("/api/v1/chat/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!response.ok) throw new Error("send failed");
      const data = await response.json();
      setMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content: typeof data.reply === "string" ? data.reply : "",
        },
      ]);
      if (data.dataChanged) onDataChanged();
    } catch {
      // An assistant failure must never take down the page — surface a
      // friendly bubble instead of rethrowing.
      setMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content: friendlyErrorText(locale),
        },
      ]);
    } finally {
      setBusy(false);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    if (busy || configured !== true) return;
    if (!input.trim()) {
      // Empty-Enter while the assistant is waiting on a yes/no reply sends
      // a locale-appropriate confirmation instead of doing nothing.
      const last = messages[messages.length - 1];
      if (last && last.role === "assistant") {
        void sendText(locale === "is" ? "Já" : "Yes");
      }
      return;
    }
    void sendText(input);
  }

  async function submitTranscript(transcript: string) {
    try {
      const response = await fetch("/api/v1/chat/transcript", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ transcript }),
      });
      const data = response.ok ? await response.json() : null;
      const cleaned =
        data && typeof data.text === "string" ? data.text : transcript;
      if (cleaned.trim()) void sendText(cleaned);
    } catch {
      if (transcript.trim()) void sendText(transcript);
    }
  }

  function startListening() {
    if (busy || configured !== true || listening) return;
    const Ctor = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!Ctor) return;
    const recognition = new Ctor();
    recognition.lang = locale === "is" ? "is-IS" : "en-US";
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.onresult = (event) => {
      setListening(false);
      const transcript = event.results[0]?.[0]?.transcript ?? "";
      if (transcript.trim()) void submitTranscript(transcript);
    };
    recognition.onerror = () => setListening(false);
    recognition.onend = () => setListening(false);
    recognitionRef.current = recognition;
    setListening(true);
    recognition.start();
  }

  function stopListening() {
    recognitionRef.current?.stop();
    setListening(false);
  }

  function handleClear() {
    if (busy) return;
    const question =
      locale === "is"
        ? "Hreinsa alla spjallsöguna?"
        : "Clear the entire chat history?";
    if (!window.confirm(question)) return;
    fetch("/api/v1/chat/messages", { method: "DELETE" })
      .then((response) => {
        if (response.ok) setMessages([]);
      })
      .catch(() => {});
  }

  const inputDisabled = busy || configured !== true;

  return (
    <>
      <button
        type="button"
        className="chat-launcher no-print"
        aria-expanded={open}
        aria-label={open ? "Close assistant" : "Open assistant"}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? "✕" : "✦"}
      </button>
      {open && (
        <div
          className="chat-panel no-print"
          role="dialog"
          aria-label="Assistant"
        >
          <div className="chat-header">
            <h3>✦ Assistant</h3>
            <div>
              <button
                type="button"
                aria-label="Clear chat history"
                onClick={handleClear}
                disabled={busy || messages.length === 0}
              >
                🗑
              </button>
              <button
                type="button"
                aria-label="Close assistant"
                onClick={() => setOpen(false)}
              >
                ✕
              </button>
            </div>
          </div>
          <div className="chat-messages" ref={messagesRef}>
            {configured === false && (
              <div className="chat-notice">
                The assistant needs an API key. Ask an administrator to set
                ANTHROPIC_API_KEY.
              </div>
            )}
            {configured === true && messages.length === 0 && (
              <div className="chat-examples">
                {EXAMPLE_PROMPTS.map((prompt) => (
                  <button
                    key={prompt}
                    type="button"
                    onClick={() => void sendText(prompt)}
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            )}
            {messages.map((message) =>
              message.role === "user" ? (
                <div key={message.id} className="chat-bubble-user">
                  {message.content}
                </div>
              ) : (
                <div key={message.id} className="chat-bubble-assistant">
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
                    {message.content}
                  </ReactMarkdown>
                </div>
              ),
            )}
            {busy && (
              <div className="chat-bubble-assistant chat-bubble-busy">
                {locale === "is" ? "Í vinnslu…" : "Thinking…"}
              </div>
            )}
            {listening && (
              <div className="chat-bubble-assistant chat-bubble-busy">
                {locale === "is" ? "Hlusta…" : "Listening…"}
              </div>
            )}
          </div>
          <div className="chat-input-row">
            <textarea
              ref={textareaRef}
              rows={1}
              value={input}
              placeholder={
                configured === false
                  ? locale === "is"
                    ? "Aðstoðarmaður ekki tiltækur"
                    : "Assistant unavailable"
                  : locale === "is"
                    ? "Skrifaðu skilaboð…"
                    : "Ask the assistant…"
              }
              disabled={inputDisabled}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
            />
            {speechSupported && (
              <button
                type="button"
                className={`chat-mic ${listening ? "listening" : ""}`}
                aria-label={
                  listening
                    ? locale === "is"
                      ? "Stöðva upptöku"
                      : "Stop dictation"
                    : locale === "is"
                      ? "Hefja upptöku"
                      : "Start dictation"
                }
                disabled={inputDisabled}
                onClick={() =>
                  listening ? stopListening() : startListening()
                }
              >
                🎤
              </button>
            )}
            <button
              type="button"
              className="chat-send"
              aria-label={locale === "is" ? "Senda skilaboð" : "Send message"}
              disabled={inputDisabled || !input.trim()}
              onClick={() => void sendText(input)}
            >
              ➤
            </button>
          </div>
        </div>
      )}
    </>
  );
}
