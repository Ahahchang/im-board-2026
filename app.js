// 內專 2026 重點筆記 — 單頁應用（無需建置）
const CFG = window.APP_CONFIG || {};
const CATEGORIES = ["心臟", "胸腔", "腸胃肝膽", "腎臟", "內分泌新陳代謝", "血液腫瘤", "感染", "風濕免疫過敏", "神經", "精神", "皮膚", "重症急診", "綜合其他"];
const STATUS = { unread: "未讀", read: "已讀", reviewed: "已複習" };

const LEGEND = [["r", "紅", "考古題考過（後面註明年份，例如「考113」）"], ["p", "紫", "講師強調、必背"], ["o", "橘", "數字、cut-off、診斷標準、分期、劑量"], ["b", "藍", "藥物、治療、首選處置"], ["g", "綠", "口訣、鑑別診斷、對比記憶"]];
const $ = (s, el = document) => el.querySelector(s);
const view = $("#view");

let LIB = { docs: [], generated: null };
let DOCS = new Map();          // id -> doc (meta + body)
let STATE = {};                // id -> firestore state（公開：進度、分類、標籤、星號）
let PRIVATE = {};              // id -> { note }（只有擁有者讀得到）
let privateReady = false;      // 私人筆記第一次載入完成
let editing = null;            // 正在編輯「我的筆記」的講義 id
let user = null;
let fb = null;                 // firebase handles
let filterCat = "全部";

/* ---------------- utils ---------------- */
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function hash(s) { let h = 2166136261; for (const ch of s) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); }
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove("show"), 1800); }
const isOwner = () => !!user && user.email === CFG.OWNER_EMAIL;
const st = id => STATE[id] || {};
const catOf = d => st(d.id).category || d.category || "綜合其他";
const tagsOf = d => st(d.id).tags || d.tags || [];
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

/* ---------------- markdown with colors ---------------- */
// 語法：# 大標 / ## 中標 / ### 小標 / - 條列（2 空白縮排一層）/ | 表格 | / > 提示
// 顏色：{{r|考古題}} {{p|講師強調}} {{o|數字標準}} {{b|藥物治療}} {{g|口訣鑑別}}；**粗體**；![說明](img/x.webp)
function inline(s) {
  let h = esc(s);
  for (let i = 0; i < 2; i++) h = h.replace(/\{\{([robgp])\|((?:(?!\{\{|\}\}).)+)\}\}/g, '<span class="c c-$1">$2</span>');
  h = h.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  return h;
}
function stripInline(s) { return s.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\{\{[robgp]\|/g, "").replace(/\}\}/g, "").replace(/\*\*/g, ""); }

/* ---------------- 我的筆記（私人）---------------- */
// 語法：**粗體**、__底線__、{{紅|文字}}；圖片獨立一行 ![](noteimg:<id>)
const PEN = { 紅: "red", 橘: "orange", 黃: "yellow", 綠: "green", 藍: "blue", 紫: "purple", 粉: "pink", 灰: "gray" };
const PEN_RE = new RegExp(`\\{\\{(${Object.keys(PEN).join("|")})\\|((?:(?!\\{\\{|\\}\\}).)+)\\}\\}`, "g");
const NIMG_RE = /^!\[\]\(noteimg:([\w-]+)\)$/;
function inlineMine(s) {
  let h = esc(s);
  for (let i = 0; i < 3; i++) h = h.replace(PEN_RE, (_, c, t) => `<span class="pen pen-${PEN[c]}">${t}</span>`);
  return h.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/__(.+?)__/g, "<u>$1</u>");
}
function renderMine(text) {
  return text.replace(/\r/g, "").split("\n").map(line => {
    const m = line.trim().match(NIMG_RE);
    return m ? `<img class="nimg" data-nimg="${esc(m[1])}" alt="我的圖片">` : `<div>${inlineMine(line) || "<br>"}</div>`;
  }).join("");
}
const stripMine = s => s.replace(/!\[\]\(noteimg:[\w-]+\)/g, "［圖片］").replace(new RegExp(`\\{\\{(${Object.keys(PEN).join("|")})\\|`, "g"), "").replace(/\}\}|\*\*|__/g, "");

// 解析成區塊：同時供渲染與搜尋使用
function parse(doc) {
  if (doc._parsed) return doc._parsed;
  const lines = doc.body.replace(/\r/g, "").split("\n");
  const out = []; const heads = []; const path = ["", "", ""];
  let i = 0;
  const cur = () => path.filter(Boolean);
  while (i < lines.length) {
    const line = lines[i];
    let m;
    if (!line.trim()) { i++; continue; }
    if ((m = line.match(/^(#{1,3})\s+(.+)$/))) {
      const lv = m[1].length; path[lv - 1] = stripInline(m[2]); for (let k = lv; k < 3; k++) path[k] = "";
      const id = "h" + hash(doc.id + "|" + cur().join(">"));
      const hd = { type: "h", lv, text: m[2], id, path: cur() };
      out.push(hd); heads.push(hd); i++; continue;
    }
    if ((m = line.trim().match(/^!\[(.*?)\]\((\S+?)\)$/))) {
      out.push({ type: "img", alt: m[1], src: m[2], path: cur(), text: m[1] }); i++; continue;
    }
    if (line.trim().startsWith("|")) {
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) { rows.push(lines[i].trim()); i++; }
      const cells = r => r.replace(/\{\{([robgp])\|/g, "{{$1\u0001").replace(/^\||\|$/g, "").split("|").map(c => c.trim().replace(/\u0001/g, "|"));
      const body = rows.filter(r => !/^\|[\s:|-]+\|$/.test(r)).map(cells);
      out.push({ type: "table", rows: body, path: cur(), text: body.map(r => r.join(" ")).join("\n") }); continue;
    }
    if (line.startsWith(">")) {
      const buf = [];
      while (i < lines.length && lines[i].startsWith(">")) { buf.push(lines[i].replace(/^>\s?/, "")); i++; }
      out.push({ type: "quote", text: buf.join("\n"), path: cur() }); continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) {
        const mm = lines[i].match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
        items.push({ depth: Math.floor(mm[1].replace(/\t/g, "  ").length / 2), text: mm[3] }); i++;
        while (i < lines.length && lines[i].trim() && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*]|\d+\.)\s+/.test(lines[i])) { items[items.length - 1].text += " " + lines[i].trim(); i++; }
      }
      out.push({ type: "list", items, path: cur(), text: items.map(x => x.text).join("\n") }); continue;
    }
    const buf = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,3}\s|\||>|!\[|\s*([-*]|\d+\.)\s)/.test(lines[i])) { buf.push(lines[i]); i++; }
    out.push({ type: "p", text: buf.join(" "), path: cur() });
  }
  return (doc._parsed = { blocks: out, heads });
}

function renderBlocks(doc) {
  const { blocks } = parse(doc);
  const stars = st(doc.id).stars || {};
  let h = "";
  for (const b of blocks) {
    if (b.type === "h") {
      if (b.lv === 3) {
        const on = !!stars[b.id];
        h += `<h3 id="${b.id}"><span class="ht">${inline(b.text)}</span><button class="star${on ? " on" : ""}" data-hid="${b.id}" aria-label="標記為弱點" title="標記為弱點">${on ? "★" : "☆"}</button></h3>`;
      } else h += `<h${b.lv} id="${b.id}">${inline(b.text)}</h${b.lv}>`;
    } else if (b.type === "p") h += `<p>${inline(b.text)}</p>`;
    else if (b.type === "img") {
      const src = /^https?:/.test(b.src) ? b.src : "data/" + b.src.replace(/^\/+/, "");
      const wh = (doc.imgs || {})[b.src.replace(/^\/+/, "")];
      h += `<figure><a href="${esc(src)}" target="_blank" rel="noopener"><img loading="lazy" src="${esc(src)}"${wh ? ` width="${wh[0]}" height="${wh[1]}"` : ""} alt="${esc(stripInline(b.alt))}"></a>${b.alt ? `<figcaption>${inline(b.alt)}</figcaption>` : ""}</figure>`;
    }
    else if (b.type === "quote") h += `<blockquote>${b.text.split("\n").map(inline).join("<br>")}</blockquote>`;
    else if (b.type === "table") {
      const [head, ...rest] = b.rows;
      h += `<div class="tablewrap"><table><thead><tr>${(head || []).map(c => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${rest.map(r => `<tr>${r.map(c => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
    } else if (b.type === "list") {
      let depth = -1;
      for (const it of b.items) {
        const dd = Math.min(it.depth, depth + 1);
        if (dd > depth) { h += "<ul><li>"; depth = dd; }
        else { while (depth > dd) { h += "</li></ul>"; depth--; } h += "</li><li>"; }
        h += inline(it.text);
      }
      while (depth >= 0) { h += "</li></ul>"; depth--; }
    }
  }
  return h;
}

/* ---------------- search ---------------- */
const norm = s => stripInline(String(s)).toLowerCase();
function search(q) {
  const terms = norm(q).split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const res = [];
  for (const d of DOCS.values()) {
    const title = norm(d.title + " " + tagsOf(d).join(" ") + " " + catOf(d));
    const titleHit = terms.every(t => title.includes(t));
    let hits = 0;
    for (const b of parse(d).blocks) {
      const hay = norm(b.path.join(" ") + " " + (b.type === "h" ? "" : b.text));
      if (b.type !== "h" && terms.every(t => hay.includes(t))) {
        const heading = parse(d).heads.filter(x => b.path.length && x.path.join(">") === b.path.join(">")).pop();
        res.push({ d, path: b.path, hid: heading?.id, snip: stripInline(b.text), score: (titleHit ? 2 : 0) + (norm(b.path.join(" ")).includes(terms[0]) ? 1 : 0) });
        if (++hits >= 30) break;
      }
    }
    const note = stripMine(PRIVATE[d.id]?.note || "");
    if (note && terms.every(t => note.toLowerCase().includes(t))) res.push({ d, path: ["我的筆記"], hid: "mynote", snip: note, score: 3 });
    if (titleHit && !hits) res.push({ d, path: [], hid: null, snip: "（講義名稱符合）", score: 1 });
  }
  return res.sort((a, b) => b.score - a.score).slice(0, 150);
}
function snippet(text, terms, len = 90) {
  const low = text.toLowerCase(); let at = Math.max(0, ...terms.map(t => low.indexOf(t)).filter(x => x >= 0).slice(0, 1));
  const start = Math.max(0, at - 30); let s = text.slice(start, start + len);
  if (start > 0) s = "…" + s; if (start + len < text.length) s += "…";
  return highlight(esc(s), terms);
}
function highlight(html, terms) {
  for (const t of terms) { if (!t) continue; const re = new RegExp("(" + t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")", "gi"); html = html.replace(/(>[^<]*)|(^[^<]*)/g, seg => seg.replace(re, "<mark>$1</mark>")); }
  return html;
}
function markInDom(root, terms) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = []; while (walker.nextNode()) nodes.push(walker.currentNode);
  const re = new RegExp("(" + terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")", "gi");
  for (const n of nodes) {
    if (!re.test(n.nodeValue)) continue; re.lastIndex = 0;
    const span = document.createElement("span");
    span.innerHTML = esc(n.nodeValue).replace(re, "<mark>$1</mark>");
    n.replaceWith(...span.childNodes);
  }
}

/* ---------------- 閱讀位置 ---------------- */
// 記住每份講義看到哪個標題（以標題為錨點，圖片載入也不會跑位），切到其他分頁再回來時接著看
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 私密模式等情況下略過 */ } },
};
const TOP = 64; // 上方固定列的高度
const onDocRoute = () => /^#\/d\//.test(location.hash);
const docIdFromHash = () => { const m = location.hash.match(/^#\/d\/([^/?]+)/); return m ? decodeURIComponent(m[1]) : null; };
function savePos() {
  const id = docIdFromHash();
  if (!id || !DOCS.has(id) || !$("#note")) return;
  let anchor = null;
  for (const el of view.querySelectorAll(".note h1[id], .note h2[id], .note h3[id], #mynote")) {
    if (el.getBoundingClientRect().top <= TOP + 4) anchor = el; else break;
  }
  store.set("pos:" + id, anchor ? { hid: anchor.id, off: Math.round(anchor.getBoundingClientRect().top), y: Math.round(scrollY) } : { y: Math.round(scrollY) });
  store.set("lastDoc", id);
}
function restorePos(id) {
  const pos = store.get("pos:" + id);
  const el = pos?.hid && document.getElementById(pos.hid);
  if (el) window.scrollTo(0, el.getBoundingClientRect().top + scrollY - pos.off);
  else window.scrollTo(0, pos?.y || 0);
}
let posTimer;
window.addEventListener("scroll", () => { clearTimeout(posTimer); posTimer = setTimeout(savePos, 150); }, { passive: true });

/* ---------------- views ---------------- */
function setTab(name) { document.querySelectorAll(".tabbar a").forEach(a => a.classList.toggle("active", a.dataset.tab === name)); }

function homeView() {
  setTab("home");
  const docs = [...DOCS.values()];
  const cats = ["全部", ...CATEGORIES.filter(c => docs.some(d => catOf(d) === c)), ...new Set(docs.map(catOf).filter(c => !CATEGORIES.includes(c)))];
  const shown = docs.filter(d => filterCat === "全部" || catOf(d) === filterCat);
  const count = s => docs.filter(d => (st(d.id).status || "unread") === s).length;
  let h = "";
  const last = store.get("lastDoc");
  if (last && DOCS.has(last)) {
    const d = DOCS.get(last), pos = store.get("pos:" + last);
    const head = pos?.hid === "mynote" ? { path: ["我的筆記"] } : parse(d).heads.find(x => x.id === pos?.hid);
    h += `<a class="card resume" href="#/d/${encodeURIComponent(last)}"><span class="t"><small>📖 繼續閱讀</small><b>${esc(d.title)}</b>${head ? `<small>上次看到：${esc(head.path.join(" › "))}</small>` : ""}</span><span class="go">›</span></a>`;
  }
  h += `<div class="chips">${cats.map(c => `<button class="chip${c === filterCat ? " on" : ""}" data-cat="${esc(c)}">${esc(c)}</button>`).join("")}</div>`;
  h += `<div class="stats">共 ${docs.length} 份講義 · 已讀 ${count("read")} · 已複習 ${count("reviewed")}${LIB.generated ? ` · 更新於 ${esc(LIB.generated.slice(0, 10))}` : ""}</div>`;
  if (!docs.length) h += `<p class="pad muted">還沒有整理好的講義。</p>`;
  const groups = {};
  for (const d of shown) (groups[catOf(d)] ||= []).push(d);
  const order = Object.keys(groups).sort((a, b) => (CATEGORIES.indexOf(a) + 99) % 199 - (CATEGORIES.indexOf(b) + 99) % 199);
  for (const g of order) {
    h += `<section class="group"><h2>${esc(g)}（${groups[g].length}）</h2>`;
    for (const d of groups[g].sort((a, b) => a.title.localeCompare(b.title, "zh-Hant"))) {
      const s = st(d.id).status || "unread"; const nStar = Object.keys(st(d.id).stars || {}).length;
      h += `<a class="card" href="#/d/${encodeURIComponent(d.id)}"><span class="dot ${s}" title="${STATUS[s]}"></span><span class="t"><b>${esc(d.title)}</b><small>${STATUS[s]}${nStar ? ` · ★${nStar}` : ""}${tagsOf(d).length ? " · " + esc(tagsOf(d).slice(0, 4).join("、")) : ""}</small></span></a>`;
    }
    h += `</section>`;
  }
  view.innerHTML = h;
  view.querySelectorAll(".chip").forEach(b => b.onclick = () => { filterCat = b.dataset.cat; homeView(); });
  window.scrollTo(0, 0);
}

function docView(id, hid, q) {
  setTab("home");
  const d = DOCS.get(id);
  if (!d) { view.innerHTML = `<p class="pad">找不到這份講義。<a href="#/">回首頁</a></p>`; return; }
  const s = st(id); const status = s.status || "unread";
  const { heads } = parse(d);
  const toc = heads.filter(x => x.lv <= 3);
  let h = `<div class="dochead"><h1>${esc(d.title)}</h1><div class="meta"><span class="tag">${esc(catOf(d))}</span>${tagsOf(d).map(t => `<span class="tag">#${esc(t)}</span>`).join("")}<span>整理於 ${esc(d.summarized || "")}</span></div></div>`;
  h += `<div class="toolbar"><div class="seg" id="statusSeg">${Object.entries(STATUS).map(([k, v]) => `<button data-s="${k}" class="${k === status ? "on" : ""}">${v}</button>`).join("")}</div>`;
  if (isOwner() && d.id && !d.id.startsWith("sample")) h += `<a class="btn" target="_blank" rel="noopener" href="https://drive.google.com/file/d/${encodeURIComponent(d.id)}/view">開啟原始檔案</a>`;
  h += `</div>`;
  h += `<div class="legendbar">${LEGEND.map(([k, n, d]) => `<span class="c c-${k}" title="${esc(d)}">${n}：${esc(d.split("（")[0].split("、")[0])}</span>`).join("")}<a href="#/legend">完整說明</a></div>`;
  if (toc.length > 2) h += `<details class="toc"><summary>目錄（${toc.length}）</summary><ol>${toc.map(x => `<li class="l${x.lv}"><a href="#/d/${encodeURIComponent(id)}/${x.id}">${esc(stripInline(x.text))}</a></li>`).join("")}</ol></details>`;
  h += `<article class="note" id="note">${renderBlocks(d)}</article>`;
  h += `<section class="mynote" id="mynote"><h2>我的筆記</h2>`;
  if (isOwner()) {
    const note = PRIVATE[id]?.note || "";
    if (editing === id) {
      h += `<div class="pens" id="pens">
        <button data-wrap="**" title="粗體"><b>B</b></button><button data-wrap="__" title="底線"><u>U</u></button>
        ${Object.entries(PEN).map(([n, c]) => `<button data-pen="${n}" class="sw pen-${c}" title="${n}色" aria-label="${n}色">${n}</button>`).join("")}
        <button id="imgBtn" title="加入圖片">📷 圖片</button><input type="file" id="imgFile" accept="image/*" multiple hidden>
      </div>
      <textarea id="noteBox" placeholder="寫下易錯點、補充…（可直接貼上截圖；自動同步到你所有裝置）">${esc(note)}</textarea>
      <div class="row"><button class="btn" id="doneBtn">完成</button><span class="muted" id="saveHint"></span></div>
      <div class="mine preview" id="notePreview">${renderMine(note)}</div>`;
    } else {
      h += note.trim() ? `<div class="mine" id="noteView">${renderMine(note)}</div>` : `<p class="muted">還沒有筆記。</p>`;
      h += `<div class="row"><button class="btn" id="editBtn">${note.trim() ? "編輯" : "寫筆記"}</button><span class="muted">🔒 只有你登入後看得到</span></div>`;
    }
    h += `<div class="row"><label>科別 <select id="catSel">${[...new Set([...CATEGORIES, catOf(d)])].map(c => `<option${c === catOf(d) ? " selected" : ""}>${esc(c)}</option>`).join("")}</select></label>
      <label>標籤 <input id="tagBox" value="${esc(tagsOf(d).join(", "))}" placeholder="以逗號分隔"></label></div>`;
  } else h += `<p class="muted">🔒 我的筆記只有擁有者登入後才看得到。</p>`;
  h += `</section>`;
  view.innerHTML = h;

  $("#statusSeg").onclick = e => { const b = e.target.closest("button"); if (b) save(id, { status: b.dataset.s }); };
  $("#note").onclick = e => { const b = e.target.closest(".star"); if (b) toggleStar(d, b.dataset.hid); };
  if (isOwner()) {
    $("#catSel").onchange = e => save(id, { category: e.target.value });
    $("#tagBox").onchange = e => save(id, { tags: e.target.value.split(/[,，、]/).map(x => x.trim()).filter(Boolean) });
    if (editing === id) bindEditor(id); else if ($("#editBtn")) $("#editBtn").onclick = () => { editing = id; docView(id, "mynote"); $("#noteBox").focus(); };
    loadNoteImages($("#mynote"));
  }
  if (q) markInDom($("#note"), norm(q).split(/\s+/).filter(Boolean));
  if (hid) {
    const el = document.getElementById(hid);
    if (el) { el.scrollIntoView({ block: "start" }); el.classList.add("flash"); }
  } else restorePos(id);
  store.set("lastDoc", id);
}

function bindEditor(id) {
  const box = $("#noteBox"), hint = $("#saveHint"), prev = $("#notePreview");
  const push = debounce(v => saveNote(id, v).then(ok => { if (ok) hint.textContent = "已同步"; }), 800);
  const changed = () => {
    PRIVATE[id] = { ...PRIVATE[id], note: box.value };
    hint.textContent = "儲存中…"; push(box.value);
    prev.innerHTML = renderMine(box.value); loadNoteImages(prev);
  };
  // 用 insertText 保留「復原」功能；不支援時退回 setRangeText
  const put = (text, selFrom, selTo) => {
    box.focus();
    if (!document.execCommand("insertText", false, text)) box.setRangeText(text, box.selectionStart, box.selectionEnd, "end");
    if (selFrom != null) box.setSelectionRange(selFrom, selTo);
    changed();
  };
  const wrap = (open, close) => {
    const a = box.selectionStart, b = box.selectionEnd, sel = box.value.slice(a, b);
    put(open + sel + close, a + open.length, a + open.length + sel.length);
  };
  box.oninput = changed;
  const pens = $("#pens");
  pens.onmousedown = e => { if (e.target.closest("button")) e.preventDefault(); }; // 按按鈕時不要讓選取消失
  pens.onclick = e => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.wrap) wrap(b.dataset.wrap, b.dataset.wrap);
    else if (b.dataset.pen) wrap(`{{${b.dataset.pen}|`, "}}");
  };
  const addImages = async files => {
    for (const f of files) {
      if (!f.type.startsWith("image/")) continue;
      hint.textContent = "上傳圖片中…";
      try {
        const imgId = await uploadNoteImage(id, f);
        const a = box.selectionStart, before = box.value.slice(0, a);
        put((before && !before.endsWith("\n") ? "\n" : "") + `![](noteimg:${imgId})\n`);
      } catch (e) { console.error(e); toast("圖片上傳失敗：" + (e.code || e.message)); hint.textContent = ""; }
    }
  };
  $("#imgBtn").onclick = () => $("#imgFile").click();
  $("#imgFile").onchange = e => { addImages([...e.target.files]); e.target.value = ""; };
  box.onpaste = e => {
    const files = [...(e.clipboardData?.files || [])].filter(f => f.type.startsWith("image/"));
    if (files.length) { e.preventDefault(); addImages(files); }
  };
  $("#doneBtn").onclick = async () => {
    editing = null;
    await saveNote(id, box.value);
    cleanupNoteImages(id, box.value);
    docView(id, "mynote");
  };
}

// 圖片壓縮成 webp（Safari 不支援時用 jpeg），存成 Firestore 文件（單一文件上限 1 MiB）
async function compressImage(file) {
  const bmp = await createImageBitmap(file);
  for (const [side, q] of [[1600, 0.82], [1400, 0.75], [1200, 0.7], [1000, 0.65], [800, 0.6]]) {
    const k = Math.min(1, side / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas"); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    const ctx = c.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(bmp, 0, 0, c.width, c.height);
    let url = c.toDataURL("image/webp", q);
    if (!url.startsWith("data:image/webp")) url = c.toDataURL("image/jpeg", q);
    if (url.length < 900000) return url;
  }
  throw new Error("圖片太大，請先裁切後再試");
}
async function uploadNoteImage(docId, file) {
  const data = await compressImage(file);
  const imgId = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random()).replace(/[^\w]/g, "").slice(0, 24);
  await fb.setDoc(fb.doc(fb.db, "noteImages", imgId), { docId, data, createdAt: fb.serverTimestamp() });
  IMG_CACHE.set(imgId, data);
  return imgId;
}
const IMG_CACHE = new Map();
function loadNoteImages(root) {
  if (!root || !fb) return;
  root.querySelectorAll("img[data-nimg]").forEach(async img => {
    const k = img.dataset.nimg;
    img.onclick = () => openLightbox(img.src);
    if (!IMG_CACHE.has(k)) {
      try { const s = await fb.getDoc(fb.doc(fb.db, "noteImages", k)); IMG_CACHE.set(k, s.exists() ? s.data().data : ""); }
      catch (e) { console.warn(e); return; }
    }
    if (IMG_CACHE.get(k)) img.src = IMG_CACHE.get(k); else img.alt = "（圖片已刪除）";
  });
}
function openLightbox(src) {
  if (!src) return;
  const box = document.createElement("div"); box.className = "lightbox";
  box.innerHTML = `<img src="${esc(src)}" alt="">`;
  box.onclick = () => box.remove();
  document.body.append(box);
}
// 按「完成」時，把筆記裡已經刪掉的圖片從資料庫清掉
async function cleanupNoteImages(docId, text) {
  try {
    const snap = await fb.getDocs(fb.query(fb.collection(fb.db, "noteImages"), fb.where("docId", "==", docId)));
    for (const s of snap.docs) if (!text.includes(`noteimg:${s.id})`)) { await fb.deleteDoc(s.ref); IMG_CACHE.delete(s.id); }
  } catch (e) { console.warn("cleanup", e); }
}

function searchView(q) {
  setTab("");
  $("#q").value = q;
  const terms = norm(q).split(/\s+/).filter(Boolean);
  const res = search(q);
  let h = `<p class="stats">「${esc(q)}」找到 ${res.length} 筆${res.length >= 150 ? "（只顯示前 150 筆）" : ""}</p>`;
  for (const r of res) {
    const link = `#/d/${encodeURIComponent(r.d.id)}${r.hid ? "/" + r.hid : ""}?q=${encodeURIComponent(q)}`;
    h += `<a class="result" href="${link}"><div class="path">${esc(r.d.title)}${r.path.length ? " › " + esc(r.path.join(" › ")) : ""}</div><div class="snip">${snippet(r.snip, terms)}</div></a>`;
  }
  if (!res.length) h += `<p class="pad muted">沒有找到。試試英文縮寫或中文，例如「AF」或「心房顫動」。</p>`;
  view.innerHTML = h; window.scrollTo(0, 0);
}

function weakView() {
  setTab("weak");
  let h = `<p class="stats">在任一小標旁按 ☆ 就會收進這裡。</p>`; let n = 0;
  for (const d of DOCS.values()) {
    const stars = st(d.id).stars || {}; const ids = Object.keys(stars); if (!ids.length) continue;
    const live = new Set(parse(d).heads.map(x => x.id));
    h += `<section class="group"><h2>${esc(d.title)}</h2>`;
    for (const hidKey of ids) {
      n++; const s = stars[hidKey]; const ok = live.has(hidKey);
      h += `<a class="result" href="#/d/${encodeURIComponent(d.id)}${ok ? "/" + hidKey : ""}"><div class="path">${esc((s.path || []).slice(0, -1).join(" › "))}</div><div class="snip">★ ${esc(s.label || "")}${ok ? "" : ' <span class="muted">（講義已更新，此小標已改名）</span>'}</div></a>`;
    }
    h += `</section>`;
  }
  if (!n) h += `<p class="pad muted">還沒有標記任何弱點。</p>`;
  view.innerHTML = h;
}

function legendView() {
  setTab("legend");
  view.innerHTML = `<div class="legend note"><h2>顏色與符號</h2><ul>
  ${LEGEND.map(([k, n, d]) => `<li><span class="c c-${k}">${n}色</span>：${esc(d)}</li>`).join("")}
  <li><strong>粗體</strong>：關鍵字</li>
  <li>☆ / ★：標記「我的弱點」，集中在「我的弱點」頁複習</li></ul>
  <h2>讀書狀態</h2><ul><li><span class="dot" style="display:inline-block"></span> 未讀　<span class="dot read" style="display:inline-block"></span> 已讀　<span class="dot reviewed" style="display:inline-block"></span> 已複習</li></ul>
  <p class="muted">網站每天凌晨自動檢查 Google 雲端硬碟，有新講義或講義修改後會重新整理。</p></div>`;
}

/* ---------------- router ---------------- */
function route() {
  const raw = location.hash.slice(1) || "/";
  const [p, qs] = raw.split("?");
  const params = new URLSearchParams(qs || "");
  const parts = p.split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] !== "d" || parts[1] !== editing) editing = null;
  if (parts[0] === "d") docView(parts[1], parts[2], params.get("q"));
  else if (parts[0] === "search") searchView(params.get("q") || "");
  else if (parts[0] === "weak") weakView();
  else if (parts[0] === "legend") legendView();
  else homeView();
}
window.addEventListener("hashchange", route);
// 「講義」分頁：不在講義裡時，回到上次看的講義與位置；已經在講義裡時，回到講義列表
$('.tabbar a[data-tab="home"]').onclick = e => {
  e.preventDefault();
  const last = store.get("lastDoc");
  location.hash = !onDocRoute() && last && DOCS.has(last) ? "#/d/" + encodeURIComponent(last) : "#/";
};
$("#searchForm").onsubmit = e => { e.preventDefault(); const q = $("#q").value.trim(); if (q) location.hash = "#/search?q=" + encodeURIComponent(q); $("#q").blur(); };

/* ---------------- sync (Firebase) ---------------- */
async function save(id, patch) {
  if (!isOwner()) { toast("請先用你的 Google 帳號登入"); return; }
  STATE[id] = { ...st(id), ...patch }; rerenderSoft();
  try { await fb.setDoc(fb.doc(fb.db, "docs", id), { ...patch, updatedAt: fb.serverTimestamp() }, { merge: true }); }
  catch (e) { console.error(e); toast("同步失敗：" + (e.code || e.message)); }
}
async function saveNote(id, note) {
  if (!isOwner()) { toast("請先用你的 Google 帳號登入"); return false; }
  PRIVATE[id] = { ...PRIVATE[id], note };
  try { await fb.setDoc(fb.doc(fb.db, "private", id), { note, updatedAt: fb.serverTimestamp() }, { merge: true }); return true; }
  catch (e) { console.error(e); toast("同步失敗：" + (e.code || e.message)); return false; }
}
// 舊版把筆記存在公開的 docs/{id}.note：搬到私人的 private/{id}，再從公開文件刪掉
let migrating = false;
async function migrateNotes() {
  if (migrating || !privateReady || !isOwner()) return;
  migrating = true;
  for (const [id, s] of Object.entries(STATE)) {
    if (typeof s.note !== "string") continue;
    try {
      if (s.note.trim() && !PRIVATE[id]?.note && !(await saveNote(id, s.note))) continue; // 搬移失敗就不要刪原本的
      await fb.updateDoc(fb.doc(fb.db, "docs", id), { note: fb.deleteField() });
    } catch (e) { console.warn("migrate", id, e); }
  }
  migrating = false;
}
async function toggleStar(d, hid) {
  if (!isOwner()) { toast("請先登入才能標記"); return; }
  const stars = { ...(st(d.id).stars || {}) };
  if (stars[hid]) delete stars[hid];
  else { const hd = parse(d).heads.find(x => x.id === hid); stars[hid] = { label: stripInline(hd?.text || ""), path: hd?.path || [] }; }
  STATE[d.id] = { ...st(d.id), stars }; rerenderSoft();
  try { await fb.updateDoc(fb.doc(fb.db, "docs", d.id), { stars, updatedAt: fb.serverTimestamp() }); }
  catch { try { await fb.setDoc(fb.doc(fb.db, "docs", d.id), { stars, updatedAt: fb.serverTimestamp() }, { merge: true }); } catch (e) { toast("同步失敗：" + (e.code || e.message)); } }
}
// 資料變動時重畫，但不打斷正在輸入的筆記
function rerenderSoft() {
  const active = document.activeElement;
  if (editing || (active && (active.id === "noteBox" || active.id === "tagBox"))) {
    const hash = location.hash; const m = hash.match(/^#\/d\/([^/?]+)/);
    if (m && DOCS.has(decodeURIComponent(m[1]))) { const d = DOCS.get(decodeURIComponent(m[1])); document.querySelectorAll(".star").forEach(b => { const on = !!(st(d.id).stars || {})[b.dataset.hid]; b.classList.toggle("on", on); b.textContent = on ? "★" : "☆"; });
      const s = st(d.id).status || "unread"; document.querySelectorAll("#statusSeg button").forEach(b => b.classList.toggle("on", b.dataset.s === s)); }
    return;
  }
  const y = window.scrollY; route(); if (!/\/h[0-9a-z]+/.test(location.hash)) window.scrollTo(0, y);
}

async function initFirebase() {
  const btn = $("#authBtn");
  if (!CFG.firebase) { btn.textContent = "未設定同步"; btn.disabled = true; return; }
  const V = "10.12.2";
  const [app, auth, fs] = await Promise.all([
    import(`https://www.gstatic.com/firebasejs/${V}/firebase-app.js`),
    import(`https://www.gstatic.com/firebasejs/${V}/firebase-auth.js`),
    import(`https://www.gstatic.com/firebasejs/${V}/firebase-firestore.js`),
  ]);
  const a = app.initializeApp(CFG.firebase);
  const db = fs.initializeFirestore(a, { localCache: fs.persistentLocalCache({ tabManager: fs.persistentMultipleTabManager() }) });
  const au = auth.getAuth(a);
  fb = { db, doc: fs.doc, setDoc: fs.setDoc, updateDoc: fs.updateDoc, getDoc: fs.getDoc, getDocs: fs.getDocs, deleteDoc: fs.deleteDoc,
    query: fs.query, collection: fs.collection, where: fs.where, deleteField: fs.deleteField, serverTimestamp: fs.serverTimestamp };
  let unsubPrivate = null;
  fs.onSnapshot(fs.collection(db, "docs"), snap => {
    snap.docChanges().forEach(c => { if (c.type === "removed") delete STATE[c.doc.id]; else STATE[c.doc.id] = c.doc.data(); });
    migrateNotes();
    rerenderSoft();
  }, e => console.warn("snapshot", e));
  auth.onAuthStateChanged(au, u => {
    user = u; btn.textContent = u ? (isOwner() ? "已登入" : "非擁有者") : "登入"; btn.classList.toggle("on", isOwner());
    if (u && !isOwner()) toast("這個帳號沒有編輯權限，只能瀏覽");
    if (unsubPrivate) { unsubPrivate(); unsubPrivate = null; }
    PRIVATE = {}; editing = null; privateReady = false;
    if (isOwner()) {
      unsubPrivate = fs.onSnapshot(fs.collection(db, "private"), snap => {
        snap.docChanges().forEach(c => {
          if (c.doc.id === editing) return; // 編輯中以本機內容為準
          if (c.type === "removed") delete PRIVATE[c.doc.id]; else PRIVATE[c.doc.id] = c.doc.data();
        });
        privateReady = true; migrateNotes();
        rerenderSoft();
      }, e => { console.warn("private", e); toast("私人筆記讀取失敗：" + e.code); });
    }
    rerenderSoft();
  });
  btn.onclick = async () => {
    if (user) { if (confirm("要登出嗎？")) auth.signOut(au); return; }
    const prov = new auth.GoogleAuthProvider(); prov.setCustomParameters({ login_hint: CFG.OWNER_EMAIL });
    try { await auth.signInWithPopup(au, prov); } catch (e) { if (e.code === "auth/popup-blocked") auth.signInWithRedirect(au, prov); else toast("登入失敗：" + e.code); }
  };
}

/* ---------------- boot ---------------- */
(async () => {
  try {
    const r = await fetch("data/library.json", { cache: "no-cache" });
    LIB = await r.json();
    DOCS = new Map(LIB.docs.map(d => [d.id, d]));
  } catch (e) { view.innerHTML = `<p class="pad">講義資料載入失敗，請重新整理。</p>`; console.error(e); }
  route();
  initFirebase().catch(e => { console.error(e); toast("同步服務載入失敗"); });
})();
