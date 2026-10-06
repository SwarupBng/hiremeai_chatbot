(() => {
  "use strict";

  const MAX_CHARS = 500;          // keep in sync with MAX_QUESTION_CHARS in backend/main.py
  const HISTORY_LIMIT = 10;       // messages sent along for follow-up questions
  const SLOW_AFTER_MS = 6000;     // show the "server is waking up" note after this long
  const TIMEOUT_MS = 90000;       // give up on a request after this long

  // ---------------------------------------------------------------- config
  const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]", ""];
  const API_BASE = (LOCAL_HOSTS.includes(location.hostname)
    ? "http://localhost:8000"
    : window.HIREME_API_URL || ""
  ).replace(/\/+$/, "");
  const API_CONFIGURED = API_BASE !== "" && !API_BASE.includes("YOUR-BACKEND");

  // ---------------------------------------------------------------- elements
  const app = document.getElementById("app");
  const scroller = document.getElementById("scroll");
  const log = document.getElementById("log");
  const form = document.getElementById("form");
  const input = document.getElementById("input");
  const sendBtn = document.getElementById("send");
  const starters = document.getElementById("starters");
  const clearBtn = document.getElementById("clearBtn");
  const statusText = document.getElementById("statusText");
  const count = document.getElementById("count");

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const finePointer = window.matchMedia("(pointer: fine)");

  // ---------------------------------------------------------------- state
  let history = [];   // completed exchanges: [{role, content}, ...]
  let busy = false;
  let session = 0;    // bumped by "Clear chat" so late replies are ignored

  class ApiError extends Error {
    constructor(message, status) {
      super(message);
      this.status = status;
    }
  }

  // ---------------------------------------------------------------- rendering
  function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  // Inline formatting: `code`, **bold**, *italic*, links and email addresses.
  // Everything is HTML-escaped first, so model output can never inject markup.
  function inlineMd(raw) {
    return raw
      .split(/(`[^`\n]+`)/g)
      .map((part, i) => {
        if (i % 2 === 1) return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
        let s = escapeHtml(part);
        s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
        s = s.replace(/(^|[\s(])\*([^*\s][^*\n]*?)\*(?=$|[\s).,;:!?])/g, "$1<em>$2</em>");
        s = s.replace(
          /(https?:\/\/[^\s<>"']+)|([\w.+-]+@[\w-]+(?:\.[\w-]+)+)/g,
          (match, url, email) => {
            if (email) return `<a href="mailto:${email}">${email}</a>`;
            const clean = url.replace(/[.,;:!?)]+$/, "");
            const tail = url.slice(clean.length);
            return `<a href="${clean}" target="_blank" rel="noopener noreferrer">${clean}</a>${tail}`;
          }
        );
        return s;
      })
      .join("");
  }

  // Block formatting: paragraphs, bullet lists and numbered lists.
  function renderMarkdown(text) {
    const out = [];
    let para = [];
    let list = null;

    const flushPara = () => {
      if (para.length) out.push(`<p>${para.map(inlineMd).join("<br>")}</p>`);
      para = [];
    };
    const flushList = () => {
      if (list) {
        out.push(`<${list.tag}>${list.items.map((t) => `<li>${inlineMd(t)}</li>`).join("")}</${list.tag}>`);
      }
      list = null;
    };

    for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
      const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
      const number = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (bullet || number) {
        flushPara();
        const tag = bullet ? "ul" : "ol";
        if (list && list.tag !== tag) flushList();
        if (!list) list = { tag, items: [] };
        list.items.push((bullet || number)[1]);
      } else if (!line.trim()) {
        flushPara();
        flushList();
      } else {
        flushList();
        para.push(line.replace(/^#{1,6}\s+/, "").trim());
      }
    }
    flushPara();
    flushList();
    return out.join("");
  }

  function makeMessage(kind) {
    const el = document.createElement("div");
    el.className = `msg msg-${kind}`;
    const body = document.createElement("div");
    body.className = "body";
    el.appendChild(body);
    log.appendChild(el);
    return { el, body };
  }

  function addUserMessage(text) {
    const m = makeMessage("user");
    m.body.textContent = text;
    scrollToEnd();
  }

  function addBotMessage(text) {
    const m = makeMessage("bot");
    m.body.innerHTML = renderMarkdown(text);
    // Long answers: show the start. Short answers: show the end.
    if (m.el.offsetHeight > scroller.clientHeight * 0.8) {
      m.el.scrollIntoView({ block: "start", behavior: reducedMotion.matches ? "auto" : "smooth" });
    } else {
      scrollToEnd();
    }
  }

  function addPending() {
    const m = makeMessage("pending");
    m.el.setAttribute("role", "status");
    const led = document.createElement("span");
    led.className = "led";
    led.setAttribute("aria-hidden", "true");
    const label = document.createElement("span");
    label.textContent = "Checking the CV…";
    m.body.append(led, label);
    scrollToEnd();
    return {
      remove: () => m.el.remove(),
      setSlow: () => {
        label.textContent =
          "The server was idle and is starting up. The first answer can take up to a minute.";
      },
    };
  }

  function addError(message, question) {
    const m = makeMessage("error");
    m.el.setAttribute("role", "alert");
    const text = document.createElement("div");
    text.textContent = message;
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "retry";
    retry.textContent = "Retry";
    retry.addEventListener("click", () => {
      m.el.remove();
      ask(question, { retry: true });
    });
    m.body.append(text, retry);
    scrollToEnd();
    retry.focus({ preventScroll: true });
  }

  function scrollToEnd() {
    scroller.scrollTo({
      top: scroller.scrollHeight,
      behavior: reducedMotion.matches ? "auto" : "smooth",
    });
  }

  // ---------------------------------------------------------------- network
  function detailFor(status, data) {
    if (data && typeof data.detail === "string") return data.detail;
    if (status === 422) return `That message couldn't be sent. Keep it under ${MAX_CHARS} characters.`;
    if (status === 404) return "The chat endpoint wasn't found. Check the API address in config.js.";
    return `The server returned an error (${status}). Retry in a moment.`;
  }

  async function requestAnswer(question) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(`${API_BASE}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, history: history.slice(-HISTORY_LIMIT) }),
        signal: controller.signal,
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new ApiError(detailFor(res.status, data), res.status);
      if (!data || typeof data.answer !== "string") {
        throw new ApiError("The server sent an unexpected reply. Retry in a moment.", res.status);
      }
      return data.answer;
    } finally {
      clearTimeout(timer);
    }
  }

  function errorText(err) {
    if (err instanceof ApiError) return err.message;
    if (err && err.name === "AbortError") return "The server took too long to answer. Retry in a moment.";
    console.error(err);
    return "Couldn't reach the server. Check your connection and retry.";
  }

  // ---------------------------------------------------------------- flow
  function setBusy(value) {
    busy = value;
    app.classList.toggle("busy", value);
    statusText.textContent = value ? "Answering" : "Ready";
    updateSendState();
  }

  function updateSendState() {
    sendBtn.disabled = busy || input.value.trim() === "";
  }

  async function ask(question, { retry = false } = {}) {
    if (busy) return;

    starters.hidden = true;
    clearBtn.hidden = false;
    if (!retry) addUserMessage(question);

    if (!API_CONFIGURED) {
      addError(
        "This page isn't connected to its server yet. Set the API address in config.js.",
        question
      );
      return;
    }

    const mySession = session;
    setBusy(true);
    const pending = addPending();
    const slowTimer = setTimeout(pending.setSlow, SLOW_AFTER_MS);

    try {
      const answer = await requestAnswer(question);
      if (mySession !== session) return;
      pending.remove();
      history.push({ role: "user", content: question }, { role: "assistant", content: answer });
      addBotMessage(answer);
    } catch (err) {
      if (mySession !== session) return;
      pending.remove();
      addError(errorText(err), question);
    } finally {
      clearTimeout(slowTimer);
      if (mySession === session) {
        setBusy(false);
        if (finePointer.matches) input.focus({ preventScroll: true });
      }
    }
  }

  function submitInput() {
    const question = input.value.trim();
    if (!question || busy) return;
    input.value = "";
    autosize();
    updateSendState();
    ask(question);
  }

  function clearChat() {
    session += 1;
    history = [];
    log.replaceChildren();
    setBusy(false);
    starters.hidden = false;
    clearBtn.hidden = true;
    scroller.scrollTo({ top: 0 });
    input.focus({ preventScroll: true });
  }

  // ---------------------------------------------------------------- input
  function autosize() {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 144)}px`;
    const len = input.value.length;
    count.hidden = len < MAX_CHARS - 100;
    count.textContent = `${len}/${MAX_CHARS}`;
  }

  input.addEventListener("input", () => {
    autosize();
    updateSendState();
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submitInput();
    }
  });

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    submitInput();
  });

  starters.addEventListener("click", (e) => {
    const btn = e.target.closest(".starter");
    if (btn) ask(btn.textContent.trim());
  });

  clearBtn.addEventListener("click", clearChat);

  updateSendState();
})();
