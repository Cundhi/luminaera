/* ContiguousPick — pure port of PhoneBindTracker classifier/ContiguousPick.kt */
(function (global) {
  const OPEN_TO_CLOSE = {
    "【": "】",
    "[": "]",
    "「": "」",
  };

  const SKIP_INNER = new Set([
    "验证码",
    "驗證碼",
    "校验码",
    "校驗碼",
    "动态密码",
    "動態密碼",
    "verification",
    "verification code",
    "otp",
    "passcode",
    "code",
  ]);

  function units(text) {
    const out = [];
    const s = text == null ? "" : String(text);
    for (const ch of s) out.push(ch);
    return out;
  }

  /** selected: null | {start,end} inclusive. Returns same shape. */
  function toggle(selected, i, n) {
    if (i < 0 || i >= n) return selected;
    if (selected == null) return { start: i, end: i };
    const start = selected.start;
    const end = selected.end;
    if (i === start) return start === end ? null : { start: start + 1, end };
    if (i === end) return { start, end: end - 1 };
    if (i > start && i < end) return null;
    if (i === start - 1) return { start: i, end };
    if (i === end + 1) return { start, end: i };
    return selected;
  }

  function joined(u, range) {
    if (range == null || !u || !u.length) return "";
    const from = Math.max(0, Math.min(range.start, u.length));
    const to = Math.max(from, Math.min(range.end + 1, u.length));
    return u.slice(from, to).join("");
  }

  function isUsefulBracketLabel(raw) {
    const t = String(raw || "").trim();
    if (!t || t.length > 24) return false;
    if ([...t].every((c) => /\d/.test(c) || /\s/.test(c))) return false;
    if (SKIP_INNER.has(t.toLowerCase()) || SKIP_INNER.has(t)) return false;
    for (const skip of SKIP_INNER) {
      if (t.toLowerCase() === skip.toLowerCase()) return false;
    }
    return true;
  }

  function firstBracketInner(u) {
    if (!u || !u.length) return null;
    let i = 0;
    while (i < u.length) {
      const close = OPEN_TO_CLOSE[u[i]];
      if (close == null) {
        i++;
        continue;
      }
      let j = -1;
      for (let k = i + 1; k < u.length; k++) {
        if (u[k] === close) {
          j = k;
          break;
        }
      }
      if (j > i + 1) {
        const inner = { start: i + 1, end: j - 1 };
        const text = joined(u, inner);
        if (isUsefulBracketLabel(text)) return inner;
        i = j + 1;
        continue;
      }
      i++;
    }
    return null;
  }

  function rangeOf(u, needle) {
    const n = String(needle || "").trim();
    if (!n || !u || !u.length) return null;
    const hay = u.join("");
    const i = hay.toLowerCase().indexOf(n.toLowerCase());
    if (i < 0) return null;
    const endChar = i + n.length;
    let off = 0;
    let startU = -1;
    let endU = -1;
    for (let ui = 0; ui < u.length; ui++) {
      const next = off + u[ui].length;
      if (startU < 0 && i < next) startU = ui;
      if (endChar > off) endU = ui;
      if (endChar <= next && startU >= 0) break;
      off = next;
    }
    if (startU < 0 || endU < 0 || startU > endU) return null;
    return { start: startU, end: endU };
  }

  function normalizeLabel(raw) {
    return String(raw || "")
      .trim()
      .replace(/\s+/g, " ");
  }

  /** Useful 【】/[]/「」 inner text, or null. */
  function bracketLabel(body) {
    const u = units(body);
    const inner = firstBracketInner(u);
    if (!inner) return null;
    const label = normalizeLabel(joined(u, inner));
    return label || null;
  }

  global.ContiguousPick = {
    units,
    toggle,
    joined,
    firstBracketInner,
    bracketLabel,
    rangeOf,
    normalizeLabel,
  };
})(typeof window !== "undefined" ? window : globalThis);

/* UserLabel + RelatedPick — port of PhoneBindTracker classifier helpers (demo) */
(function (global) {
  function normalize(raw) {
    return String(raw || "")
      .trim()
      .replace(/\s+/g, " ");
  }

  function bodyContains(body, raw) {
    const n = normalize(raw);
    if (!n) return false;
    return String(body || "").toLowerCase().indexOf(n.toLowerCase()) >= 0;
  }

  function digitsOf(raw) {
    let out = "";
    for (const c of String(raw || "")) {
      if (c >= "0" && c <= "9") out += c;
    }
    return out;
  }

  /** Same sending address. Digits match so +10086 and 10086 are one sender. */
  function sameSender(a, b) {
    const left = String(a || "").trim();
    const right = String(b || "").trim();
    if (!left || !right) return false;
    if (left.toLowerCase() === right.toLowerCase()) return true;
    const da = digitsOf(left);
    const db = digitsOf(right);
    return da.length >= 3 && da === db;
  }

  function nameMarks(body, raw) {
    const n = normalize(raw);
    const s = String(body || "");
    if (!n || !s) return [];
    const lower = s.toLowerCase();
    const needle = n.toLowerCase();
    const marks = [];
    let from = 0;
    while (from <= lower.length - needle.length) {
      const i = lower.indexOf(needle, from);
      if (i < 0) break;
      marks.push({ start: i, end: i + n.length });
      from = i + n.length;
    }
    return marks;
  }

  const UserLabel = { normalize, bodyContains, sameSender, nameMarks };

  /** Body hits first, then other messages from the seed's sender. Seed stays first. */
  const RelatedPick = {
    LIMIT: 101,
    pick(name, seed, others, limit) {
      const lim = limit == null ? RelatedPick.LIMIT : limit;
      const named = [];
      const same = [];
      const seen = new Set();
      if (seed && seed.id != null) seen.add(seed.id);
      for (const row of others || []) {
        if (!row || row.id == null || seen.has(row.id)) continue;
        seen.add(row.id);
        if (UserLabel.bodyContains(row.body, name)) named.push(row);
        else if (seed && UserLabel.sameSender(row.address, seed.address)) same.push(row);
      }
      named.sort((a, b) => (b.dateMs || 0) - (a.dateMs || 0));
      same.sort((a, b) => (b.dateMs || 0) - (a.dateMs || 0));
      const out = [];
      if (seed) out.push(seed);
      for (const row of named) {
        if (out.length >= lim) return out;
        out.push(row);
      }
      for (const row of same) {
        if (out.length >= lim) return out;
        out.push(row);
      }
      return out;
    },
  };

  global.UserLabel = UserLabel;
  global.RelatedPick = RelatedPick;
})(typeof window !== "undefined" ? window : globalThis);
