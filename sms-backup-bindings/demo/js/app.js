/* Simulator-level demo shell — ledger aggregates + in-memory PIN/history edits */
(function () {
  const { t, setLocale, getLocale, getLocalePreference, localeLabels, PLAY, PLAY_LIVE } = window.DemoI18n;

  const INLINE_HISTORY_FALLBACK = []; /* field missing only */

  const state = {
    ledger: null,
    gated: false,
    pin: {
      value: null,
      unlocked: true,
      screen: null,
      input: "",
      newInput: "",
      error: null,
      tipIdx: 0,
    },
    screen: "home",
    stack: [],
    lineKey: null,
    folds: { detail: true, confirmed: true, unidentified: true },
    statusEditId: null,
    statusPick: null,
    reboundLineKey: null,
    msgFilter: { serviceId: null, q: "" },
    labelFlow: { unrecId: null, messageId: null, name: "", selected: {}, mode: "tap", tapStart: null, tapEnd: null, cellPx: 48, body: "" },
    reviewServiceId: null,
    reviewChecks: {},
    goneLabels: {},
    deletingServiceId: null,
    exportSelected: {},
    backupPathChecked: false,
    restorePathChecked: false,
    otpProtect: false,
    smsBrowse: "all",
    wideScan: false,
    addingService: false,
    explain: null,
    wizard: null, /* null | "pick" | "old" | "new" | "uninstall" */
    toastTimer: null,
    _reboundVisual: false,
    pinAfterSave: false,
    defaultSmsPending: false,
    handoffDialog: null, /* null | "restore" | "still" */
    scrollServiceId: null,
    editingNumber: false,
    numberDraft: "",
    editingLabel: false,
    labelDraft: "",
  };

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  function dateLocaleTag() {
    const id = (typeof getLocale === "function" && getLocale()) || "en";
    const map = {
      "zh-CN": "zh-CN",
      "zh-TW": "zh-TW",
      "zh-HK": "zh-HK",
      "en": "en",
      "ja": "ja",
      "ko": "ko",
      "de": "de",
      "fr": "fr",
      "es": "es",
      "pt": "pt",
      "vi": "vi",
    };
    return map[id] || id || "en";
  }

  function fmtDate(msOrIso) {
    let d;
    if (typeof msOrIso === "number") d = new Date(msOrIso);
    else if (typeof msOrIso === "string") d = new Date(msOrIso);
    else return "—";
    if (isNaN(d.getTime())) return "—";
    try {
      return d.toLocaleString(dateLocaleTag(), {
        year: "numeric", month: "short", day: "numeric",
        hour: "numeric", minute: "2-digit",
      });
    } catch (_) {
      return d.toISOString().slice(0, 16).replace("T", " ");
    }
  }


  /** Demo-only: fixed "last backup" from ledger; fake backup must NOT advance it. */
  function demoLastBackupMs() {
    const meta = (state.ledger && state.ledger.meta) || {};
    const summary = (state.ledger && state.ledger.summary) || {};
    const ts = meta.lastBackupTs ?? summary.lastBackupTs;
    if (typeof ts === "number" && !isNaN(ts)) return ts;
    const msgs = (state.ledger && state.ledger.messages) || [];
    let max = 0;
    for (const m of msgs) {
      const d = Number(m.dateMs) || 0;
      if (d > max) max = d;
    }
    return max || null;
  }

  function displaySmsBody(body) {
    if (!body) return "";
    return String(body);
  }

  function statusLabel(status, target) {
    switch (status) {
      case "confirmed": return t("status_confirmed");
      case "bound": return t("status_bound");
      case "unbound": return t("status_unbound");
      case "not_bound": return t("status_never_bound");
      case "rebound":
        return target ? t("status_rebound", { to: target }) : t("status_rebound_plain");
      default: return status || t("status_confirmed");
    }
  }

  function historyActionLabel(action) {
    const map = {
      confirmed: "history_action_confirmed",
      bound: "history_action_bound",
      unbound: "history_action_unbound",
      rebound: "history_action_rebound",
      not_bound: "history_action_not_bound",
      deleted: "history_action_deleted",
    };
    return t(map[action] || "history_action_confirmed");
  }

  function servicesForLine(lineKey) {
    return state.ledger.services.filter((s) => s.lineKey === lineKey);
  }
  function confirmedServices(lineKey) {
    return servicesForLine(lineKey).filter(onConfirmedList);
  }
  function unrecognizedServices(lineKey) {
    return servicesForLine(lineKey).filter((s) => s.status === "unrecognized");
  }
  function unrecognizedServiceIds() {
    const set = new Set();
    (state.ledger.services || []).forEach((s) => {
      if (s.status === "unrecognized") set.add(s.id);
    });
    return set;
  }
  /** One SMS per unidentified row — App UnidentifiedRow aligned. */
  function unidentifiedMessages(lineKey) {
    const ids = unrecognizedServiceIds();
    return messagesFor({ lineKey }).filter((m) => {
      if (m.wide && !state.wideScan) return false;
      if (m.serviceId && ids.has(m.serviceId)) return true;
      if (!m.serviceId) {
        const h = String(m.statusHint || "");
        return /未识别|Unrecognized|未識別/i.test(h);
      }
      return false;
    });
  }
  /** Demo gateway sender: pure digit short code (≥4) or AUTHMSG. */
  function isDemoGateway(address) {
    const a = String(address || "").trim();
    if (!a) return false;
    if (/^\d{4,}$/.test(a)) return true;
    return a.toLowerCase() === "authmsg";
  }
  /** Prefer ledger messages[].gateway; fall back to address heuristic. */
  function showGatewayBadge(mOrAddress) {
    if (mOrAddress && typeof mOrAddress === "object") {
      if (Object.prototype.hasOwnProperty.call(mOrAddress, "gateway")) {
        return !!mOrAddress.gateway;
      }
      return isDemoGateway(mOrAddress.address);
    }
    return isDemoGateway(mOrAddress);
  }
  function unidentifiedRowTitle(m) {
    const CP = window.ContiguousPick;
    const bl = CP && CP.bracketLabel ? CP.bracketLabel(m && m.body) : null;
    if (bl) return bl;
    return (m && m.address) || "";
  }

  function messagesFor(opts) {
    let list = state.ledger.messages.slice();
    if (opts.lineKey) list = list.filter((m) => m.lineKey === opts.lineKey);
    if (opts.serviceId) list = list.filter((m) => m.serviceId === opts.serviceId);
    if (opts.q) {
      const q = opts.q.toLowerCase();
      list = list.filter(
        (m) =>
          (m.address && m.address.toLowerCase().includes(q)) ||
          (m.body && m.body.toLowerCase().includes(q)) ||
          (displaySmsBody(m.body).toLowerCase().includes(q))
      );
    }
    list.sort((a, b) => (b.dateMs || 0) - (a.dateMs || 0));
    return list;
  }

  function countMessagesForService(serviceId) {
    return state.ledger.messages.filter((m) => m.serviceId === serviceId).length;
  }
  function associatedCount(serviceId) {
    return countMessagesForService(serviceId);
  }
  function isBindingStatus(status) {
    return status === "bound" || status === "unbound" || status === "rebound";
  }
  function normalizeServiceName(raw) {
    return String(raw || "").trim().replace(/\s+/g, " ").toLowerCase();
  }
  /** Still on the 已确认 list: a real service that still has associated SMS. */
  function onConfirmedList(s) {
    if (!s || s.status === "unrecognized") return false;
    return associatedCount(s.id) > 0;
  }
  /** 按服务自查. 已确认 + 0 SMS is absent. Binding statuses stay. 未绑任何号 stays as the no-SMS card. */
  function onServiceAxis(s) {
    if (!s || s.status === "unrecognized") return false;
    if (associatedCount(s.id) > 0) return true;
    if (isBindingStatus(s.status)) return true;
    return s.status === "not_bound" || !!s.noSms;
  }
  function isNoSmsCard(s) {
    if (!s || s.status === "unrecognized") return false;
    if (associatedCount(s.id) > 0) return false;
    if (isBindingStatus(s.status)) return false;
    return s.status === "not_bound" || !!s.noSms;
  }
  function syncUserBadge(svc) {
    const msgs = messagesForService(svc.id);
    if (msgs.some((m) => m.userLinked)) svc.userLabeled = true;
    else if (svc.labelGranular || msgs.length === 0) svc.userLabeled = false;
  }
  function rememberGoneLabel(svc) {
    if (!svc) return;
    if (!state.goneLabels) state.goneLabels = {};
    state.goneLabels[svc.id] = svc.label;
  }
  function dropService(svc) {
    rememberGoneLabel(svc);
    state.ledger.services = state.ledger.services.filter((s) => s.id !== svc.id);
  }
  /**
   * After associated SMS change. Does not write history or change a binding status.
   * 已确认 + 0 drops. A nowhere / 未绑任何号 row becomes the deletable card.
   * 已绑 / 已解绑 / 已换绑 stay, with no no-SMS mark.
   */
  function foldAfterSmsChange(svc) {
    if (!svc || svc.status === "unrecognized") return;
    const n = associatedCount(svc.id);
    svc.messageCount = n;
    if (n > 0) {
      syncUserBadge(svc);
      return;
    }
    syncUserBadge(svc);
    if (isBindingStatus(svc.status)) {
      svc.noSms = false;
      return;
    }
    if (svc.status === "not_bound" || svc.noSms) {
      svc.status = "not_bound";
      svc.noSms = true;
      svc.messageCount = 0;
      return;
    }
    dropService(svc);
  }
  /** After a real status save. 已确认 + 0 leaves both lists. */
  function applyZeroSmsAfterStatus(svc) {
    if (!svc) return;
    const n = associatedCount(svc.id);
    svc.messageCount = n;
    if (n > 0) {
      svc.noSms = false;
      return;
    }
    if (svc.status === "confirmed") {
      dropService(svc);
      return;
    }
    if (isBindingStatus(svc.status)) {
      svc.noSms = false;
      svc.userLabeled = false;
      return;
    }
    if (svc.status === "not_bound") {
      svc.noSms = true;
      svc.userLabeled = false;
      svc.messageCount = 0;
    }
  }
  function findSameLineService(lineKey, name) {
    const n = normalizeServiceName(name);
    if (!n) return null;
    return state.ledger.services.find((s) =>
      s.lineKey === lineKey &&
      s.status !== "unrecognized" &&
      normalizeServiceName(s.label) === n
    ) || null;
  }
  function mintUserService(lineKey, name) {
    const slug = String(name || "svc")
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "svc";
    let unique = "user-" + slug;
    let n = 2;
    while (state.ledger.services.some((s) => s.id === unique)) {
      unique = "user-" + slug + "-" + n;
      n += 1;
    }
    const row = {
      id: unique,
      lineKey: lineKey,
      label: name,
      category: "user",
      status: "confirmed",
      userLabeled: true,
      labelGranular: true,
      messageCount: 0,
    };
    state.ledger.services.push(row);
    return row;
  }
  function normalizeLedgerVisibility() {
    const list = (state.ledger.services || []).slice();
    list.forEach((s) => {
      if (s && s.hadSms) delete s.hadSms;
      foldAfterSmsChange(s);
    });
  }
  function latestExcerpt(serviceId) {
    const msgs = messagesFor({ serviceId });
    return msgs[0] ? displaySmsBody(msgs[0].body) : "";
  }
  function latestTs(serviceId) {
    const msgs = messagesFor({ serviceId });
    return msgs[0] ? msgs[0].dateMs : null;
  }

  function messagesForService(serviceId) {
    return state.ledger.messages.filter((m) => m.serviceId === serviceId);
  }
  /** Row dismissed when every linked SMS is dismissed (SMS-level, App-aligned). */
  function serviceAllDismissed(serviceId) {
    const msgs = messagesForService(serviceId);
    return msgs.length > 0 && msgs.every((m) => !!m.dismissed);
  }
  function toggleServiceDismissed(serviceId) {
    const msgs = messagesForService(serviceId);
    if (!msgs.length) return;
    const next = !serviceAllDismissed(serviceId);
    msgs.forEach((m) => { m.dismissed = next; });
  }
  function emptyLabelFlow() {
    return { unrecId: null, messageId: null, name: "", selected: {}, mode: "tap", tapStart: null, tapEnd: null, cellPx: 48, body: "" };
  }
  function toggleMessageDismissed(mid) {
    const m = state.ledger.messages.find((x) => x.id === mid);
    if (!m) return;
    m.dismissed = !m.dismissed;
  }
  function labelTapRange() {
    const lf = state.labelFlow;
    if (lf.tapStart == null || lf.tapEnd == null) return null;
    return { start: lf.tapStart, end: lf.tapEnd };
  }
  function setLabelTapRange(range) {
    if (range == null) {
      state.labelFlow.tapStart = null;
      state.labelFlow.tapEnd = null;
    } else {
      state.labelFlow.tapStart = range.start;
      state.labelFlow.tapEnd = range.end;
    }
  }
  function currentLabelName() {
    const CP = window.ContiguousPick;
    const lf = state.labelFlow;
    if (lf.mode === "type") return CP.normalizeLabel(lf.name || "");
    const units = CP.units(lf.body || "");
    return CP.normalizeLabel(CP.joined(units, labelTapRange()));
  }

  /** Related SMS for annotate flow — mirrors App RelatedPick / loadRelated. */
  function pickRelatedCandidates(name) {
    const UL = window.UserLabel;
    const RP = window.RelatedPick;
    const lf = state.labelFlow;
    const n = UL && UL.normalize ? UL.normalize(name) : String(name || "").trim();
    const seed = lf.messageId
      ? state.ledger.messages.find((x) => x.id === lf.messageId)
      : null;
    const lineKey = (seed && seed.lineKey) || state.lineKey;
    const pool = messagesFor({ lineKey });
    if (!RP || !UL || !seed) {
      /* Fallback when seed missing: unidentified / unassigned on this line. */
      const unrecIds = unrecognizedServiceIds();
      return pool.filter((m) => {
        if (m.dismissed) return false;
        if (!m.serviceId) return true;
        if (lf.unrecId && m.serviceId === lf.unrecId) return true;
        return unrecIds.has(m.serviceId);
      });
    }
    const unrecIds = unrecognizedServiceIds();
    const others = [];
    for (const m of pool) {
      if (m.id === seed.id) continue;
      if (m.dismissed) continue;
      /* Skip SMS already confirmed under another service (App skips Confirmed). */
      if (m.serviceId && !unrecIds.has(m.serviceId) && m.serviceId !== lf.unrecId) {
        const svc = state.ledger.services.find((s) => s.id === m.serviceId);
        if (svc && svc.status !== "unrecognized") continue;
      }
      if (!UL.bodyContains(m.body, n) && !UL.sameSender(m.address, seed.address)) continue;
      others.push(m);
    }
    return RP.pick(n, seed, others);
  }

  function startLabelFlow(unrecId) {
    const CP = window.ContiguousPick;
    const s = state.ledger.services.find((x) => x.id === unrecId);
    const msgs = messagesFor({ serviceId: unrecId });
    const latest = msgs[0];
    const body = latest ? String(latest.body || "") : "";
    const units = CP.units(body);
    const seed = CP.firstBracketInner(units);
    state.labelFlow = {
      unrecId,
      messageId: latest ? latest.id : null,
      name: "",
      selected: {},
      mode: "tap",
      tapStart: seed ? seed.start : null,
      tapEnd: seed ? seed.end : null,
      cellPx: 48,
      body,
    };
    if (seed) state.labelFlow.name = CP.normalizeLabel(CP.joined(units, seed));
  }
  function startLabelFlowFromMessage(mid) {
    const CP = window.ContiguousPick;
    const m = state.ledger.messages.find((x) => x.id === mid);
    if (!m) return;
    const body = String(m.body || "");
    const units = CP.units(body);
    const seed = CP.firstBracketInner(units);
    state.labelFlow = {
      unrecId: m.serviceId || null,
      messageId: mid,
      name: "",
      selected: {},
      mode: "tap",
      tapStart: seed ? seed.start : null,
      tapEnd: seed ? seed.end : null,
      cellPx: 48,
      body,
    };
    if (seed) state.labelFlow.name = CP.normalizeLabel(CP.joined(units, seed));
  }

  function maskedForLine(lineKey) {
    const n = state.ledger.numbers.find((x) => x.lineKey === lineKey);
    return n ? n.e164 || n.label : lineKey;
  }

  /** Known demo number stays as its masked e164. A long digit string is masked. A label stays as typed. */
  function displayRebound(raw) {
    const s = String(raw || "").trim().slice(0, 80);
    if (!s) return "";
    const numbers = (state.ledger && state.ledger.numbers) || [];
    const known = numbers.find((n) => {
      const e = String(n.e164 || "").trim();
      const label = String(n.label || "").trim();
      return s === e || (label && s === label);
    });
    if (known) return String(known.e164 || known.label || s);
    const digits = s.replace(/\D/g, "");
    if (digits.length >= 7) {
      const tail = digits.slice(-4);
      const headLen = digits.length >= 10 ? 3 : 1;
      const head = digits.slice(0, headLen);
      const mid = Math.max(1, digits.length - head.length - tail.length);
      return (s.startsWith("+") ? "+" : "") + head + "•".repeat(mid) + tail;
    }
    return s;
  }

  function homeStats() {
    const numbers = state.ledger.numbers.length;
    const confirmed = state.ledger.services.filter(onConfirmedList).length;
    const summary = state.ledger.summary || {};
    const verifySms =
      typeof summary.otpRelatedCount === "number"
        ? summary.otpRelatedCount
        : typeof summary.otpCount === "number"
          ? summary.otpCount
          : state.ledger.messages.filter((m) => m.kind === "otp").length;
    const totalMessages =
      typeof summary.messageCount === "number" ? summary.messageCount : state.ledger.messages.length;
    return { numbers, confirmed, verifySms, totalMessages };
  }

  function showToast(msg) {
    const el = $("#toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => el.classList.remove("show"), 4200);
  }

  function honestDegrade(kind) {
    const playCta = t("play_cta") + ": " + PLAY;
    if (kind === "device") showToast(t("degrade_device") + " " + playCta);
    else if (kind === "scan") showToast(t("degrade_scan") + " " + playCta);
    else showToast(t("degrade_full_only") + " " + playCta);
  }

  function appendHistory(row) {
    if (!Array.isArray(state.ledger.history)) state.ledger.history = [];
    const id = "h-demo-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
    state.ledger.history.unshift(
      Object.assign(
        { id, serviceId: "", action: "confirmed", lineKey: null, fromMasked: null, toMasked: null, atMs: Date.now(), note: null },
        row
      )
    );
  }

  function navigate(screen, extra, opts) {
    opts = opts || {};
    const prev = state.screen;
    /* App home is the back-stack floor — never keep pages under it. */
    if (screen === "home") opts = Object.assign({}, opts, { reset: true });
    const pinFlow = isPinStackScreen(prev) || isPinStackScreen(screen);
    if (!opts.replace && !opts.reset && prev && prev !== screen && !pinFlow && state.gated) {
      if (!isPinStackScreen(prev) && prev !== "home") state.stack.push(prev);
      if (state.stack.length > 24) state.stack.shift();
    }
    if (opts.reset) state.stack = [];
    state.screen = screen;
    if (extra) Object.assign(state, extra);
    if (screen === "home") maybeShowStillDefaultPrompt();
    render();
  }

  function isPinStackScreen(name) {
    return name === "pin" || name === "change-pin";
  }

  function popBackStack() {
    while (state.stack.length) {
      const next = state.stack.pop();
      if (!isPinStackScreen(next)) return next;
    }
    return null;
  }

  function navBack() {
    if (!state.gated) { showToast(t("nav_at_root")); return; }
    if (state.statusEditId || state.explain || state.pinAfterSave || state.wizard || state.otpProtect || state.addingService || state.handoffDialog || state.editingNumber || state.editingLabel || state.deletingServiceId) {
      state.statusEditId = null;
      state.explain = null;
      state.pinAfterSave = false;
      state.wizard = null;
      state.otpProtect = false;
      state.addingService = false;
      state.deletingServiceId = null;
      state.editingNumber = false;
      state.numberDraft = "";
      state.editingLabel = false;
      state.labelDraft = "";
      /* back only dismisses the dialog this time; pending flag stays */
      state.handoffDialog = null;
      renderModal();
      return;
    }
    if (state.screen === "change-pin" || (state.screen === "pin" && state.pin.screen === "change")) {
      state.pin.screen = null; state.pin.error = null; state.pin.input = ""; state.pin.newInput = "";
      navigate("settings", null, { replace: true });
      return;
    }
    /* PIN setup/unlock is stack root only when this session never left PIN. */
    if (state.screen === "pin" && (state.pin.screen === "unlock" || state.pin.screen === "setup")) {
      const deeper = popBackStack();
      if (deeper) {
        state.pin.screen = null;
        state.screen = deeper;
        render();
        return;
      }
      showToast(t("nav_at_root"));
      return;
    }
    if (needsPinGate()) {
      showToast(t("nav_at_root"));
      return;
    }
    const prev = popBackStack();
    if (prev) {
      state.screen = prev;
      render();
      return;
    }
    if (state.screen !== "home") {
      state.stack = [];
      state.screen = "home";
      state.pin.screen = null;
      render();
      return;
    }
    /* Already on App home = stack floor. Drop any stale entries. */
    state.stack = [];
    showToast(t("nav_at_root"));
  }

  function navHome() {
    /* Home = refresh → disclosure gate (first screen), not App home. */
    location.reload();
  }

  function navRecents() {
    if (!state.gated) { showToast(t("nav_recents")); return; }
    showToast(t("nav_recents"));
  }

  function needsPinGate() {
    return !!(state.pin.value && !state.pin.unlocked);
  }

  /* Demo PIN: plain in-memory compare only. Always read the field at click time. */
  function normalizePin(s) {
    return String(s || "")
      .trim()
      .replace(/[\uFF10-\uFF19]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFF10 + 0x30));
  }

  function readPinField(id) {
    const el = document.getElementById(id);
    return normalizePin(el ? el.value : "");
  }

  function leavePinToHome(clearValue) {
    if (clearValue) state.pin.value = null;
    state.pin.unlocked = true;
    state.pin.input = "";
    state.pin.newInput = "";
    state.pin.error = null;
    state.pin.screen = null;
    state.stack = [];
    state.screen = "home";
    maybeShowStillDefaultPrompt();
  }

  function currentLine() {
    return (state.ledger && state.ledger.numbers || []).find((n) => n.lineKey === state.lineKey) || null;
  }

  function openLineNumberDialog() {
    const line = currentLine();
    if (!line) return;
    state.editingNumber = true;
    state.editingLabel = false;
    state.numberDraft = line.e164 == null ? "" : String(line.e164);
    renderModal();
  }

  function closeLineNumberDialog() {
    state.editingNumber = false;
    state.numberDraft = "";
    renderModal();
  }

  function saveLineNumberDialog() {
    const line = currentLine();
    if (!line) { closeLineNumberDialog(); return; }
    const v = (state.numberDraft || "").trim();
    line.e164 = v || null;
    showToast(t("line_number_saved", { n: v || t("line_detail_no_number") }));
    state.editingNumber = false;
    state.numberDraft = "";
    render();
  }

  function openLineLabelDialog() {
    const line = currentLine();
    if (!line) return;
    state.editingLabel = true;
    state.editingNumber = false;
    state.labelDraft = line.label == null ? "" : String(line.label);
    renderModal();
  }

  function closeLineLabelDialog() {
    state.editingLabel = false;
    state.labelDraft = "";
    renderModal();
  }

  function saveLineLabelDialog() {
    const line = currentLine();
    if (!line) { closeLineLabelDialog(); return; }
    const v = (state.labelDraft || "").trim();
    line.label = v;
    showToast(t("line_label_saved"));
    state.editingLabel = false;
    state.labelDraft = "";
    render();
  }

    function openStatusDialog(serviceId) {
    const svc = state.ledger.services.find((s) => s.id === serviceId);
    if (!svc || svc.status === "unrecognized") return;
    const card = isNoSmsCard(svc);
    state.statusEditId = serviceId;
    state.needLine = card;
    state.offerConfirmed = !card;
    state.offerRebound = !card;
    state.statusPick = svc.status === "confirmed" && card ? "not_bound" : svc.status;
    state.statusLineKey = "";
    state.reboundDraft = svc.status === "rebound" ? (svc.reboundTo || "") : "";
    state.statusError = null;
    renderModal();
  }

  function saveStatus() {
    const svc = state.ledger.services.find((s) => s.id === state.statusEditId);
    if (!svc || !state.statusPick) { closeStatusDialog(); return; }
    const next = state.statusPick;
    if (next === "confirmed" && !state.offerConfirmed) { closeStatusDialog(); return; }
    if (next === "rebound" && !state.offerRebound) { closeStatusDialog(); return; }
    const count = associatedCount(svc.id);
    let lineKey = svc.lineKey;
    if (state.needLine && next !== "not_bound") {
      if (!state.statusLineKey) {
        state.statusError = t("status_need_line");
        renderModal();
        return;
      }
      lineKey = state.statusLineKey;
    }
    let nextTo = "";
    if (next === "rebound") {
      const field = $("#rebound-draft");
      const raw = String(field ? field.value : state.reboundDraft || "").trim();
      if (!raw) {
        state.reboundDraft = "";
        state.statusError = t("status_rebound_need");
        renderModal();
        return;
      }
      const prevTo = String(svc.reboundTo || "");
      nextTo = raw === prevTo ? prevTo : displayRebound(raw);
      state.reboundDraft = raw;
    }
    const prev = svc.status;
    const prevTo = String(svc.reboundTo || "");
    const sameLine = !state.needLine || next === "not_bound" || lineKey === svc.lineKey;
    if (prev === next && sameLine && (next !== "rebound" || nextTo === prevTo)) {
      closeStatusDialog();
      return;
    }
    svc.lineKey = next === "not_bound" && count === 0 ? svc.lineKey : lineKey;
    svc.status = next;
    svc.reboundTo = next === "rebound" ? nextTo : "";
    appendHistory({
      serviceId: svc.id,
      action: next,
      lineKey: next === "not_bound" && count === 0 ? null : lineKey,
      fromMasked: prev === "rebound" ? (prevTo || null) : null,
      toMasked: next === "rebound" ? nextTo : null,
      note: null,
    });
    applyZeroSmsAfterStatus(svc);
    showToast(t("toast_status_saved"));
    closeStatusDialog();
    render();
  }

  function closeStatusDialog() {
    state.statusEditId = null;
    state.statusPick = null;
    state.statusLineKey = "";
    state.reboundDraft = "";
    state.needLine = false;
    state.offerConfirmed = true;
    state.offerRebound = true;
    state.statusError = null;
    state.reboundLineKey = null;
    state._reboundVisual = false;
    renderModal();
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function escapeAttr(s) { return escapeHtml(s).replace(/'/g, "&#39;"); }

  /** Wax-red SemiBold spans for Mark ranges (align App markedBody / ArchiveWax). */
  function highlightMarksHtml(text, marks) {
    const s = String(text == null ? "" : text);
    const list = (marks || [])
      .map((m) => ({
        start: Math.max(0, Math.min(s.length, m.start | 0)),
        end: Math.max(0, Math.min(s.length, m.end | 0)),
      }))
      .filter((m) => m.end > m.start)
      .sort((a, b) => a.start - b.start);
    if (!list.length) return escapeHtml(s);
    let out = "";
    let at = 0;
    for (const m of list) {
      const start = Math.max(m.start, at);
      const end = m.end;
      if (end <= start) continue;
      if (start > at) out += escapeHtml(s.slice(at, start));
      out += `<span class="mark-wax">${escapeHtml(s.slice(start, end))}</span>`;
      at = end;
    }
    if (at < s.length) out += escapeHtml(s.slice(at));
    return out;
  }

  /** Related-list why-highlight: name in body first; else same-sender address. */
  function relatedRowHighlight(m, name, seedAddress) {
    const UL = window.UserLabel;
    const body = displaySmsBody(m.body);
    const addr = m.address || "";
    const nameHits = UL && UL.nameMarks ? UL.nameMarks(body, name) : [];
    if (nameHits.length) {
      return {
        fromHtml: escapeHtml(addr),
        bodyHtml: highlightMarksHtml(body, nameHits),
      };
    }
    const markSender =
      !!addr &&
      !!seedAddress &&
      UL &&
      UL.sameSender &&
      UL.sameSender(addr, seedAddress);
    if (markSender) {
      return {
        fromHtml: `<span class="mark-wax">${escapeHtml(addr)}</span>`,
        bodyHtml: escapeHtml(body),
      };
    }
    return { fromHtml: escapeHtml(addr), bodyHtml: escapeHtml(body) };
  }

  const LS_DEFAULT_SMS = "demo_default_sms_pending";

  function loadDefaultSmsPending() {
    try { return localStorage.getItem(LS_DEFAULT_SMS) === "1"; } catch (_) { return false; }
  }
  function setDefaultSmsPending(on) {
    state.defaultSmsPending = !!on;
    try {
      if (on) localStorage.setItem(LS_DEFAULT_SMS, "1");
      else localStorage.removeItem(LS_DEFAULT_SMS);
    } catch (_) {}
  }
  function clearDefaultSmsPending() {
    setDefaultSmsPending(false);
    state.handoffDialog = null;
  }
  function maybeShowStillDefaultPrompt() {
    if (!state.gated) return;
    if (!state.defaultSmsPending) return;
    if (state.handoffDialog) return;
    if (state.explain || state.wizard || state.otpProtect || state.addingService || state.statusEditId || state.pinAfterSave || state.deletingServiceId) return;
    state.handoffDialog = "still";
  }
  function openRestoreHandoff() {
    setDefaultSmsPending(true);
    state.handoffDialog = "restore";
    state.explain = null;
  }

  function renderDemoBar() {
    /* Shell no longer shows a persistent DEMO bar; disclosure lives on the gate only. */
  }

  function renderGate() {
    const gate = $("#gate");
    if (state.gated) { gate.classList.add("hidden"); return; }
    gate.classList.remove("hidden");
    const kicker = $("#gate-kicker");
    if (kicker) kicker.textContent = t("gate_kicker");
    $("#gate-title").textContent = t("gate_title");
    $("#gate-lead").textContent = t("gate_lead");
    ["gate-1", "gate-2", "gate-3", "gate-4", "gate-5"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.textContent = t(id.replace("-", "_"));
    });
    $("#gate-enter").textContent = t("gate_enter");
    const cta = $("#gate-cta-link");
    if (cta) {
      cta.textContent = t("gate_cta");
      if (PLAY_LIVE) {
        cta.href = PLAY;
        cta.target = "_blank";
        cta.rel = "noopener";
      } else {
        cta.href = "#";
        cta.removeAttribute("target");
      }
    }
    const soonText = $("#gate-soon-text");
    if (soonText) soonText.textContent = t("gate_soon");
    const soonClose = $("#gate-soon-close");
    if (soonClose) soonClose.textContent = t("back");
  }

  function pinBannerHtml() {
    return ""; /* demo skips PIN; no memory/hash banner */
  }

  function renderPinScreen() {
    const body = $("#phone-body");
    body.className = "phone-body";
    const mode = state.pin.screen || (state.pin.value ? "unlock" : "setup");
    state.pin.screen = mode;

    if (mode === "change") {
      const has = !!state.pin.value;
      body.innerHTML = `
        <div class="screen active">
          ${pinBannerHtml()}
          <div class="nav-top"><button type="button" class="link" id="btn-back-pin">${escapeHtml(t("back"))}</button></div>
          <h1 class="h-display">${escapeHtml(t("pin_change_title"))}</h1>
          ${has ? `<label class="field-label">${escapeHtml(t("pin_current_label"))}</label>
                 <input class="search pin-input" id="pin-cur" type="password" inputmode="numeric" maxlength="12" autocomplete="off" value="${escapeAttr(state.pin.input)}" />` : ""}
          <label class="field-label">${escapeHtml(t("pin_new_label"))}</label>
          <input class="search pin-input" id="pin-new" type="password" inputmode="numeric" maxlength="12" autocomplete="off" value="${escapeAttr(state.pin.newInput)}" />
          ${state.pin.error ? `<p class="err">${escapeHtml(state.pin.error)}</p>` : ""}
          <button type="button" class="btn btn-primary" id="pin-save">${escapeHtml(t("pin_save"))}</button>
        </div>`;
      $("#btn-back-pin").onclick = () => {
        state.pin.screen = null; state.pin.error = null; state.pin.input = ""; state.pin.newInput = "";
        navigate("settings");
      };
      const cur = $("#pin-cur"); const neu = $("#pin-new");
      if (cur) cur.oninput = () => (state.pin.input = cur.value);
      neu.oninput = () => (state.pin.newInput = neu.value);
      $("#pin-save").onclick = () => {
        if (has && readPinField("pin-cur") !== normalizePin(state.pin.value)) {
          state.pin.error = t("pin_wrong"); renderPinScreen(); return;
        }
        const v = readPinField("pin-new");
        if (v.length < 4) { state.pin.error = t("pin_wrong"); renderPinScreen(); return; }
        state.pin.input = "";
        state.pin.newInput = "";
        state.pin.error = null;
        state.pinAfterSave = true;
        render();
      };
      return;
    }

    if (mode === "setup") {
      const tips = [1,2,3,4,5,6,7].map((i) => t("pin_tip_" + i));
      const tip = tips[state.pin.tipIdx % tips.length];
      body.innerHTML = `
        <div class="screen active">
          ${pinBannerHtml()}
          <h1 class="h-display">${escapeHtml(t("app_name"))}</h1>
          <label class="field-label">${escapeHtml(t("pin_new_label"))}</label>
          <input class="search pin-input" id="pin-new" type="password" inputmode="numeric" maxlength="12" autocomplete="off" value="${escapeAttr(state.pin.newInput)}" />
          <button type="button" class="btn btn-primary" id="pin-save">${escapeHtml(t("pin_save"))}</button>
          <button type="button" class="btn btn-ghost" id="pin-skip" style="margin-top:10px;width:100%">${escapeHtml(t("pin_skip"))}</button>
          <div class="tip-card" id="pin-tip">
            <div class="tip-head">${escapeHtml(t("pin_tip_card"))}</div>
            <div class="tip-body">${escapeHtml(tip)}</div>
          </div>
        </div>`;
      const neu = $("#pin-new");
      neu.oninput = () => (state.pin.newInput = neu.value);
      $("#pin-save").onclick = () => {
        state.pin.newInput = "";
        state.pin.input = "";
        state.pin.error = null;
        state.pinAfterSave = true;
        render();
      };
      $("#pin-skip").onclick = () => {
        leavePinToHome(true);
        render();
      };
      $("#pin-tip").onclick = () => { state.pin.tipIdx++; renderPinScreen(); };
      return;
    }

    const tips = [1,2,3,4,5,6,7].map((i) => t("pin_tip_" + i));
    const tip = tips[state.pin.tipIdx % tips.length];
    body.innerHTML = `
      <div class="screen active">
        ${pinBannerHtml()}
        <h1 class="h-display">${escapeHtml(t("app_name"))}</h1>
        <p class="muted">${escapeHtml(t("pin_unlock_lead"))}</p>
        <label class="field-label">${escapeHtml(t("pin_label"))}</label>
        <input class="search pin-input" id="pin-in" type="password" inputmode="numeric" maxlength="12" autocomplete="off" value="${escapeAttr(state.pin.input)}" />
        ${state.pin.error ? `<p class="err">${escapeHtml(state.pin.error)}</p>` : ""}
        <button type="button" class="btn btn-primary" id="pin-unlock">${escapeHtml(t("pin_unlock"))}</button>
        <div class="tip-card" id="pin-tip">
          <div class="tip-head">${escapeHtml(t("pin_tip_card"))}</div>
          <div class="tip-body">${escapeHtml(tip)}</div>
        </div>
      </div>`;
    const inp = $("#pin-in");
    inp.oninput = () => { state.pin.input = inp.value; state.pin.error = null; };
    $("#pin-unlock").onclick = () => {
      const typed = readPinField("pin-in");
      state.pin.input = typed;
      if (typed && typed === normalizePin(state.pin.value)) {
        leavePinToHome(false);
        render();
      } else {
        state.pin.error = t("pin_wrong");
        renderPinScreen();
      }
    };
    $("#pin-tip").onclick = () => { state.pin.tipIdx++; renderPinScreen(); };
  }
  function renderHome() {
    const body = $("#phone-body");
    body.className = "phone-body ruled";
    const stats = homeStats();
    const backupMs = demoLastBackupMs();
    const lastLine = backupMs
      ? t("last_backup_with_count", { date: fmtDate(backupMs), n: stats.totalMessages })
      : t("last_backup_never");

    body.innerHTML = `
      <div class="screen active" id="screen-home">
        <div class="row-between">
          <h1 class="h-display">${escapeHtml(t("app_name"))}</h1>
          <button type="button" class="icon-btn" id="btn-settings" title="${escapeHtml(t("settings_title"))}" aria-label="${escapeHtml(t("settings_title"))}">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19.14 12.94c.04-.31.06-.63.06-.94s-.02-.63-.06-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.07 7.07 0 0 0-1.63-.94l-.36-2.54a.5.5 0 0 0-.5-.42h-3.84a.5.5 0 0 0-.5.42l-.36 2.54c-.58.23-1.12.54-1.63.94l-2.39-.96a.5.5 0 0 0-.6.22L2.77 8.84a.5.5 0 0 0 .12.64l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94L2.89 14.52a.5.5 0 0 0-.12.64l1.92 3.32c.14.24.43.34.68.22l2.39-.96c.5.4 1.05.72 1.63.94l.36 2.54c.05.24.26.42.5.42h3.84c.24 0 .45-.18.5-.42l.36-2.54c.58-.23 1.12-.54 1.63-.94l2.39.96c.25.12.54.02.68-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58zM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7z"/></svg>
          </button>
        </div>
        <p class="tagline">${escapeHtml(t("home_tagline"))}</p>
        <button type="button" class="btn btn-primary" id="btn-backup">${escapeHtml(t("backup_now"))}</button>
        <button type="button" class="btn btn-outline" id="btn-restore" style="margin-top:10px">${escapeHtml(t("restore_now"))}</button>
        <p class="last-backup">${escapeHtml(lastLine)}</p>
        <div class="card">
          <p class="silent-title">${escapeHtml(t("bindings_card_title"))}</p>
          <p class="stats">${escapeHtml(t("bindings_counts_multi", { n: stats.numbers, m: stats.confirmed }))}</p>
          <p class="stats-sub">${escapeHtml(t("bindings_otp_sms", { k: stats.verifySms }))}</p>
          <button type="button" class="link" id="btn-open-bindings">${escapeHtml(t("open_bindings"))}</button>
        </div>
        <p class="disclaimer">${escapeHtml(t("home_disclaimer"))}</p>
        <p style="margin-top:10px"><button type="button" class="link" id="btn-wizard-home">${escapeHtml(t("wizard_home"))}</button></p>
      </div>`;

    $("#btn-settings").onclick = () => navigate("settings");
    $("#btn-backup").onclick = () => {
      state.backupPathChecked = false;
      state.otpProtect = true;
      renderModal();
    };
    $("#btn-restore").onclick = () => { state.restorePathChecked = false; navigate("restore-confirm"); };
    $("#btn-open-bindings").onclick = () => {
      state.lineKey = state.ledger.numbers[0].lineKey;
      state.folds = { detail: true, confirmed: true, unidentified: true };
      navigate("bindings");
    };
    $("#btn-wizard-home").onclick = () => {
      state.wizard = "pick";
      renderModal();
    };
  }

  /* —— Hex-prism line dial (螺帽); page survives re-renders via lastEmitted —— */
  const FACE_DEG = 60;
  const dialCtl = {
    page: 0,
    lastEmitted: null,
    frozen: false,
    motionGen: 0,
    picker: false,
    dragging: false,
    dragPage: 0,
    raf: 0,
    lines: null,
    root: null,
    onSelect: null,
  };

  function dialWrap(i, n) {
    return ((i % n) + n) % n;
  }

  function dialFreeze() {
    dialCtl.motionGen += 1;
    dialCtl.frozen = true;
  }

  function dialEmit(key) {
    dialCtl.lastEmitted = key;
    if (typeof dialCtl.onSelect === "function") dialCtl.onSelect(key);
  }

  function dialShownPage() {
    return dialCtl.dragging ? dialCtl.dragPage : dialCtl.page;
  }

  function dialCancelAnim() {
    if (dialCtl.raf) {
      cancelAnimationFrame(dialCtl.raf);
      dialCtl.raf = 0;
    }
  }

  function dialAnimatePage(target, done) {
    dialCancelAnim();
    const start = dialCtl.page;
    const dist = target - start;
    if (Math.abs(dist) < 0.001) {
      dialCtl.page = target;
      dialPaint();
      if (done) done();
      return;
    }
    const t0 = performance.now();
    const dur = Math.min(420, 180 + Math.abs(dist) * 90);
    const mine = dialCtl.motionGen;
    function frame(now) {
      if (dialCtl.motionGen !== mine) return;
      const u = Math.min(1, (now - t0) / dur);
      /* ease-out cubic ≈ medium-low spring settle */
      const e = 1 - Math.pow(1 - u, 3);
      dialCtl.page = start + dist * e;
      dialPaint();
      if (u < 1) {
        dialCtl.raf = requestAnimationFrame(frame);
      } else {
        dialCtl.raf = 0;
        dialCtl.page = target;
        dialPaint();
        if (done) done();
      }
    }
    dialCtl.raf = requestAnimationFrame(frame);
  }

  function dialRunSpin(block) {
    const mine = dialCtl.motionGen + 1;
    dialFreeze();
    Promise.resolve()
      .then(block)
      .finally(() => {
        if (dialCtl.motionGen === mine) dialCtl.frozen = false;
      });
  }

  function dialSettle() {
    dialRunSpin(() => new Promise((resolve) => {
      if (dialCtl.dragging) {
        dialCtl.page = dialCtl.dragPage;
        dialCtl.dragging = false;
      }
      const target = Math.round(dialCtl.page);
      dialAnimatePage(target, () => {
        const lines = dialCtl.lines || [];
        const n = lines.length;
        if (n >= 2) dialEmit(lines[dialWrap(target, n)].lineKey);
        resolve();
      });
    }));
  }

  function dialTapSideSlot(slot) {
    const lines = dialCtl.lines || [];
    const n = lines.length;
    if (n < 2) return;
    if (dialCtl.frozen || dialCtl.dragging || dialCtl.picker) return;
    const ang = (slot - dialShownPage()) * FACE_DEG;
    if (Math.abs(ang) < 20 || Math.abs(ang) > 80) return;
    dialRunSpin(() => new Promise((resolve) => {
      dialAnimatePage(slot, () => {
        dialEmit(lines[dialWrap(slot, n)].lineKey);
        resolve();
      });
    }));
  }

  function dialFaceUnderPoint(clientX, clientY) {
    const stack = document.elementsFromPoint
      ? document.elementsFromPoint(clientX, clientY)
      : [document.elementFromPoint(clientX, clientY)].filter(Boolean);
    for (const el of stack) {
      if (!el || !el.closest) continue;
      const face = el.closest(".dial-face");
      if (face && dialCtl.root && dialCtl.root.contains(face) && face.classList.contains("is-side")) {
        return face;
      }
    }
    return null;
  }

  function dialPaint() {
    const root = dialCtl.root;
    const lines = dialCtl.lines;
    if (!root || !lines || lines.length < 2) return;
    const n = lines.length;
    const idxEl = root.querySelector(".dial-index");
    const pRound = Math.round(dialShownPage());
    if (idxEl) idxEl.textContent = dialWrap(pRound, n) + 1 + "/" + n;

    if (dialCtl.picker) {
      const picker = root.querySelector(".dial-picker");
      if (!picker) return;
      const onIdx = dialWrap(Math.round(dialCtl.page), n);
      $$(".dial-picker-row", picker).forEach((row, i) => {
        row.classList.toggle("on", i === onIdx);
      });
      return;
    }

    const clip = root.querySelector(".dial-clip");
    const stage = root.querySelector(".dial-stage");
    if (!clip || !stage) return;
    const clipW = clip.clientWidth || 1;
    const facePx = Math.max(1, clipW * 0.5);
    const radius = facePx * 0.8660254;
    const camera = facePx * 8;
    clip.style.perspective = camera + "px";

    const p = dialShownPage();
    const base = Math.floor(p);
    const want = new Set();
    for (let slot = base - 1; slot <= base + 2; slot++) {
      const angle = (slot - p) * FACE_DEG;
      if (Math.abs(angle) > 98) continue;
      want.add(slot);
      let face = stage.querySelector('.dial-face[data-slot="' + slot + '"]');
      const item = lines[dialWrap(slot, n)];
      if (!face) {
        face = document.createElement("button");
        face.type = "button";
        face.className = "dial-face";
        face.setAttribute("data-slot", String(slot));
        face.innerHTML = '<span class="dial-label"></span><span class="sub"></span>';
        stage.appendChild(face);
        face.addEventListener("click", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          if (dialCtl._suppressClick) { dialCtl._suppressClick = false; return; }
          dialTapSideSlot(Number(face.getAttribute("data-slot")));
        });
      }
      face.querySelector(".dial-label").textContent = item.label || item.lineKey;
      const subEl = face.querySelector(".sub");
      if (subEl) subEl.textContent = "";
      face.style.width = facePx + "px";
      const rad = (angle * Math.PI) / 180;
      face.style.transform =
        "translateX(" + Math.sin(rad) * radius + "px) rotateY(" + angle + "deg)";
      face.style.zIndex = String(Math.round(Math.cos(rad) * 1000));
      const side = Math.abs(angle) >= 20 && Math.abs(angle) <= 80;
      face.classList.toggle("is-side", side);
      face.classList.toggle("is-front", Math.abs(angle) < 20);
      face.tabIndex = side && !dialCtl.frozen ? 0 : -1;
    }
    $$(".dial-face", stage).forEach((face) => {
      const s = Number(face.getAttribute("data-slot"));
      if (!want.has(s)) face.remove();
    });
  }

  function dialSyncFromParent(selectedKey) {
    if (selectedKey == null) return;
    if (selectedKey === dialCtl.lastEmitted) return;
    dialCtl.lastEmitted = selectedKey;
    const lines = dialCtl.lines || [];
    const n = lines.length;
    if (n < 2) return;
    const i = lines.findIndex((x) => x.lineKey === selectedKey);
    const idx = i < 0 ? 0 : i;
    if (dialWrap(Math.round(dialCtl.page), n) !== idx) {
      dialCancelAnim();
      dialCtl.page = idx;
      dialCtl.dragging = false;
      dialPaint();
    }
  }

  function dialSetPicker(on) {
    dialCtl.picker = !!on;
    const root = dialCtl.root;
    if (!root || !dialCtl.lines) return;
    const lines = dialCtl.lines;
    const n = lines.length;
    const clip = root.querySelector(".dial-clip");
    let picker = root.querySelector(".dial-picker");
    if (dialCtl.picker) {
      if (clip) clip.style.display = "none";
      if (!picker) {
        picker = document.createElement("div");
        picker.className = "dial-picker";
        root.insertBefore(picker, root.querySelector(".dial-index"));
      }
      picker.style.display = "";
      const onIdx = dialWrap(Math.round(dialCtl.page), n);
      picker.innerHTML = lines
        .map((line, i) => {
          const cls = i === onIdx ? "dial-picker-row on" : "dial-picker-row";
          return (
            '<button type="button" class="' +
            cls +
            '" data-i="' +
            i +
            '">' +
            escapeHtml(line.label || line.lineKey) +
            "</button>"
          );
        })
        .join("");
      $$(".dial-picker-row", picker).forEach((row) => {
        row.onclick = () => {
          const i = Number(row.getAttribute("data-i"));
          const line = lines[i];
          dialCtl.lastEmitted = line.lineKey;
          dialCancelAnim();
          dialCtl.page = i;
          dialCtl.dragging = false;
          if (typeof dialCtl.onSelect === "function") dialCtl.onSelect(line.lineKey);
          dialSetPicker(false);
        };
      });
    } else {
      if (picker) picker.style.display = "none";
      if (clip) clip.style.display = "";
      dialPaint();
    }
  }

  function mountHexDial(root, numbers, selectedKey, onSelect) {
    dialCtl.root = root;
    dialCtl.lines = numbers;
    dialCtl.onSelect = onSelect;
    const idx = Math.max(0, numbers.findIndex((n) => n.lineKey === selectedKey));
    if (dialCtl.lastEmitted == null) {
      dialCtl.page = idx;
      dialCtl.lastEmitted = selectedKey;
    } else if (selectedKey !== dialCtl.lastEmitted) {
      dialSyncFromParent(selectedKey);
    } else if (dialWrap(Math.round(dialCtl.page), numbers.length) !== idx) {
      /* self-emitted: keep unbounded page */
    }

    const clip = root.querySelector(".dial-clip");
    const idxBtn = root.querySelector(".dial-index");
    if (idxBtn && !idxBtn._hexWired) {
      idxBtn._hexWired = true;
      idxBtn.onclick = () => dialSetPicker(!dialCtl.picker);
    }
    if (clip && !clip._hexWired) {
      clip._hexWired = true;
      let lastX = 0;
      let moved = false;
      let activePtr = null;
      const faceW = () => Math.max(1, (clip.clientWidth || 1) * 0.5);
      clip.addEventListener("pointerdown", (ev) => {
        if (dialCtl.picker) return;
        if (ev.button != null && ev.button !== 0) return;
        lastX = ev.clientX;
        moved = false;
        activePtr = ev.pointerId;
        try { clip.setPointerCapture(ev.pointerId); } catch (_) {}
      });
      clip.addEventListener("pointermove", (ev) => {
        if (activePtr == null || ev.pointerId !== activePtr) return;
        const dx = ev.clientX - lastX;
        lastX = ev.clientX;
        if (!dialCtl.dragging) {
          if (Math.abs(dx) < 2) return;
          dialCtl.dragging = true;
          moved = true;
          dialFreeze();
          dialCancelAnim();
          dialCtl.dragPage = dialCtl.page;
        }
        moved = true;
        dialCtl.dragPage -= dx / faceW();
        dialPaint();
      });
      const endDrag = (ev) => {
        if (activePtr == null || ev.pointerId !== activePtr) return;
        activePtr = null;
        try { clip.releasePointerCapture(ev.pointerId); } catch (_) {}
        if (dialCtl.dragging) {
          dialCtl.dragging = false;
          dialCtl.page = dialCtl.dragPage;
          dialCtl._suppressClick = true;
          dialSettle();
          setTimeout(() => {
            dialCtl._suppressClick = false;
            moved = false;
          }, 80);
          return;
        }
        /* Tap without drag: front face used to steal hits — resolve side via hit stack */
        if (moved || dialCtl.picker || dialCtl.frozen) return;
        const face = dialFaceUnderPoint(ev.clientX, ev.clientY);
        if (!face) return;
        dialCtl._suppressClick = true;
        dialTapSideSlot(Number(face.getAttribute("data-slot")));
        setTimeout(() => { dialCtl._suppressClick = false; }, 80);
      };
      clip.addEventListener("pointerup", endDrag);
      clip.addEventListener("pointercancel", endDrag);
      clip.addEventListener("click", (ev) => {
        if (dialCtl._suppressClick || moved) {
          dialCtl._suppressClick = false;
          moved = false;
          ev.preventDefault();
          ev.stopPropagation();
        }
      }, true);
    }

    if (dialCtl.picker) dialSetPicker(true);
    else {
      dialCtl.picker = false;
      dialPaint();
      requestAnimationFrame(() => dialPaint());
    }
  }

  function renderDialShell() {
    return `<div class="dial" id="line-dial-root">
      <div class="dial-clip" id="line-dial-clip">
        <div class="dial-stage"></div>
      </div>
      <button type="button" class="link dial-index" id="dial-index">1/1</button>
    </div>`;
  }

  function bindingsBelowHtml(line, confirmedRows, unrecRows, smsCount) {
    const fold = (key, title, inner) => {
      const open = state.folds[key];
      return `<div class="fold ${open ? "" : "collapsed"}" data-fold="${key}">
        <div class="fold-head" data-fold-toggle="${key}">
          <span>${title}</span><span class="caret">${open ? "▾" : "▸"}</span>
        </div>
        <div class="fold-body">${inner}</div>
      </div>`;
    };
    return `
        ${fold("detail", `${escapeHtml(t("line_detail_title"))} · ${escapeHtml(line.label || line.e164)}`,
          `<div class="detail-grid">
            <div class="k">${escapeHtml(t("line_detail_number"))}</div>
            <div><button type="button" class="link" id="btn-edit-number">${escapeHtml((line.e164 && String(line.e164).trim()) || t("line_detail_no_number"))}</button></div>
            <div class="k">${escapeHtml(t("line_detail_carrier"))}</div><div class="muted">${escapeHtml(line.carrier || t("line_detail_unknown_carrier"))}</div>
            <div class="k">${escapeHtml(t("line_detail_sms"))}</div><div>${escapeHtml(t("sms_event_count", { n: smsCount }))}</div>
          </div>
          <div style="display:flex;gap:16px;margin:10px 0 6px;flex-wrap:wrap;align-items:center">
            <button type="button" class="link" id="btn-edit-label">${escapeHtml(t("line_name_edit"))}</button>
            <button type="button" class="link" id="btn-view-sms">${escapeHtml(t("line_sms_button"))}</button>
          </div>
          <p class="muted" style="font-size:12px">${escapeHtml(t("line_name_help"))}</p>`)}
        ${fold("confirmed", escapeHtml(t("confirmed_header_n", { n: confirmedServices(line.lineKey).length })), confirmedRows)}
        ${fold("unidentified", escapeHtml(t("unidentified_header_n", { n: unidentifiedMessages(line.lineKey).length })),
          `<div class="row-between" style="margin:0 0 10px;align-items:center">
            <span class="muted">${escapeHtml(t("wider_scan"))}</span>
            <label class="switch"><input type="checkbox" id="chk-wide" ${state.wideScan ? "checked" : ""}/></label>
          </div>` + (unrecRows || `<p class="muted">${escapeHtml(t("none_in_backup"))}</p>`))}`;
  }

  function wireBindingsBelow() {
    const back = $("#btn-back-home");
    if (back) back.onclick = () => navigate("home");
    const svc = $("#btn-services");
    if (svc) svc.onclick = () => navigate("services");
    const hist = $("#btn-history");
    if (hist) hist.onclick = () => navigate("history");
    const viewSms = $("#btn-view-sms");
    if (viewSms) viewSms.onclick = () => {
      state.msgFilter = { serviceId: null, q: "" };
      state.smsBrowse = "all";
      navigate("messages");
    };
    const editNum = $("#btn-edit-number");
    if (editNum) editNum.onclick = () => openLineNumberDialog();
    const editLabel = $("#btn-edit-label");
    if (editLabel) editLabel.onclick = () => openLineLabelDialog();
    const wide = $("#chk-wide");
    if (wide) wide.onchange = () => { state.wideScan = wide.checked; renderBindings(); };
    $$(".btn-label-unrec").forEach((b) => {
      b.onclick = () => {
        const mid = b.getAttribute("data-mid");
        if (!mid) return;
        startLabelFlowFromMessage(mid);
        navigate("label");
      };
    });
    $$(".btn-dismiss-unrec").forEach((b) => {
      b.onclick = () => {
        const mid = b.getAttribute("data-mid");
        if (!mid) return;
        toggleMessageDismissed(mid);
        renderBindings();
      };
    });
    $$("[data-fold-toggle]").forEach((el) => {
      el.onclick = () => {
        state.folds[el.getAttribute("data-fold-toggle")] = !state.folds[el.getAttribute("data-fold-toggle")];
        renderBindings();
      };
    });
    $$(".btn-status").forEach((el) => { el.onclick = () => openStatusDialog(el.getAttribute("data-svc")); });
    $$(".btn-sms-count").forEach((el) => {
      el.onclick = () => {
        state.reviewServiceId = el.getAttribute("data-svc");
        const msgs = messagesFor({ serviceId: state.reviewServiceId });
        state.reviewChecks = {};
        msgs.forEach((m) => { state.reviewChecks[m.id] = true; });
        navigate("review");
      };
    });
  }

  function buildBindingsRows(line) {
    const confirmed = confirmedServices(line.lineKey);
    const unrecMsgs = unidentifiedMessages(line.lineKey);
    const smsCount = messagesFor({ lineKey: line.lineKey }).length;
    const confirmedRows =
      confirmed.map((s) => {
        const n = countMessagesForService(s.id);
        const ex = latestExcerpt(s.id);
        const when = latestTs(s.id);
        return `<div class="ledger-row" data-svc="${escapeAttr(s.id)}">
          <div class="row-top">
            <h3 class="h-service">${escapeHtml(s.label)}</h3>
          </div>
          <div class="row-links">
            <button type="button" class="link btn-status" data-svc="${escapeAttr(s.id)}">${escapeHtml(statusLabel(s.status, s.reboundTo))}</button>
            <button type="button" class="link btn-sms-count" data-svc="${escapeAttr(s.id)}">${escapeHtml(t("sms_event_count", { n }))}</button>
          </div>
          <div class="meta">${when ? escapeHtml(fmtDate(when)) : ""}${s.userLabeled ? ` · <span class="badge-gold">${escapeHtml(t("user_confirmed_badge"))}</span>` : ""}</div>
          <div class="excerpt">${escapeHtml(ex)}</div>
        </div>`;
      }).join("") || `<p class="muted">${escapeHtml(t("none_in_backup"))}</p>`;
    const unrecRows =
      unrecMsgs.map((m) => {
        const title = unidentifiedRowTitle(m);
        const dismissed = !!m.dismissed;
        const dismissBtn = dismissed
          ? `<button type="button" class="btn btn-wax btn-dismiss-unrec" data-mid="${escapeAttr(m.id)}">${escapeHtml(t("sms_dismissed"))}</button>`
          : `<button type="button" class="btn btn-outline btn-dismiss-unrec" data-mid="${escapeAttr(m.id)}">${escapeHtml(t("sms_dismiss"))}</button>`;
        const badgeDismiss = dismissed
          ? `<span class="badge-dismissed">${escapeHtml(t("sms_dismissed_badge"))}</span>`
          : "";
        const badgeGw = showGatewayBadge(m)
          ? `<span class="badge-gateway">${escapeHtml(t("shared_gateway"))}</span>`
          : "";
        const badgeWide = m.wide
          ? `<span class="badge-gold">${escapeHtml(t("wider_badge"))}</span>`
          : "";
        return `<div class="ledger-row" data-unrec-mid="${escapeAttr(m.id)}">
            <div class="row-top">
              <h3 class="h-service">${escapeHtml(title)}${badgeGw}${badgeWide}${badgeDismiss}</h3>
            </div>
            <div class="meta">${m.dateMs ? escapeHtml(fmtDate(m.dateMs)) : ""}</div>
            <div class="excerpt">${escapeHtml(displaySmsBody(m.body))}</div>
            <div class="btn-row" style="margin-top:8px">
              <button type="button" class="btn btn-outline btn-label-unrec" data-mid="${escapeAttr(m.id)}" ${dismissed ? "disabled" : ""}>${escapeHtml(t("label_action"))}</button>
              ${m.wide ? "" : dismissBtn}
            </div>
          </div>`;
      }).join("");
    return { confirmedRows, unrecRows, smsCount };
  }

  function onDialSelect(key) {
    if (state.lineKey === key) {
      /* still refresh content in case folds need sync; dial stays */
    }
    state.lineKey = key;
    state.folds = { detail: true, confirmed: true, unidentified: true };
    const below = $("#bindings-below");
    if (below && $("#line-dial-root")) {
      const numbers = state.ledger.numbers;
      const line = numbers.find((n) => n.lineKey === state.lineKey) || numbers[0];
      const rows = buildBindingsRows(line);
      below.innerHTML = bindingsBelowHtml(line, rows.confirmedRows, rows.unrecRows, rows.smsCount);
      wireBindingsBelow();
      return;
    }
    renderBindings();
  }

  function renderBindings() {
    const body = $("#phone-body");
    body.className = "phone-body";
    const numbers = state.ledger.numbers;
    if (!state.lineKey) state.lineKey = numbers[0].lineKey;
    const line = numbers.find((n) => n.lineKey === state.lineKey) || numbers[0];
    state.lineKey = line.lineKey;
    const rows = buildBindingsRows(line);
    const existingDial = $("#line-dial-root");
    const existingBelow = $("#bindings-below");
    const canKeepDial =
      existingDial &&
      existingBelow &&
      body.contains(existingDial) &&
      numbers.length >= 2;

    if (canKeepDial) {
      /* fold toggles / soft refresh: keep prism DOM + unbounded page */
      existingBelow.innerHTML = bindingsBelowHtml(
        line, rows.confirmedRows, rows.unrecRows, rows.smsCount
      );
      wireBindingsBelow();
      dialSyncFromParent(line.lineKey);
      if (!dialCtl.picker) dialPaint();
      return;
    }

    body.innerHTML = `
      <div class="screen active" id="bindings-screen">
        <div class="nav-top"><button type="button" class="link" id="btn-back-home">${escapeHtml(t("back"))}</button></div>
        <h1 class="h-display">${escapeHtml(t("bindings_title"))}</h1>
        <div class="nav-sub">
          <button type="button" class="link" id="btn-services">${escapeHtml(t("check_by_service"))}</button>
          <button type="button" class="link" id="btn-history">${escapeHtml(t("binding_history"))}</button>
        </div>
        ${numbers.length >= 2 ? renderDialShell() : ""}
        <div id="bindings-below">${bindingsBelowHtml(line, rows.confirmedRows, rows.unrecRows, rows.smsCount)}</div>
      </div>`;

    wireBindingsBelow();
    if (numbers.length >= 2) {
      const root = $("#line-dial-root");
      if (root) mountHexDial(root, numbers, line.lineKey, onDialSelect);
    } else {
      dialCtl.root = null;
    }
  }


  function renderMessages() {
    const body = $("#phone-body");
    body.className = "phone-body";
    const line = state.ledger.numbers.find((n) => n.lineKey === state.lineKey);
    const svc = state.msgFilter.serviceId
      ? state.ledger.services.find((s) => s.id === state.msgFilter.serviceId) : null;
    let list = messagesFor({ lineKey: state.lineKey, serviceId: state.msgFilter.serviceId, q: state.msgFilter.q });
    const browse = state.smsBrowse || "all";
    if (browse === "earliest") {
      list = list.slice().sort((a, b) => (a.dateMs || 0) - (b.dateMs || 0)).slice(0, 15);
    } else if (browse === "latest") {
      list = list.slice(0, 15);
    } else if (browse === "source" && line) {
      /* Simplified: last-4 filter only — full Sources dedupe/tap is app-only. */
      const needle = String(line.e164 || "").replace(/[^\d]/g, "").slice(-4);
      list = list.filter((m) => needle && String(m.body || "").replace(/[^\d]/g, "").includes(needle));
    }
    const title = svc
      ? t("line_sms_title_named", { name: svc.label })
      : browse === "source"
        ? t("line_sms_title_source")
        : browse === "earliest"
          ? t("line_sms_title_earliest")
          : browse === "latest"
            ? t("line_sms_title_latest")
            : t("line_sms_title_named", { name: line ? line.label : "" });
    const cards = list.length
      ? list.slice(0, 200).map((m) => `<div class="msg-card">
          <div class="row-between">
            <span class="from">${escapeHtml(m.address || "")}</span>
            <span class="when">${escapeHtml(fmtDate(m.dateMs))}</span>
          </div>
          <div class="body">${escapeHtml(displaySmsBody(m.body))}</div>
        </div>`).join("")
      : `<p class="muted">${escapeHtml(t("line_sms_empty"))}</p>`;
    body.innerHTML = `
      <div class="screen active">
        <div class="nav-top"><button type="button" class="link" id="btn-back-bind">${escapeHtml(t("back"))}</button></div>
        <h1 class="h-title">${escapeHtml(title)}</h1>
        <p class="meta">${escapeHtml(t("line_sms_count", { n: list.length }))}</p>
        <input class="search" id="msg-search" type="search" placeholder="${escapeAttr(t("line_sms_search"))}" value="${escapeAttr(state.msgFilter.q || "")}" />
        ${cards}
      </div>`;
    $("#btn-back-bind").onclick = () => navigate("bindings");
    const search = $("#msg-search");
    search.oninput = () => {
      state.msgFilter.q = search.value;
      const pos = search.selectionStart;
      renderMessages();
      const again = $("#msg-search");
      if (again) { again.focus(); try { again.setSelectionRange(pos, pos); } catch (_) {} }
    };
  }

  function renderLabel() {
    const CP = window.ContiguousPick;
    const bodyEl = $("#phone-body");
    bodyEl.className = "phone-body";
    const lf = state.labelFlow;
    const svc = lf.unrecId ? state.ledger.services.find((s) => s.id === lf.unrecId) : null;
    const msgs = lf.unrecId ? messagesFor({ serviceId: lf.unrecId }) : [];
    const seedMsg = lf.messageId
      ? state.ledger.messages.find((x) => x.id === lf.messageId)
      : null;
    const latest = seedMsg || msgs[0];
    if (lf.body == null || lf.body === "") {
      lf.body = latest ? String(latest.body || "") : "";
      const seed = CP.firstBracketInner(CP.units(lf.body));
      if (seed && lf.tapStart == null) setLabelTapRange(seed);
    }
    const units = CP.units(lf.body || "");
    const name = currentLabelName();
    const cellPx = Math.max(36, Math.min(72, Number(lf.cellPx) || 48));
    lf.cellPx = cellPx;
    const senderAddress = latest ? (latest.address || "") : "";
    const from = senderAddress || (svc && svc.label) || "";
    const when = latest ? latest.dateMs : (svc ? latestTs(svc.id) : null);
    const excerpt = displaySmsBody(lf.body || "");
    const tapOn = lf.mode !== "type";
    const range = labelTapRange();

    let tapBlock = "";
    if (tapOn) {
      const selLine = name
        ? `<p class="ctp-selected">${escapeHtml(t("label_selected", { name }))}</p>`
        : "";
      const cells = units.map((u, i) => {
        const lit = range && i >= range.start && i <= range.end;
        let shown = u;
        if (u === " ") shown = "·";
        else if (u === "\n" || u === "\r") shown = "↵";
        else if (u === "\t") shown = "→";
        const fs = Math.max(12, Math.round(cellPx * 0.42));
        return `<button type="button" class="ctp-cell${lit ? " is-lit" : ""}" data-ctp-i="${i}" style="width:${cellPx}px;height:${cellPx}px;font-size:${fs}px" aria-pressed="${lit ? "true" : "false"}">${escapeHtml(shown)}</button>`;
      }).join("");
      tapBlock = `
        ${selLine}
        <div class="ctp-size-row">
          <button type="button" class="link" id="ctp-smaller" aria-label="${escapeAttr(t("label_cell_smaller"))}">${escapeHtml(t("label_cell_smaller"))}</button>
          <input type="range" id="ctp-size" min="36" max="72" step="1" value="${cellPx}" />
          <button type="button" class="link" id="ctp-larger" aria-label="${escapeAttr(t("label_cell_larger"))}">${escapeHtml(t("label_cell_larger"))}</button>
        </div>
        <div class="ctp-grid" id="ctp-grid">${cells}</div>`;
    } else {
      tapBlock = `
        <label class="field-label">${escapeHtml(t("label_name_placeholder"))}</label>
        <input class="search" id="label-name" type="text" maxlength="64" value="${escapeAttr(lf.name || "")}" placeholder="${escapeAttr(t("label_name_placeholder"))}" />`;
    }

    bodyEl.innerHTML = `
      <div class="screen active">
        <div class="nav-top"><button type="button" class="link" id="btn-back-l">${escapeHtml(t("back"))}</button></div>
        <h1 class="h-title">${escapeHtml(t("label_title"))}</h1>
        <div class="row-between" style="align-items:center;margin-top:8px">
          <span class="label-from">${escapeHtml(from)}</span>
          ${showGatewayBadge(latest || senderAddress) ? `<span class="badge-gateway">${escapeHtml(t("shared_gateway"))}</span>` : ""}
        </div>
        <p class="ctp-meta">${when ? escapeHtml(fmtDate(when)) : ""}</p>
        <p class="excerpt" style="white-space:pre-wrap;margin:4px 0 10px">${escapeHtml(excerpt)}</p>
        <div class="chip-row" role="tablist">
          <button type="button" class="chip${tapOn ? " is-on" : ""}" id="chip-tap" role="tab" aria-selected="${tapOn}">${escapeHtml(t("label_mode_tap"))}</button>
          <button type="button" class="chip${!tapOn ? " is-on" : ""}" id="chip-type" role="tab" aria-selected="${!tapOn}">${escapeHtml(t("label_mode_type"))}</button>
        </div>
        <p class="ctp-hint">${escapeHtml(tapOn ? t("label_tap_hint") : t("label_type_hint"))}</p>
        ${tapBlock}
        <button type="button" class="btn btn-primary" id="label-next" ${name ? "" : "disabled"}>${escapeHtml(t("label_next"))}</button>
      </div>`;

    $("#btn-back-l").onclick = () => navigate("bindings");

    $("#chip-tap").onclick = () => {
      if (lf.mode === "tap") return;
      const hit = CP.rangeOf(units, lf.name || "");
      if (hit) setLabelTapRange(hit);
      lf.mode = "tap";
      renderLabel();
    };
    $("#chip-type").onclick = () => {
      if (lf.mode === "type") return;
      const fromTap = CP.normalizeLabel(CP.joined(units, labelTapRange()));
      if (!(lf.name || "").trim() && fromTap) lf.name = fromTap;
      lf.mode = "type";
      renderLabel();
    };

    if (tapOn) {
      const grid = $("#ctp-grid");
      if (grid) {
        grid.onclick = (ev) => {
          const btn = ev.target.closest("[data-ctp-i]");
          if (!btn) return;
          const i = Number(btn.getAttribute("data-ctp-i"));
          const next = CP.toggle(labelTapRange(), i, units.length);
          setLabelTapRange(next);
          lf.name = CP.normalizeLabel(CP.joined(units, next));
          renderLabel();
        };
      }
      const slider = $("#ctp-size");
      if (slider) {
        slider.oninput = () => { lf.cellPx = Number(slider.value); };
        slider.onchange = () => { lf.cellPx = Number(slider.value); renderLabel(); };
      }
      const smaller = $("#ctp-smaller");
      const larger = $("#ctp-larger");
      if (smaller) smaller.onclick = () => { lf.cellPx = Math.max(36, cellPx - 4); renderLabel(); };
      if (larger) larger.onclick = () => { lf.cellPx = Math.min(72, cellPx + 4); renderLabel(); };
    } else {
      const inp = $("#label-name");
      const nextBtn = $("#label-next");
      if (inp) {
        const syncNext = () => {
          lf.name = inp.value;
          const n = currentLabelName();
          if (nextBtn) nextBtn.disabled = !n;
        };
        inp.oninput = syncNext;
        inp.onkeydown = (e) => {
          if (e.key !== "Enter") return;
          syncNext();
          if (!currentLabelName()) { showToast(t("label_need_name")); return; }
          if (nextBtn) {
            nextBtn.disabled = false;
            nextBtn.click();
          }
        };
      }
    }

    $("#label-next").onclick = () => {
      const n = currentLabelName();
      if (!n) { showToast(t("label_need_name")); return; }
      lf.name = n;
      const candidates = pickRelatedCandidates(n);
      lf.selected = {};
      candidates.forEach((m) => { lf.selected[m.id] = true; });
      /* Related list = LabelRelated; same checkbox review idea as renderReview. */
      navigate("label-related");
    };
  }

  function renderLabelRelated() {
    const body = $("#phone-body");
    body.className = "phone-body has-sticky-footer";
    const name = (state.labelFlow.name || "").trim();
    const candidates = pickRelatedCandidates(name);
    /* Keep selection map aligned with current candidate set. */
    const keep = {};
    candidates.forEach((m) => {
      keep[m.id] = state.labelFlow.selected[m.id] !== false;
    });
    state.labelFlow.selected = keep;
    const nSel = Object.keys(state.labelFlow.selected).filter((k) => state.labelFlow.selected[k]).length;
    const seed = state.labelFlow.messageId
      ? state.ledger.messages.find((x) => x.id === state.labelFlow.messageId)
      : null;
    const seedAddress = seed ? seed.address : "";
    const rows = candidates.slice(0, 100).map((m) => {
      const checked = !!state.labelFlow.selected[m.id];
      const hl = relatedRowHighlight(m, name, seedAddress);
      return `<label class="check-row">
          <input type="checkbox" data-mid="${escapeAttr(m.id)}" ${checked ? "checked" : ""} />
          <span>
            <span class="from">${hl.fromHtml}</span>
            <span class="when"> · ${escapeHtml(fmtDate(m.dateMs))}</span>
            <div class="body">${hl.bodyHtml}</div>
          </span>
        </label>`;
    }).join("");
    body.innerHTML = `
      <div class="screen active screen-review">
        <div class="review-chrome">
          <div class="nav-top"><button type="button" class="link" id="btn-back-lr">${escapeHtml(t("back"))}</button></div>
          <h1 class="h-title">${escapeHtml(t("label_related_title"))}</h1>
          <p class="h-service" style="margin:6px 0">${escapeHtml(name)}</p>
          <p class="muted">${escapeHtml(t("label_related_help"))}</p>
          <div class="row-between" style="margin:8px 0">
            <span class="meta">${escapeHtml(t("sms_event_count", { n: nSel }))}</span>
            <span>
              <button type="button" class="link" id="sel-all">${escapeHtml(t("label_select_all"))}</button> ·
              <button type="button" class="link" id="sel-none">${escapeHtml(t("label_select_none"))}</button>
            </span>
          </div>
        </div>
        <div class="review-list">
          ${rows || `<p class="muted">${escapeHtml(t("none_in_backup"))}</p>`}
        </div>
        <div class="review-footer">
          <button type="button" class="btn btn-primary" id="label-ok" ${nSel ? "" : "disabled"}>${escapeHtml(t("label_confirm"))}</button>
        </div>
      </div>`;
    $("#btn-back-lr").onclick = () => navigate("label");
    $("#sel-all").onclick = () => { candidates.forEach((m) => (state.labelFlow.selected[m.id] = true)); renderLabelRelated(); };
    $("#sel-none").onclick = () => {
      candidates.forEach((m) => { state.labelFlow.selected[m.id] = false; });
      renderLabelRelated();
    };
    $$("input[data-mid]").forEach((cb) => {
      cb.onchange = () => { state.labelFlow.selected[cb.getAttribute("data-mid")] = cb.checked; renderLabelRelated(); };
    });
    $("#label-ok").onclick = () => {
      const ids = Object.keys(state.labelFlow.selected).filter((k) => state.labelFlow.selected[k]);
      if (!ids.length) { showToast(t("label_need_msgs")); return; }
      const seed = state.labelFlow.messageId
        ? state.ledger.messages.find((x) => x.id === state.labelFlow.messageId)
        : null;
      const lineKey = (seed && seed.lineKey) || state.lineKey;
      /* Do not rename an unrecognized bucket in place — other SMS still on that id would become confirmed. */
      let target = findSameLineService(lineKey, name);
      if (!target) target = mintUserService(lineKey, name);
      ids.forEach((mid) => {
        const m = state.ledger.messages.find((x) => x.id === mid);
        if (!m) return;
        m.serviceId = target.id;
        m.userLinked = true;
        m.dismissed = false;
        m.statusHint = "Confirmed";
      });
      target.userLabeled = true;
      target.labelGranular = true;
      /* A no-SMS card that just gained SMS shows as 已确认; noSms stays so losing them returns the card. */
      if (target.noSms && target.status === "not_bound") target.status = "confirmed";
      target.messageCount = associatedCount(target.id);
      showToast(t("label_done_toast"));
      state.labelFlow = emptyLabelFlow();
      navigate("bindings");
    };
  }

  function renderReview() {
    const body = $("#phone-body");
    body.className = "phone-body has-sticky-footer";
    const svc = state.ledger.services.find((s) => s.id === state.reviewServiceId);
    if (!svc) { navigate("bindings"); return; }
    const msgs = messagesFor({ serviceId: svc.id });
    const nSel = Object.keys(state.reviewChecks).filter((k) => state.reviewChecks[k]).length;
    const rows = msgs.slice(0, 100).map((m) => {
      const checked = !!state.reviewChecks[m.id];
      const reviewBody = displaySmsBody(m.body);
      const reviewMarks = window.UserLabel && window.UserLabel.nameMarks
        ? window.UserLabel.nameMarks(reviewBody, svc.label)
        : [];
      return `<label class="check-row">
          <input type="checkbox" data-mid="${escapeAttr(m.id)}" ${checked ? "checked" : ""} />
          <span>
            <span class="from">${escapeHtml(m.address || "")}</span>
            <span class="when"> · ${escapeHtml(fmtDate(m.dateMs))}</span>
            <div class="body">${highlightMarksHtml(reviewBody, reviewMarks)}</div>
          </span>
        </label>`;
    }).join("");
    body.innerHTML = `
      <div class="screen active screen-review">
        <div class="review-chrome">
          <div class="nav-top"><button type="button" class="link" id="btn-back-r">${escapeHtml(t("back"))}</button></div>
          <p class="h-service" style="margin:6px 0">${escapeHtml(svc.label)}</p>
          <p class="muted">${escapeHtml(t("review_help"))}</p>
          <div class="row-between" style="margin:8px 0">
            <span class="meta">${escapeHtml(t("sms_event_count", { n: nSel }))}</span>
            <span>
              <button type="button" class="link" id="sel-all">${escapeHtml(t("label_select_all"))}</button> ·
              <button type="button" class="link" id="sel-none">${escapeHtml(t("label_select_none"))}</button>
            </span>
          </div>
        </div>
        <div class="review-list">
          ${rows || `<p class="muted">${escapeHtml(t("none_in_backup"))}</p>`}
        </div>
        <div class="review-footer">
          <button type="button" class="btn btn-primary" id="review-ok">${escapeHtml(t("review_confirm"))}</button>
        </div>
      </div>`;
    $("#btn-back-r").onclick = () => navigate("bindings");
    $("#sel-all").onclick = () => {
      msgs.forEach((m) => { state.reviewChecks[m.id] = true; });
      renderReview();
    };
    $("#sel-none").onclick = () => {
      Object.keys(state.reviewChecks).forEach((k) => { state.reviewChecks[k] = false; });
      renderReview();
    };
    $$("input[data-mid]").forEach((cb) => {
      cb.onchange = () => {
        state.reviewChecks[cb.getAttribute("data-mid")] = cb.checked;
        renderReview();
      };
    });
    $("#review-ok").onclick = () => {
      /* Uncheck returns SMS to 未识别. Empty confirm is allowed. Status and history stay put; fold decides the card. */
      msgs.forEach((m) => {
        if (state.reviewChecks[m.id]) return;
        m.serviceId = null;
        m.userLinked = false;
        m.statusHint = "Unrecognized";
      });
      foldAfterSmsChange(svc);
      showToast(t("review_saved"));
      navigate("bindings");
    };
  }

  function renderHistory() {
    const body = $("#phone-body");
    body.className = "phone-body";
    const hist = Array.isArray(state.ledger.history) ? state.ledger.history.slice() : [];
    hist.sort((a, b) => (b.atMs || 0) - (a.atMs || 0));
    const rows = hist.length
      ? hist.map((h) => {
          const svc = state.ledger.services.find((s) => s.id === h.serviceId);
          const label = svc ? svc.label : ((state.goneLabels && state.goneLabels[h.serviceId]) || h.serviceId);
          const action = historyActionLabel(h.action);
          let detail = "";
          if (h.action === "rebound" && (h.fromMasked || h.toMasked)) {
            detail = t("history_from_to", { from: h.fromMasked || "—", to: h.toMasked || "—" });
          } else if (h.toMasked) {
            detail = t("history_on_number", { masked: h.toMasked });
          } else if (h.fromMasked) {
            detail = t("history_on_number", { masked: h.fromMasked });
          }
          return `<div class="ledger-row history-row">
              <h3 class="h-service">${escapeHtml(label)}</h3>
              <div class="meta">${escapeHtml(action)}${detail ? " · " + escapeHtml(detail) : ""}</div>
              <div class="meta">${escapeHtml(fmtDate(h.atMs))}</div>
              ${h.note ? `<div class="excerpt">${escapeHtml(h.note)}</div>` : ""}
            </div>`;
        }).join("")
      : `<p class="muted" style="margin-top:16px">${escapeHtml(t("history_empty"))}</p>`;
    body.innerHTML = `
      <div class="screen active">
        <div class="nav-top"><button type="button" class="link" id="btn-back-b">${escapeHtml(t("back"))}</button></div>
        <h1 class="h-title">${escapeHtml(t("binding_history"))}</h1>
        ${rows}
      </div>`;
    $("#btn-back-b").onclick = () => navigate("bindings");
  }

  function renderExport() {
    const body = $("#phone-body");
    body.className = "phone-body";
    const list = state.ledger.services.filter((s) => s.status !== "unrecognized");
    const rows = list.map((s) => {
      const line = state.ledger.numbers.find((n) => n.lineKey === s.lineKey);
      const checked = !!state.exportSelected[s.id];
      return `<label class="check-row">
          <input type="checkbox" data-sid="${escapeAttr(s.id)}" ${checked ? "checked" : ""} />
          <span>
            <strong>${escapeHtml(s.label)}</strong>
            <div class="meta">${escapeHtml((line && line.label) || s.lineKey)} · ${escapeHtml(statusLabel(s.status, s.reboundTo))}</div>
          </span>
        </label>`;
    }).join("");
    body.innerHTML = `
      <div class="screen active">
        <div class="nav-top"><button type="button" class="link" id="btn-back-ex">${escapeHtml(t("back"))}</button></div>
        <h1 class="h-title">${escapeHtml(t("export_title"))}</h1>
        <p class="muted" style="margin:8px 0">${escapeHtml(t("export_help"))}</p>
        ${rows || `<p class="muted">${escapeHtml(t("services_empty"))}</p>`}
        <button type="button" class="btn btn-primary" id="export-go">${escapeHtml(t("export_continue"))}</button>
      </div>`;
    $("#btn-back-ex").onclick = () => navigate("settings");
    $$("input[data-sid]").forEach((cb) => {
      cb.onchange = () => { state.exportSelected[cb.getAttribute("data-sid")] = cb.checked; };
    });
    $("#export-go").onclick = () => {
      const n = Object.keys(state.exportSelected).filter((k) => state.exportSelected[k]).length;
      if (!n) { showToast(t("export_need_one")); return; }
      state.explain = { title: t("export_title"), body: t("export_full_only") + " " + t("play_cta") + ": " + PLAY };
      renderModal();
    };
  }

  function renderBackupConfirm() {
    const body = $("#phone-body");
    body.className = "phone-body";
    const on = state.backupPathChecked;
    body.innerHTML = `
      <div class="screen active">
        <div class="nav-top"><button type="button" class="link" id="btn-back-bc">${escapeHtml(t("back"))}</button></div>
        <h1 class="h-title">${escapeHtml(t("backup_confirm_title"))}</h1>
        <div class="card" style="margin-top:12px">
          <div class="meta">${escapeHtml(t("backup_path_label"))}</div>
          <button type="button" class="link" id="btn-path">${escapeHtml(t("backup_path_demo"))}</button>
          <label class="check-row" style="margin-top:12px">
            <input type="checkbox" id="chk-path" ${on ? "checked" : ""} />
            <span>${escapeHtml(t("backup_to_path"))}</span>
          </label>
          <p class="muted" style="font-size:12px;margin-top:8px">${escapeHtml(on ? t("backup_hint_on") : t("backup_hint_off"))}</p>
        </div>
        <div class="modal-actions" style="justify-content:flex-end">
          <button type="button" class="link" id="bc-cancel">${escapeHtml(t("cancel_back"))}</button>
          <button type="button" class="link" id="bc-ok">${escapeHtml(t("backup_confirm_btn"))}</button>
        </div>
      </div>`;
    $("#btn-back-bc").onclick = () => navigate("home");
    $("#bc-cancel").onclick = () => navigate("home");
    $("#chk-path").onchange = (e) => { state.backupPathChecked = e.target.checked; renderBackupConfirm(); };
    $("#btn-path").onclick = () => {
      state.explain = { title: t("backup_path_label"), body: t("backup_path_demo_explain") };
      renderModal();
    };
    $("#bc-ok").onclick = () => {
      state.explain = { title: t("backup_explain_title"), body: t("backup_explain_body") };
      renderModal();
    };
  }

  function renderRestoreConfirm() {
    const body = $("#phone-body");
    body.className = "phone-body";
    const on = state.restorePathChecked;
    body.innerHTML = `
      <div class="screen active">
        <div class="nav-top"><button type="button" class="link" id="btn-back-rc">${escapeHtml(t("back"))}</button></div>
        <h1 class="h-title">${escapeHtml(t("restore_confirm_title"))}</h1>
        <div class="card" style="margin-top:12px">
          <div class="meta">${escapeHtml(t("backup_path_label"))}</div>
          <button type="button" class="link" id="btn-path">${escapeHtml(t("backup_path_demo"))}</button>
          <label class="check-row" style="margin-top:12px">
            <input type="checkbox" id="chk-path" ${on ? "checked" : ""} />
            <span>${escapeHtml(t("restore_check_path"))}</span>
          </label>
          <p class="muted" style="font-size:12px;margin-top:8px">${escapeHtml(on ? t("restore_hint_on") : t("restore_hint_off"))}</p>
        </div>
        <div class="modal-actions" style="justify-content:flex-end">
          <button type="button" class="link" id="rc-cancel">${escapeHtml(t("cancel_back"))}</button>
          <button type="button" class="link" id="rc-ok">${escapeHtml(t("restore_confirm_btn"))}</button>
        </div>
      </div>`;
    $("#btn-back-rc").onclick = () => navigate("home");
    $("#rc-cancel").onclick = () => navigate("home");
    $("#btn-path").onclick = () => {
      state.explain = { title: t("backup_path_label"), body: t("backup_path_demo_explain") };
      renderModal();
    };
    $("#chk-path").onchange = (e) => { state.restorePathChecked = e.target.checked; renderRestoreConfirm(); };
    $("#rc-ok").onclick = () => {
      openRestoreHandoff();
      navigate("home");
    };
  }

  function renderSettings() {
    const body = $("#phone-body");
    body.className = "phone-body";
    const pref = getLocalePreference();
    const langs = localeLabels.map((L) => {
      const active = L.id === pref;
      const label = L.id === "" ? t("settings_language_system") : L.native;
      return `<li class="${active ? "active" : ""}" data-lang="${escapeAttr(L.id)}">
        <input type="radio" name="lang" ${active ? "checked" : ""} />
        <span>${escapeHtml(label)}</span>
      </li>`;
    }).join("");
    body.innerHTML = `
      <div class="screen active">
        <div class="nav-top"><button type="button" class="link" id="btn-back-home2">${escapeHtml(t("back"))}</button></div>
        <h1 class="h-display">${escapeHtml(t("settings_title"))}</h1>
        <section class="settings-block">
          <h2 class="block-title">${escapeHtml(t("settings_privacy"))}</h2>
          <hr class="block-rule" />
          <div class="block-body">
            <p class="muted">${escapeHtml(t("settings_privacy_pin_none"))}</p>
            <p style="margin-top:10px">
              <button type="button" class="link" id="btn-pin">${escapeHtml(t("pin_set_btn"))}</button>
            </p>
          </div>
        </section>
        <section class="settings-block">
          <h2 class="block-title">${escapeHtml(t("settings_backup"))}</h2>
          <hr class="block-rule" />
          <div class="block-body">
            <p class="muted">${escapeHtml(t("settings_backup_body"))}</p>
            <label class="row-between" style="margin-top:12px;align-items:flex-start;gap:12px">
              <span>${escapeHtml(t("settings_backup_protect"))}</span>
              <input type="checkbox" disabled />
            </label>
            <p class="muted" style="font-size:12px;margin-top:8px">${escapeHtml(t("settings_backup_protect_hint"))}</p>
          </div>
        </section>
        <section class="settings-block">
          <h2 class="block-title">${escapeHtml(t("settings_language"))}</h2>
          <hr class="block-rule" />
          <div class="block-body">
            <ul class="lang-list">${langs}</ul>
          </div>
        </section>
      </div>`;
    $("#btn-back-home2").onclick = () => navigate("home");
    $$(".lang-list li").forEach((li) => {
      li.onclick = () => { setLocale(li.getAttribute("data-lang")); render(); };
    });
    $("#btn-pin").onclick = () => {
      state.pinAfterSave = true;
      renderModal();
    };
  }

  function renderServices() {
    const body = $("#phone-body");
    body.className = "phone-body";
    const list = state.ledger.services.filter(onServiceAxis);
    const rows = list.map((s) => {
      const line = state.ledger.numbers.find((n) => n.lineKey === s.lineKey);
      const card = isNoSmsCard(s);
      const side = card
        ? `<button type="button" class="link btn-no-sms" data-svc="${escapeAttr(s.id)}">${escapeHtml(t("services_no_sms"))}</button>`
        : "";
      const statusText = card
        ? statusLabel("not_bound")
        : `${(line && line.label) || s.lineKey} · ${statusLabel(s.status, s.reboundTo)}`;
      const url = s.manageUrl || s.websiteUrl;
      const urlBtn = url
        ? `<p><button type="button" class="link btn-open-site" data-kind="${escapeAttr(s.manageUrl ? "manage" : "website")}">${escapeHtml(s.manageUrl ? t("open_manage") : t("open_website"))}</button></p>`
        : "";
      return `<div class="ledger-row" data-service-id="${escapeAttr(s.id)}">
          <div class="row-between"><h3 class="h-service">${escapeHtml(s.label)}</h3>${side}</div>
          ${urlBtn}
          <button type="button" class="link btn-svc-status" data-svc="${escapeAttr(s.id)}">${escapeHtml(statusText)}</button>
        </div>`;
    }).join("");
    body.innerHTML = `
      <div class="screen active">
        <div class="nav-top"><button type="button" class="link" id="btn-back-b2">${escapeHtml(t("back"))}</button></div>
        <h1 class="h-title">${escapeHtml(t("check_by_service"))}</h1>
        <p class="nav-sub" style="margin:8px 0">
          <button type="button" class="link" id="btn-add-svc">${escapeHtml(t("services_add"))}</button>
          <button type="button" class="link" id="btn-scan2">${escapeHtml(t("services_scan_apps"))}</button>
        </p>
        ${rows || `<p class="muted">${escapeHtml(t("services_empty"))}</p>`}
      </div>`;
    $("#btn-back-b2").onclick = () => navigate("bindings");
    $("#btn-add-svc").onclick = () => { state.addingService = true; renderModal(); };
    $("#btn-scan2").onclick = () => {
      state.explain = { title: t("services_scan_apps"), body: t("degrade_scan") };
      renderModal();
    };
    $$(".btn-open-site").forEach((el) => {
      el.onclick = () => {
        showToast(t("open_site_demo_toast"));
      };
    });
    $$(".btn-no-sms").forEach((el) => {
      el.onclick = () => {
        state.deletingServiceId = el.getAttribute("data-svc");
        renderModal();
      };
    });
    $$(".btn-svc-status").forEach((el) => {
      el.onclick = () => {
        const svc = state.ledger.services.find((s) => s.id === el.getAttribute("data-svc"));
        if (svc) state.lineKey = svc.lineKey;
        openStatusDialog(el.getAttribute("data-svc"));
      };
    });
    if (state.scrollServiceId) {
      const sid = state.scrollServiceId;
      state.scrollServiceId = null;
      requestAnimationFrame(() => {
        const row = document.querySelector('[data-service-id="' + sid.replace(/"/g, '') + '"]');
        if (row && row.scrollIntoView) row.scrollIntoView({ block: "nearest", behavior: "smooth" });
      });
    }
  }

  function renderModal() {
    const modal = $("#modal");
    if (state.deletingServiceId) {
      const sid = state.deletingServiceId;
      modal.classList.remove("hidden");
      modal.innerHTML = `
        <div class="modal-card" role="dialog" aria-modal="true">
          <h2>${escapeHtml(t("services_delete_title"))}</h2>
          <p class="muted" style="margin:8px 0 0">${escapeHtml(t("services_delete_body"))}</p>
          <div class="modal-actions">
            <button type="button" class="link" id="svc-del-cancel">${escapeHtml(t("cancel_back"))}</button>
            <button type="button" class="link wax" id="svc-del-ok">${escapeHtml(t("services_delete"))}</button>
          </div>
        </div>`;
      $("#svc-del-cancel").onclick = () => {
        state.deletingServiceId = null;
        renderModal();
      };
      $("#svc-del-ok").onclick = () => {
        const svc = state.ledger.services.find((s) => s.id === sid);
        state.deletingServiceId = null;
        if (svc && isNoSmsCard(svc)) {
          appendHistory({
            serviceId: svc.id,
            action: "deleted",
            lineKey: null,
            fromMasked: null,
            toMasked: null,
            note: null,
          });
          dropService(svc);
        }
        render();
      };
      return;
    }
    if (state.otpProtect) {
      modal.classList.remove("hidden");
      modal.innerHTML = `
        <div class="modal-card" role="dialog" aria-modal="true">
          <h2>${escapeHtml(t("backup_otp_title"))}</h2>
          <p class="muted" style="margin:8px 0 12px;white-space:pre-wrap">${escapeHtml(t("backup_otp_body"))}</p>
          <button type="button" class="btn btn-primary" id="otp-off" style="width:100%">${escapeHtml(t("backup_otp_off"))}</button>
          <button type="button" class="btn btn-outline" id="otp-none" style="width:100%">${escapeHtml(t("backup_otp_none"))}</button>
          <button type="button" class="btn btn-outline" id="otp-check" style="width:100%">${escapeHtml(t("backup_otp_check"))}</button>
          <button type="button" class="btn btn-outline" id="otp-ignore" style="width:100%">${escapeHtml(t("backup_otp_ignore"))}</button>
        </div>`;
      const goConfirm = () => {
        state.otpProtect = false;
        navigate("backup-confirm");
      };
      $("#otp-off").onclick = goConfirm;
      $("#otp-none").onclick = goConfirm;
      $("#otp-ignore").onclick = goConfirm;
      $("#otp-check").onclick = () => {
        state.otpProtect = false;
        state.explain = { title: t("backup_otp_check"), body: t("backup_otp_check_demo") };
        renderModal();
      };
      return;
    }
    if (state.addingService) {
      modal.classList.remove("hidden");
      modal.innerHTML = `
        <div class="modal-card" role="dialog" aria-modal="true">
          <h2>${escapeHtml(t("services_add"))}</h2>
          <p class="muted" style="margin:8px 0 12px">${escapeHtml(t("services_add_demo"))}</p>
          <input class="search" id="add-svc-name" type="text" maxlength="40" placeholder="${escapeAttr(t("label_name_placeholder"))}" />
          <div class="modal-actions" style="margin-top:16px">
            <button type="button" class="link" id="add-svc-cancel">${escapeHtml(t("cancel_back"))}</button>
            <button type="button" class="link" id="add-svc-ok">${escapeHtml(t("save"))}</button>
          </div>
        </div>`;
      $("#add-svc-cancel").onclick = () => { state.addingService = false; renderModal(); };
      $("#add-svc-ok").onclick = () => {
        const name = ($("#add-svc-name").value || "").trim();
        if (!name) { showToast(t("label_need_name")); return; }
        const dup = state.ledger.services.some((s) => String(s.label).toLowerCase() === name.toLowerCase());
        if (dup) { showToast(t("services_add_exists")); return; }
        const newId = "demo-nosms-" + Date.now().toString(36);
        state.ledger.services.push({
          id: newId,
          lineKey: state.lineKey || state.ledger.numbers[0].lineKey,
          label: name,
          category: "other",
          status: "not_bound",
          noSms: true,
          messageCount: 0,
        });
        state.addingService = false;
        state.scrollServiceId = newId;
        state.screen = "services";
        render();
      };
      return;
    }
    if (state.wizard) {
      const step = state.wizard;
      const title = t("settings_wizard_title");
      let bodyHtml = "";
      let actionsHtml = "";
      if (step === "pick") {
        bodyHtml = `<p class="muted" style="margin:8px 0 0;white-space:pre-wrap">${escapeHtml(t("wizard_pick_body"))}</p>`;
        actionsHtml = `
          <div class="modal-actions" style="justify-content:stretch;flex-direction:column;gap:10px;margin-top:16px">
            <button type="button" class="btn btn-primary" id="wiz-old" style="width:100%">${escapeHtml(t("wizard_old"))}</button>
            <button type="button" class="btn btn-outline" id="wiz-new" style="width:100%">${escapeHtml(t("wizard_new"))}</button>
            <button type="button" class="btn btn-outline" id="wiz-uninstall" style="width:100%">${escapeHtml(t("wizard_uninstall"))}</button>
            <button type="button" class="link" id="wiz-close" style="align-self:flex-end">${escapeHtml(t("cancel_back"))}</button>
          </div>`;
      } else if (step === "old" || step === "uninstall") {
        const bodyKey = step === "old" ? "wizard_old_body" : "wizard_uninstall_body";
        bodyHtml = `<p class="muted" style="margin:8px 0 0;white-space:pre-wrap">${escapeHtml(t(bodyKey))}</p>`;
        actionsHtml = `
          <div class="modal-actions" style="justify-content:flex-end;margin-top:16px;gap:16px">
            <button type="button" class="link" id="wiz-back">${escapeHtml(t("cancel_back"))}</button>
            <button type="button" class="link" id="wiz-go-backup">${escapeHtml(t("settings_wizard_backup"))}</button>
          </div>`;
      } else if (step === "new") {
        bodyHtml = `<p class="muted" style="margin:8px 0 0;white-space:pre-wrap">${escapeHtml(t("wizard_new_body"))}</p>`;
        actionsHtml = `
          <div class="modal-actions" style="justify-content:flex-end;margin-top:16px;gap:16px">
            <button type="button" class="link" id="wiz-back">${escapeHtml(t("cancel_back"))}</button>
            <button type="button" class="link" id="wiz-go-restore">${escapeHtml(t("settings_wizard_restore"))}</button>
          </div>`;
      }
      modal.classList.remove("hidden");
      modal.innerHTML = `
        <div class="modal-card" role="dialog" aria-modal="true">
          <h2>${escapeHtml(title)}</h2>
          ${bodyHtml}
          ${actionsHtml}
        </div>`;
      const closeWiz = () => { state.wizard = null; renderModal(); };
      const backPick = () => { state.wizard = "pick"; renderModal(); };
      const goOld = $("#wiz-old");
      if (goOld) goOld.onclick = () => { state.wizard = "old"; renderModal(); };
      const goNew = $("#wiz-new");
      if (goNew) goNew.onclick = () => { state.wizard = "new"; renderModal(); };
      const goUn = $("#wiz-uninstall");
      if (goUn) goUn.onclick = () => { state.wizard = "uninstall"; renderModal(); };
      const wizClose = $("#wiz-close");
      if (wizClose) wizClose.onclick = closeWiz;
      const wizBack = $("#wiz-back");
      if (wizBack) wizBack.onclick = backPick;
      const goBackup = $("#wiz-go-backup");
      if (goBackup) goBackup.onclick = () => {
        state.wizard = null;
        state.backupPathChecked = false;
        state.otpProtect = true;
        renderModal();
      };
      const goRestore = $("#wiz-go-restore");
      if (goRestore) goRestore.onclick = () => {
        state.wizard = null;
        state.restorePathChecked = false;
        navigate("restore-confirm");
      };
      return;
    }
    if (state.pinAfterSave) {
      modal.classList.remove("hidden");
      modal.innerHTML = `
        <div class="modal-card" role="dialog" aria-modal="true">
          <h2>${escapeHtml(t("pin_after_save_title"))}</h2>
          <p class="muted" style="margin:8px 0 0;white-space:pre-wrap">${escapeHtml(t("pin_after_save_body"))}</p>
          <div class="modal-actions" style="justify-content:stretch;margin-top:16px">
            <button type="button" class="btn btn-primary" id="pin-after-skip" style="width:100%">${escapeHtml(t("pin_skip_to_home"))}</button>
          </div>
        </div>`;
      $("#pin-after-skip").onclick = () => {
        const staySettings = state.screen === "settings";
        state.pinAfterSave = false;
        leavePinToHome(true);
        if (staySettings) state.screen = "settings";
        render();
      };
      return;
    }
    if (state.handoffDialog === "restore" || state.handoffDialog === "still") {
      const isRestore = state.handoffDialog === "restore";
      const title = isRestore ? t("restore_handoff_title") : t("default_sms_still_title");
      const body = isRestore
        ? (t("restore_explain_body") + "\n\n" + t("restore_handoff_body"))
        : t("default_sms_still_body");
      modal.classList.remove("hidden");
      modal.innerHTML = `
        <div class="modal-card" role="dialog" aria-modal="true">
          <h2>${escapeHtml(title)}</h2>
          <p class="muted" style="margin:8px 0 0;white-space:pre-wrap">${escapeHtml(body)}</p>
          <div class="modal-actions" style="justify-content:stretch;flex-direction:column;gap:12px;margin-top:16px">
            <button type="button" class="btn btn-primary" id="handoff-settings" style="width:100%">${escapeHtml(t("restore_open_settings"))}</button>
            <button type="button" class="btn btn-outline" id="handoff-switched" style="width:100%">${escapeHtml(t("restore_switched_back"))}</button>
            <button type="button" class="link" id="handoff-back" style="align-self:flex-end">${escapeHtml(t("cancel_back"))}</button>
          </div>
        </div>`;
      $("#handoff-settings").onclick = () => {
        showToast(t("restore_settings_demo_toast"));
        /* pending stays until user confirms switched back */
        renderModal();
      };
      $("#handoff-switched").onclick = () => {
        clearDefaultSmsPending();
        renderModal();
      };
      $("#handoff-back").onclick = () => {
        /* dismiss for now; pending remains so next home/launch shows again */
        state.handoffDialog = null;
        renderModal();
      };
      return;
    }
    if (state.explain) {
      modal.classList.remove("hidden");
      modal.innerHTML = `
        <div class="modal-card" role="dialog" aria-modal="true">
          <h2>${escapeHtml(state.explain.title)}</h2>
          <p class="muted" style="margin:8px 0 0;white-space:pre-wrap">${escapeHtml(state.explain.body)}</p>
          <div class="modal-actions">
            <button type="button" class="link" id="explain-close">${escapeHtml(t("dialog_close"))}</button>
          </div>
        </div>`;
      $("#explain-close").onclick = () => {
        state.explain = null;
        if (state.screen === "backup-confirm" || state.screen === "restore-confirm") navigate("home");
        else renderModal();
      };
      return;
    }
    if (state.editingNumber && state.screen === "bindings") {
      modal.classList.remove("hidden");
      modal.innerHTML = `
        <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="line-number-title">
          <h2 id="line-number-title">${escapeHtml(t("line_number_title"))}</h2>
          <label class="muted" style="display:block;font-size:12px;margin:8px 0 4px" for="line-number-draft">${escapeHtml(t("line_number_field"))}</label>
          <input class="search" id="line-number-draft" type="tel" maxlength="32" value="${escapeAttr(state.numberDraft || "")}" autocomplete="tel" />
          <div class="modal-actions">
            <button type="button" class="link" id="line-number-cancel">${escapeHtml(t("cancel_back"))}</button>
            <button type="button" class="link" id="line-number-save">${escapeHtml(t("save"))}</button>
          </div>
        </div>`;
      const draft = $("#line-number-draft");
      if (draft) {
        draft.oninput = () => { state.numberDraft = draft.value; };
        draft.focus();
        try { draft.setSelectionRange(draft.value.length, draft.value.length); } catch (_) {}
      }
      $("#line-number-cancel").onclick = closeLineNumberDialog;
      $("#line-number-save").onclick = saveLineNumberDialog;
      return;
    }
    if (state.editingLabel && state.screen === "bindings") {
      modal.classList.remove("hidden");
      modal.innerHTML = `
        <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="line-label-title">
          <h2 id="line-label-title">${escapeHtml(t("line_name_title"))}</h2>
          <label class="muted" style="display:block;font-size:12px;margin:8px 0 4px" for="line-label-draft">${escapeHtml(t("line_name_field"))}</label>
          <input class="search" id="line-label-draft" type="text" maxlength="40" value="${escapeAttr(state.labelDraft || "")}" />
          <button type="button" class="btn btn-outline" id="line-label-sms" style="width:100%;margin-top:12px">${escapeHtml(t("line_sms_button"))}</button>
          <div class="modal-actions">
            <button type="button" class="link" id="line-label-cancel">${escapeHtml(t("cancel_back"))}</button>
            <button type="button" class="link" id="line-label-save">${escapeHtml(t("save"))}</button>
          </div>
        </div>`;
      const draft = $("#line-label-draft");
      if (draft) {
        draft.oninput = () => { state.labelDraft = draft.value; };
        draft.focus();
        try { draft.setSelectionRange(draft.value.length, draft.value.length); } catch (_) {}
      }
      $("#line-label-sms").onclick = () => {
        /* App keeps label dialog state while LineSmsScreen covers; return reopens dialog. */
        state.msgFilter = { serviceId: null, q: "" };
        state.smsBrowse = "all";
        navigate("messages");
      };
      $("#line-label-cancel").onclick = closeLineLabelDialog;
      $("#line-label-save").onclick = saveLineLabelDialog;
      return;
    }
    if (!state.statusEditId) { modal.classList.add("hidden"); modal.innerHTML = ""; return; }
    const svc = state.ledger.services.find((s) => s.id === state.statusEditId);
    if (!svc) { closeStatusDialog(); return; }
    const opts = [];
    if (state.offerConfirmed) opts.push(["confirmed", t("status_confirmed")]);
    opts.push(
      ["bound", t("status_bound")],
      ["unbound", t("status_unbound")],
    );
    if (state.offerRebound) opts.push(["rebound", t("status_rebound_plain")]);
    opts.push(["not_bound", t("status_never_bound")]);
    const pick = state.statusPick;
    let lineBlock = "";
    if (state.needLine && pick && pick !== "not_bound") {
      const chips = (state.ledger.numbers || []).map((n) => {
        const sel = state.statusLineKey === n.lineKey ? " selected" : "";
        const shown = n.label || n.e164 || n.lineKey;
        return `<button type="button" class="chip line-chip${sel}" data-line="${escapeAttr(n.lineKey)}">${escapeHtml(shown)}</button>`;
      }).join("");
      lineBlock = `<div class="rebound-pick">
        <p class="meta" style="margin:8px 0 4px">${escapeHtml(t("status_line_picks"))}</p>
        <div class="chip-row">${chips}</div>
      </div>`;
    }
    let reboundBlock = "";
    if (pick === "rebound") {
      const exclude = state.needLine ? state.statusLineKey : svc.lineKey;
      const chips = (state.ledger.numbers || [])
        .filter((n) => !exclude || n.lineKey !== exclude)
        .map((n) => {
          const value = String(n.e164 || n.label || "");
          const sel = String(state.reboundDraft || "").trim() === value ? " selected" : "";
          const shown = n.label && n.e164 ? n.label + " · " + n.e164 : value;
          return `<button type="button" class="chip rebound-chip${sel}" data-to="${escapeAttr(value)}">${escapeHtml(shown)}</button>`;
        }).join("");
      reboundBlock = `<div class="rebound-pick">
        <p class="meta" style="margin:8px 0 4px">${escapeHtml(t("status_rebound_picks"))}</p>
        <div class="chip-row">${chips}</div>
        <label class="muted" style="display:block;font-size:12px;margin:8px 0 4px" for="rebound-draft">${escapeHtml(t("status_rebound_field"))}</label>
        <input class="search" id="rebound-draft" type="text" maxlength="80" value="${escapeAttr(state.reboundDraft || "")}" />
      </div>`;
    }
    const err = state.statusError ? `<p class="err">${escapeHtml(state.statusError)}</p>` : "";
    modal.classList.remove("hidden");
    modal.innerHTML = `
      <div class="modal-card" role="dialog" aria-modal="true">
        <h2>${escapeHtml(t("status_dialog_title"))}</h2>
        ${opts.map(([o, label]) => {
          const selected = pick === o;
          return `<button type="button" class="status-opt ${selected ? "selected" : ""}" data-status="${o}">${escapeHtml(label)}</button>`;
        }).join("")}
        ${lineBlock}
        ${reboundBlock}
        ${err}
        <div class="modal-actions">
          <button type="button" class="link" id="status-cancel">${escapeHtml(t("cancel_back"))}</button>
          <button type="button" class="link" id="status-save">${escapeHtml(t("save"))}</button>
        </div>
      </div>`;
    $$(".status-opt", modal).forEach((b) => {
      b.onclick = () => {
        state.statusPick = b.getAttribute("data-status");
        state.statusError = null;
        if (state.statusPick !== "rebound") state.reboundDraft = "";
        renderModal();
      };
    });
    $$(".line-chip", modal).forEach((c) => {
      c.onclick = () => {
        state.statusLineKey = c.getAttribute("data-line");
        state.statusError = null;
        renderModal();
      };
    });
    $$(".rebound-chip", modal).forEach((c) => {
      c.onclick = () => {
        state.reboundDraft = c.getAttribute("data-to") || "";
        state.statusError = null;
        renderModal();
      };
    });
    const reboundField = $("#rebound-draft");
    if (reboundField) {
      reboundField.oninput = () => {
        state.reboundDraft = reboundField.value;
        state.statusError = null;
        const typed = reboundField.value.trim();
        $$(".rebound-chip", modal).forEach((c) => {
          c.classList.toggle("selected", c.getAttribute("data-to") === typed);
        });
      };
    }
    $("#status-cancel").onclick = closeStatusDialog;
    $("#status-save").onclick = saveStatus;
  }

  function render() {
    renderDemoBar();
    renderGate();
    if (!state.gated) { $("#phone-body").innerHTML = ""; renderModal(); return; }
    if (state.screen === "change-pin") {
      state.screen = "settings";
      state.pinAfterSave = true;
    }
    if (state.screen === "pin") {
      state.pin.screen = "setup";
      renderPinScreen();
      renderModal();
      return;
    }
    switch (state.screen) {
      case "bindings": renderBindings(); break;
      case "messages": renderMessages(); break;
      case "settings": renderSettings(); break;
      case "history": renderHistory(); break;
      case "services": renderServices(); break;
      case "label": renderLabel(); break;
      case "label-related": renderLabelRelated(); break;
      case "review": renderReview(); break;
      case "backup-confirm": renderBackupConfirm(); break;
      case "restore-confirm": renderRestoreConfirm(); break;
      default: renderHome();
    }
    renderModal();
  }

  async function boot() {
    state.defaultSmsPending = loadDefaultSmsPending();
    $("#gate-enter").onclick = () => {
      state.gated = true;
      state.stack = [];
      state.pin.screen = "setup";
      state.screen = "pin";
      const soon = $("#gate-soon");
      if (soon) soon.classList.add("hidden");
      render();
    };
    const cta = $("#gate-cta-link");
    if (cta) {
      cta.onclick = (e) => {
        if (PLAY_LIVE) return;
        e.preventDefault();
        const soon = $("#gate-soon");
        if (soon) soon.classList.remove("hidden");
      };
    }
    const soon = $("#gate-soon");
    const soonClose = $("#gate-soon-close");
    if (soonClose) soonClose.onclick = () => { if (soon) soon.classList.add("hidden"); };
    if (soon) {
      soon.onclick = (e) => {
        if (e.target === soon) soon.classList.add("hidden");
      };
    }
    $("#nav-back").onclick = () => navBack();
    $("#nav-home").onclick = () => navHome();
    $("#nav-recents").onclick = () => navRecents();
    try {
      const res = await fetch("data/demo-ledger.json", { cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      state.ledger = await res.json();
      if (!state.ledger.numbers || !state.ledger.services || !state.ledger.messages) {
        throw new Error("ledger missing arrays");
      }
      state.ledger.services = state.ledger.services.map((s) => Object.assign({}, s));
      state.ledger.messages = state.ledger.messages.map((m) => Object.assign({}, m));

      /* Prefer ledger.history from JSON (D v2). If field missing only: try seed file, else []. Never invent when history[] already present (even if empty). */
      if (!Array.isArray(state.ledger.history)) {
        let seeded = null;
        try {
          const sr = await fetch("data/history-seed.json", { cache: "no-store" });
          if (sr.ok) {
            const sj = await sr.json();
            if (Array.isArray(sj.history)) seeded = sj.history;
            else if (Array.isArray(sj)) seeded = sj;
          }
        } catch (_) {}
        state.ledger.history = seeded && seeded.length
          ? seeded.map((h) => Object.assign({}, h))
          : INLINE_HISTORY_FALLBACK.slice();
      } else {
        state.ledger.history = state.ledger.history.map((h) => Object.assign({}, h));
      }

      state.lineKey = state.ledger.numbers[0].lineKey;
      normalizeLedgerVisibility();
      render();
    } catch (err) {
      console.error(err);
      $("#phone-body").innerHTML =
        `<p class="muted" style="padding:20px">Failed to load <code>data/demo-ledger.json</code>. Serve this folder over HTTP.<br/>${escapeHtml(String(err))}</p>`;
      state.gated = false;
      renderGate();
      renderDemoBar();
    }
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
