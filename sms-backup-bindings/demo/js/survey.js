/* Demo feedback survey: floating draggable entry + form overlay.
 * No storage of any kind (closed state lives in memory only, so a page reload
 * — Home / Recents nav keys — brings the entry back). No timing or behaviour tracking. */
(function () {
  "use strict";
  /* Planned Worker custom domain (luminaera-feedback-worker/设计-2026-10-13.md).
   * Live; allowed Origins: https://luminaera.tech, http://127.0.0.1, http://localhost (no ports). */
  const FEEDBACK_ENDPOINT = "https://feedback.luminaera.tech/v1/feedback";
  const FEEDBACK_DELETE_EMAIL = "luminaera@agentmail.to";
  const MAX = { text: 1000, email: 200, country: 80, locale: 35 };
  const DRAG_PX = 6;
  const I = window.DemoI18n;
  const t = (k, v) => I.t(k, v);
  let rating = 0;
  let sending = false;

  const fab = document.createElement("div");
  fab.className = "fb-fab";
  fab.innerHTML = '<button type="button" class="fb-fab-open" id="fb-open"></button>' +
    '<button type="button" class="fb-fab-x" id="fb-hide">×</button>';
  const overlay = document.createElement("div");
  overlay.className = "fb-overlay hidden";
  overlay.innerHTML = `
    <form class="fb-card" id="fb-form" role="dialog" aria-modal="true" aria-labelledby="fb-title" novalidate>
      <h2 id="fb-title"></h2>
      <span class="field-label" id="fb-rating-label"></span>
      <div class="fb-stars" id="fb-stars" role="radiogroup" aria-labelledby="fb-rating-label">
        ${[1, 2, 3, 4, 5].map((n) => `<button type="button" class="fb-star" role="radio" aria-checked="false" data-n="${n}">★</button>`).join("")}
      </div>
      <label class="field-label" for="fb-pain" id="fb-pain-l"></label>
      <textarea class="search fb-text" id="fb-pain" rows="3" maxlength="${MAX.text}"></textarea>
      <label class="field-label" for="fb-helpful" id="fb-helpful-l"></label>
      <textarea class="search fb-text" id="fb-helpful" rows="3" maxlength="${MAX.text}"></textarea>
      <label class="field-label" for="fb-nopay" id="fb-nopay-l"></label>
      <textarea class="search fb-text" id="fb-nopay" rows="3" maxlength="${MAX.text}"></textarea>
      <label class="field-label" for="fb-email" id="fb-email-l"></label>
      <input class="search" id="fb-email" type="email" maxlength="${MAX.email}" autocomplete="email" />
      <label class="field-label" for="fb-country" id="fb-country-l"></label>
      <input class="search" id="fb-country" type="text" maxlength="${MAX.country}" autocomplete="country-name" />
      <div class="fb-hp" aria-hidden="true"><input type="text" name="company_website" id="fb-hp" tabindex="-1" autocomplete="off" data-lpignore="true" data-1p-ignore /></div>
      <p class="err hidden" id="fb-msg" role="status" aria-live="polite"></p>
      <div class="fb-foot">
        <p class="fb-notice muted" id="fb-notice"></p>
        <p class="fb-notice muted" id="fb-delete"></p>
        <div class="modal-actions">
          <button type="button" class="link" id="fb-cancel"></button>
          <button type="submit" class="btn btn-primary" id="fb-submit"></button>
        </div>
      </div>
    </form>`;
  document.body.appendChild(fab);
  document.body.appendChild(overlay);
  const $ = (id) => document.getElementById(id);

  function relabel() {
    $("fb-open").textContent = t("fb_entry");
    $("fb-hide").setAttribute("aria-label", t("fb_entry_close"));
    $("fb-hide").title = t("fb_entry_close");
    $("fb-title").textContent = t("fb_title");
    $("fb-rating-label").textContent = t("fb_rating");
    overlay.querySelectorAll(".fb-star").forEach((b) => b.setAttribute("aria-label", t("fb_star", { n: b.dataset.n })));
    $("fb-pain-l").textContent = t("fb_q_pain");
    $("fb-helpful-l").textContent = t("fb_q_helpful");
    $("fb-nopay-l").textContent = t("fb_q_nopay");
    $("fb-email-l").textContent = t("fb_email");
    $("fb-country-l").textContent = t("fb_country");
    $("fb-notice").textContent = t("fb_notice");
    fillDelete($("fb-delete"));
    $("fb-cancel").textContent = t("fb_cancel");
    $("fb-submit").textContent = sending ? t("fb_sending") : t("fb_submit");
  }

  /* Text nodes + one <a>; no innerHTML with string content. */
  function fillDelete(el) {
    const parts = String(t("fb_delete")).split("{email}");
    el.textContent = "";
    parts.forEach((part, i) => {
      if (i > 0) {
        const a = document.createElement("a");
        a.className = "link";
        a.href = "mailto:" + FEEDBACK_DELETE_EMAIL;
        a.textContent = FEEDBACK_DELETE_EMAIL;
        el.appendChild(a);
      }
      el.appendChild(document.createTextNode(part));
    });
  }

  function paintStars() {
    overlay.querySelectorAll(".fb-star").forEach((b) => {
      const on = Number(b.dataset.n) <= rating;
      b.classList.toggle("on", on);
      b.setAttribute("aria-checked", String(Number(b.dataset.n) === rating));
    });
  }
  function msg(text) {
    const m = $("fb-msg");
    m.textContent = text || "";
    m.classList.toggle("hidden", !text);
  }
  function open() { relabel(); msg(""); overlay.classList.remove("hidden"); }
  function close() { overlay.classList.add("hidden"); }
  function reset() {
    rating = 0; paintStars();
    ["fb-pain", "fb-helpful", "fb-nopay", "fb-email", "fb-country", "fb-hp"].forEach((id) => { $(id).value = ""; });
  }

  overlay.querySelectorAll(".fb-star").forEach((b) => {
    b.onclick = () => { rating = Number(b.dataset.n); paintStars(); msg(""); };
  });
  $("fb-cancel").onclick = close;
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !overlay.classList.contains("hidden")) close(); });

  $("fb-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (sending) return;
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) { msg(t("fb_need_rating")); return; }
    const val = (id, max) => $(id).value.trim().slice(0, max);
    const body = {
      rating,
      pain: val("fb-pain", MAX.text),
      helpful: val("fb-helpful", MAX.text),
      no_pay: val("fb-nopay", MAX.text),
      email: val("fb-email", MAX.email),
      country: val("fb-country", MAX.country),
      page_path: location.pathname,
      locale: String(I.getLocale() || "").slice(0, MAX.locale),
      company_website: $("fb-hp").value,
    };
    sending = true; relabel(); $("fb-submit").disabled = true;
    try {
      const res = await fetch(FEEDBACK_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        credentials: "omit",
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      reset(); close();
      const toast = document.getElementById("toast");
      if (toast) { toast.textContent = t("fb_ok"); toast.classList.add("show"); setTimeout(() => toast.classList.remove("show"), 2400); }
    } catch {
      msg(t("fb_err"));
    } finally {
      sending = false; $("fb-submit").disabled = false; relabel();
    }
  });

  /* —— Draggable entry (mouse + touch via Pointer Events), clamped to viewport —— */
  let drag = null;
  let moved = false;
  function clamp(x, y) {
    const r = fab.getBoundingClientRect();
    const maxX = Math.max(0, window.innerWidth - r.width);
    const maxY = Math.max(0, window.innerHeight - r.height);
    return [Math.min(Math.max(0, x), maxX), Math.min(Math.max(0, y), maxY)];
  }
  function place(x, y) {
    const [cx, cy] = clamp(x, y);
    fab.style.left = cx + "px"; fab.style.top = cy + "px";
    fab.style.right = "auto"; fab.style.bottom = "auto";
  }
  const openBtn = $("fb-open");
  openBtn.addEventListener("pointerdown", (e) => {
    if (e.button != null && e.button !== 0) return;
    const r = fab.getBoundingClientRect();
    drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ox: r.left, oy: r.top };
    moved = false;
    openBtn.setPointerCapture(e.pointerId);
  });
  openBtn.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
    if (!moved && Math.hypot(dx, dy) < DRAG_PX) return;
    moved = true;
    fab.classList.add("dragging");
    place(drag.ox + dx, drag.oy + dy);
  });
  const endDrag = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag = null;
    fab.classList.remove("dragging");
  };
  openBtn.addEventListener("pointerup", endDrag);
  openBtn.addEventListener("pointercancel", endDrag);
  openBtn.addEventListener("click", (e) => {
    if (moved) { moved = false; e.preventDefault(); return; }
    open();
  });
  $("fb-hide").addEventListener("click", (e) => { e.stopPropagation(); fab.classList.add("hidden"); close(); });
  window.addEventListener("resize", () => {
    if (!fab.style.left) return;
    const r = fab.getBoundingClientRect();
    place(r.left, r.top);
  });

  function show() { fab.classList.remove("hidden"); }
  relabel();
  window.DemoSurvey = { relabel, show };
})();
