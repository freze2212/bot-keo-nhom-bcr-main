/**
 * Lobby baccarat: parse mã bàn, list card, click đúng mã, random N mã unique.
 * Dùng chung cho session + scripts/local-click-table.cjs
 */

function normTableCode(c) {
  if (!c) return "";
  const u = String(c).toUpperCase().trim();
  const m = u.match(/C?0*(\d+)/);
  return m ? `C${m[1].padStart(2, "0")}` : u;
}

function parseTableCode(txt) {
  const t = String(txt || "");
  const m1 = t.match(/Baccarat\s+(C\d+)/i);
  if (m1) return normTableCode(m1[1]);
  const m2 = t.match(/BTCB(\d+)/i);
  if (m2) return normTableCode(`C${m2[1]}`);
  const m3 = t.match(/\b(C\d{1,3})\b/i);
  if (m3) return normTableCode(m3[1]);
  return null;
}

/** Chạy trong page/frame.evaluate — trả list { code, text } unique */
function listTablesInDocumentEval() {
  const parseCode = (txt) => {
    const t = String(txt || "");
    const m1 = t.match(/Baccarat\s+(C\d+)/i);
    if (m1) return m1[1].toUpperCase();
    const m2 = t.match(/BTCB(\d+)/i);
    if (m2) return `C${String(m2[1]).padStart(2, "0")}`;
    const m3 = t.match(/\b(C\d{1,3})\b/i);
    if (m3) return m3[1].toUpperCase();
    return null;
  };
  const norm = (c) => {
    if (!c) return "";
    const u = String(c).toUpperCase();
    const m = u.match(/C?0*(\d+)/);
    return m ? `C${m[1].padStart(2, "0")}` : u;
  };

  const cards = Array.from(
    document.querySelectorAll(
      ".vue-recycle-scroller__item-view, .table-item, div.relative.cursor-pointer, [class*='card']"
    )
  );
  const seen = new Map();
  for (const card of cards) {
    const raw = card.innerText || card.textContent || "";
    const code = norm(parseCode(raw));
    if (!code || !/^C\d+$/.test(code)) continue;
    if (!seen.has(code)) {
      seen.set(code, {
        code,
        text: raw.replace(/\s+/g, " ").trim().slice(0, 80),
      });
    }
  }

  // Fallback: scan text nodes nếu scroller chưa đủ card
  if (seen.size < 3) {
    for (const el of document.querySelectorAll("div, span, button, a")) {
      const raw = (el.innerText || el.textContent || "").trim();
      if (raw.length > 120) continue;
      const code = norm(parseCode(raw));
      if (!code || !/^C\d+$/.test(code)) continue;
      if (!seen.has(code)) {
        seen.set(code, { code, text: raw.replace(/\s+/g, " ").slice(0, 80) });
      }
    }
  }

  return Array.from(seen.values()).sort((a, b) => {
    const na = parseInt(a.code.replace(/\D/g, ""), 10);
    const nb = parseInt(b.code.replace(/\D/g, ""), 10);
    return na - nb;
  });
}

/** Click card/text khớp prefer. allowFallback=false → miss nếu không thấy. */
function clickTableByCodeEval({ prefer, allowFallback }) {
  const parseCode = (txt) => {
    const t = String(txt || "");
    const m1 = t.match(/Baccarat\s+(C\d+)/i);
    if (m1) return m1[1].toUpperCase();
    const m2 = t.match(/BTCB(\d+)/i);
    if (m2) return `C${String(m2[1]).padStart(2, "0")}`;
    const m3 = t.match(/\b(C\d{1,3})\b/i);
    if (m3) return m3[1].toUpperCase();
    return null;
  };
  const norm = (c) => {
    if (!c) return "";
    const u = String(c).toUpperCase();
    const m = u.match(/C?0*(\d+)/);
    return m ? `C${m[1].padStart(2, "0")}` : u;
  };
  const want = prefer ? norm(prefer) : null;

  const clickEl = (el) => {
    const code = norm(parseCode(el.innerText || el.textContent || ""));
    try {
      el.scrollIntoView({ block: "center", inline: "center" });
    } catch (_) {}
    const evt = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      view: window,
    });
    el.dispatchEvent(evt);
    if (el.click) el.click();
    return code;
  };

  const tableCards = Array.from(
    document.querySelectorAll(
      ".vue-recycle-scroller__item-view, .table-item, div.relative.cursor-pointer, [class*='card']"
    )
  );

  if (want) {
    for (const card of tableCards) {
      const code = norm(parseCode(card.innerText || card.textContent || ""));
      if (code === want) {
        clickEl(card);
        return { ok: true, table: code, via: "by_code_card" };
      }
    }
    const match = Array.from(
      document.querySelectorAll("div, span, button, a")
    ).find((el) => {
      const code = norm(parseCode(el.innerText || el.textContent || ""));
      return code === want;
    });
    if (match) {
      const code = clickEl(match);
      return { ok: true, table: code, via: "by_code_text" };
    }
    if (!allowFallback) {
      return { ok: false, table: null, via: "miss" };
    }
  }

  if (tableCards.length > 0) {
    const card = tableCards[0];
    const code = clickEl(card);
    return { ok: true, table: code, via: "fallback_first" };
  }
  return { ok: false, table: null, via: "empty" };
}

function pickRandomUnique(codes, count, exclude = []) {
  const ex = new Set((exclude || []).map(normTableCode).filter(Boolean));
  const pool = [...new Set((codes || []).map(normTableCode).filter(Boolean))].filter(
    (c) => !ex.has(c)
  );
  const n = Math.min(Math.max(0, count), pool.length);
  const shuffled = [...pool];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, n);
}

/**
 * Scroll lobby scroller vài lần rồi list bàn (Playwright frame).
 */
async function listTablesFromFrame(frame, { scrolls = 4 } = {}) {
  if (!frame) return [];
  const all = new Map();
  for (let i = 0; i < scrolls; i++) {
    const batch = await frame.evaluate(listTablesInDocumentEval).catch(() => []);
    for (const row of batch || []) {
      if (row?.code) all.set(normTableCode(row.code), row);
    }
    await frame
      .evaluate(() => {
        const scroller =
          document.querySelector(".vue-recycle-scroller") ||
          document.querySelector("[class*='recycle']") ||
          document.scrollingElement;
        if (scroller) scroller.scrollTop = (scroller.scrollTop || 0) + 400;
      })
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 400));
  }
  // scroll back top
  await frame
    .evaluate(() => {
      const scroller =
        document.querySelector(".vue-recycle-scroller") ||
        document.querySelector("[class*='recycle']") ||
        document.scrollingElement;
      if (scroller) scroller.scrollTop = 0;
    })
    .catch(() => {});

  return Array.from(all.values()).sort((a, b) => {
    const na = parseInt(a.code.replace(/\D/g, ""), 10);
    const nb = parseInt(b.code.replace(/\D/g, ""), 10);
    return na - nb;
  });
}

async function clickTableByCode(frame, tableCode, { allowFallback = false } = {}) {
  if (!frame) return { ok: false, table: null, via: "no_frame" };
  const prefer = normTableCode(tableCode);
  // Virtual scroller chỉ render các card đang nhìn thấy. Cuộn toàn sảnh để
  // click đúng bàn đã được server xếp hạng, không fallback sang bàn ngẫu nhiên.
  for (let i = 0; i < 14; i++) {
    const result = await frame
      .evaluate(clickTableByCodeEval, { prefer, allowFallback: false })
      .catch(() => ({ ok: false, table: null }));
    if (result?.ok) return result;
    await frame
      .evaluate(() => {
        const scroller =
          document.querySelector(".vue-recycle-scroller") ||
          document.querySelector("[class*='recycle']") ||
          document.scrollingElement;
        if (scroller) scroller.scrollTop = (scroller.scrollTop || 0) + 400;
      })
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 250));
  }
  await frame
    .evaluate(() => {
      const scroller =
        document.querySelector(".vue-recycle-scroller") ||
        document.querySelector("[class*='recycle']") ||
        document.scrollingElement;
      if (scroller) scroller.scrollTop = 0;
    })
    .catch(() => {});
  if (!allowFallback) return { ok: false, table: null, via: "not_found" };
  return frame.evaluate(clickTableByCodeEval, {
    prefer,
    allowFallback: true,
  });
}

module.exports = {
  normTableCode,
  parseTableCode,
  listTablesInDocumentEval,
  clickTableByCodeEval,
  pickRandomUnique,
  listTablesFromFrame,
  clickTableByCode,
};
