/* app.js — 主逻辑：书库 / 翻页 / 书签 / 目录 / 设置 */
"use strict";
(() => {

  /* ───────────── 工具 ───────────── */
  const $ = s => document.querySelector(s);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const LS = {
    get(k, d) { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
    del(k) { try { localStorage.removeItem(k); } catch (e) {} },
  };
  const fmtChars = n => n >= 10000 ? (n / 10000).toFixed(1).replace(/\.0$/, "") + " 万字" : n + " 字";
  const fmtDate = ts => new Date(ts).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  function hashHue(str) { let h = 7; for (const c of str) h = (h * 31 + c.codePointAt(0)) >>> 0; return h % 360; }

  const toastEl = $("#toast");
  let toastTimer = 0;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), 1800);
  }

  /* ───────────── 状态与设置 ───────────── */
  const settings = Object.assign(
    { theme: "light", fs: 19, lh: 1.9, serif: true },
    LS.get("sg-settings", {})
  );
  let progressMap = LS.get("sg-progress", {});   // bookId -> {ch, para, pct, ts}
  let bookmarkMap = LS.get("sg-bookmarks", {});  // bookId -> [{id,ch,para,snippet,ts}]
  let books = [];
  let cur = null; // { id, title, author, chapters, cum[], totalChars, paraAcc[], elPages[] }
  let chapterIdx = 0, page = 0, pages = 1, pageWidth = 0, baseLeft = 0, anchorPara = 0;
  let drawerName = null;

  const els = {
    viewLib: $("#view-library"), viewReader: $("#view-reader"),
    grid: $("#lib-grid"), libEmpty: $("#lib-empty"), libStats: $("#lib-stats"),
    search: $("#search"), fileInput: $("#file-input"), dropMask: $("#drop-mask"),
    paper: $("#paper"), content: $("#content"), stage: $("#stage"),
    rBook: $("#r-book"), rChapter: $("#r-chapter"),
    pageInd: $("#page-ind"), pctInd: $("#pct-ind"),
    prevCh: $("#btn-prev-ch"), nextCh: $("#btn-next-ch"),
    drawer: $("#drawer"), drawerTitle: $("#drawer-title"), drawerBody: $("#drawer-body"),
    scrim: $("#scrim"), chromeHint: $("#chrome-hint"),
  };

  function saveSettings() { LS.set("sg-settings", settings); }
  function saveProgress() { LS.set("sg-progress", progressMap); }
  function saveBookmarks() { LS.set("sg-bookmarks", bookmarkMap); }

  function applySettings() {
    document.documentElement.dataset.theme = settings.theme;
    document.documentElement.style.setProperty("--reader-fs", settings.fs + "px");
    document.documentElement.style.setProperty("--reader-lh", settings.lh);
    els.content.classList.toggle("sans", !settings.serif);
  }

  /* ───────────── 书库 ───────────── */
  function renderLibrary() {
    const q = els.search.value.trim();
    const list = books
      .filter(b => !q || b.title.includes(q) || (b.author || "").includes(q))
      .sort((a, b) => (progressMap[b.id]?.ts || 0) - (progressMap[a.id]?.ts || 0) || b.addedAt - a.addedAt);

    const totalChars = books.reduce((n, b) => n + (b.chars || 0), 0);
    els.libStats.textContent = books.length ? `共 ${books.length} 本书 · ${fmtChars(totalChars)}` : "";
    els.libEmpty.classList.toggle("hidden", books.length > 0);

    els.grid.innerHTML = "";
    for (const b of list) {
      const hue = hashHue(b.id);
      const pg = progressMap[b.id];
      const card = document.createElement("article");
      card.className = "card";
      card.innerHTML =
        `<div class="cover" style="--c1:hsl(${hue},42%,44%);--c2:hsl(${(hue + 36) % 360},48%,28%)">${esc(b.title.slice(0, 7))}</div>
         <div class="meta">
           <h3 class="title">${esc(b.title)}</h3>
           <div class="sub">${esc([b.author, b.chCount + " 章", fmtChars(b.chars || 0)].filter(Boolean).join(" · "))}</div>
           <div class="bar"><i style="width:${pg ? pg.pct : 0}%"></i></div>
           <div class="pct">${pg ? `读到 ${pg.pct.toFixed(1)}% · ${fmtDate(pg.ts)}` : "未开始"}</div>
         </div>
         <button class="del" title="删除本书">✕</button>`;
      card.addEventListener("click", () => openBook(b.id));
      card.querySelector(".del").addEventListener("click", ev => { ev.stopPropagation(); removeBook(b); });
      els.grid.appendChild(card);
    }
  }

  async function importFiles(fileList) {
    const files = Array.from(fileList).filter(f => /\.txt$/i.test(f.name));
    if (!files.length) { toast("只支持 .txt 文件"); return; }
    for (const f of files) {
      try {
        const raw = Parser.decode(await f.arrayBuffer());
        const title = Parser.titleFromFilename(f.name);
        await addBook(raw, title, f.size);
        toast(`已导入《${title}》`);
      } catch (e) {
        console.error(e);
        toast(`《${f.name}》导入失败：${e.message}`);
      }
    }
    renderLibrary();
  }

  async function addBook(raw, titleIn, size) {
    let title = titleIn;
    const names = new Set(books.map(b => b.title));
    if (names.has(title)) { let i = 2; while (names.has(`${title} (${i})`)) i++; title = `${title} (${i})`; }
    const parsed = Parser.parse(raw, title);
    const id = "b" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const meta = {
      id, title, author: parsed.author, size: size || raw.length,
      chars: parsed.chars, chCount: parsed.chapters.length, addedAt: Date.now(),
    };
    await DB.putBook(meta);
    await DB.putText(id, raw);
    books.push(meta);
    return meta;
  }

  function removeBook(b) {
    if (!confirm(`确定从书库删除《${b.title}》吗？书签与进度将一并清除。`)) return;
    DB.delBook(b.id).then(() => {
      books = books.filter(x => x.id !== b.id);
      delete progressMap[b.id]; delete bookmarkMap[b.id];
      saveProgress(); saveBookmarks();
      renderLibrary();
      toast(`已删除《${b.title}》`);
    });
  }

  /* ───────────── 阅读器 ───────────── */
  async function openBook(id) {
    const meta = books.find(b => b.id === id);
    if (!meta) return;
    const rec = await DB.getText(id);
    if (!rec) { toast("正文数据丢失，请重新导入"); return; }
    const parsed = Parser.parse(rec.text, meta.title);

    const cum = []; let acc = 0;
    for (const c of parsed.chapters) { cum.push(acc); acc += c.title.length + c.text.length; }
    cur = {
      id, title: meta.title, author: parsed.author || meta.author,
      chapters: parsed.chapters, cum, totalChars: Math.max(acc, 1),
      paraAcc: [], elPages: [],
    };
    els.rBook.textContent = meta.title + (cur.author ? " · " + cur.author : "");
    els.viewLib.classList.add("hidden");
    els.viewReader.classList.remove("hidden");
    closeDrawer();

    const pg = progressMap[id];
    gotoChapter(pg ? clamp(pg.ch, 0, parsed.chapters.length - 1) : 0,
                { para: pg ? pg.para : 0 });
  }

  function backToLibrary() {
    closeDrawer();
    els.viewReader.classList.add("hidden");
    els.viewLib.classList.remove("hidden");
    document.body.classList.remove("no-chrome");
    cur = null;
    renderLibrary();
  }

  function gotoChapter(i, opt = {}) {
    if (!cur) return;
    chapterIdx = clamp(i, 0, cur.chapters.length - 1);
    const ch = cur.chapters[chapterIdx];
    const paras = ch.text.split(/\n+/).map(s => s.trim()).filter(Boolean);

    const isLast = chapterIdx === cur.chapters.length - 1;
    let html = `<h3 class="ch-title">${esc(ch.title)}</h3>`;
    html += paras.map(p => `<p>${esc(p)}</p>`).join("");
    if (isLast) html += `<p class="end-mark">终</p>`;
    els.content.innerHTML = html;

    cur.paraAcc = [];
    let a = 0;
    for (const p of paras) { cur.paraAcc.push(a); a += p.length + 1; }

    els.rChapter.textContent = ch.title;
    els.prevCh.disabled = chapterIdx === 0;
    els.nextCh.disabled = chapterIdx === cur.chapters.length - 1;

    paginate();
    let target = 0;
    const n = cur.elPages.length;
    if (opt.last) target = pages - 1;
    else if (opt.para != null && n) target = cur.elPages[clamp(opt.para, 0, n - 1)] || 0;
    applyPage(target);
    els.content.style.opacity = 1;
  }

  /* —— CSS 多栏 + Range 矩形测量实现真实分页 —— */
  function pageSize() {
    const cs = getComputedStyle(els.paper);
    const w = els.paper.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const h = els.paper.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    return { w: Math.max(240, w), h: Math.max(200, h), gap: w > 460 ? 56 : 34 };
  }

  function colRects(el, contents) {
    const r = document.createRange();
    if (contents) r.selectNodeContents(el); else r.selectNode(el);
    return Array.from(r.getClientRects()).filter(x => x.width > 1 && x.height > 1);
  }

  function paginate() {
    const { w, h, gap } = pageSize();
    pageWidth = w + gap;
    Object.assign(els.content.style, {
      width: w + "px", height: h + "px",
      columnWidth: w + "px", columnGap: gap + "px", columnFill: "auto",
    });

    const rects = colRects(els.content, true);
    baseLeft = rects.length ? rects[0].left : 0;
    const last = rects.length ? rects[rects.length - 1] : null;
    pages = last ? Math.round((last.left - baseLeft) / pageWidth) + 1 : 1;
    pages = Math.max(1, pages);

    cur.elPages = Array.from(els.content.querySelectorAll("p:not(.end-mark)")).map(p => {
      const r = colRects(p, false)[0];
      return r ? Math.round((r.left - baseLeft) / pageWidth) : 0;
    });
  }

  function anchorForPage(p) {
    const list = cur.elPages;
    for (let i = 0; i < list.length; i++) if (list[i] >= p) return i;
    return Math.max(0, list.length - 1);
  }

  function applyPage(p) {
    page = clamp(p, 0, pages - 1);
    els.content.style.transform = `translateX(${-page * pageWidth}px)`;
    anchorPara = anchorForPage(page);

    els.pageInd.textContent = `${page + 1} / ${pages}`;
    const ch = cur.chapters[chapterIdx];
    const readChars = cur.cum[chapterIdx] + ch.title.length + (cur.paraAcc[anchorPara] || 0);
    const pct = clamp(readChars / cur.totalChars * 100, 0, 100);
    els.pctInd.textContent = pct.toFixed(1) + "%";

    progressMap[cur.id] = { ch: chapterIdx, para: anchorPara, pct, ts: Date.now() };
    saveProgress();
  }

  function repaginate() {
    if (!cur) return;
    const anchor = anchorPara;
    paginate();
    applyPage(cur.elPages[anchor] != null ? cur.elPages[anchor] : clamp(page, 0, pages - 1));
  }

  function nextPage() {
    if (!cur) return;
    if (page + 1 < pages) applyPage(page + 1);
    else if (chapterIdx + 1 < cur.chapters.length) gotoChapter(chapterIdx + 1, { para: 0 });
    else toast("已经读到结尾了");
  }
  function prevPage() {
    if (!cur) return;
    if (page > 0) applyPage(page - 1);
    else if (chapterIdx > 0) gotoChapter(chapterIdx - 1, { last: true });
    else toast("已经是第一章了");
  }

  /* —— 书签 —— */
  function currentBookmarks() {
    if (!cur) return [];
    if (!bookmarkMap[cur.id]) bookmarkMap[cur.id] = [];
    return bookmarkMap[cur.id];
  }
  function addBookmark() {
    if (!cur) return;
    const list = currentBookmarks();
    if (list.some(b => b.ch === chapterIdx && b.para === anchorPara)) {
      toast("当前位置已有书签"); openDrawer("bm"); return;
    }
    const ps = els.content.querySelectorAll("p:not(.end-mark)");
    const snippet = (ps[anchorPara]?.textContent || cur.chapters[chapterIdx].title).trim().slice(0, 46);
    list.unshift({ id: Date.now(), ch: chapterIdx, para: anchorPara, snippet, ts: Date.now() });
    saveBookmarks();
    toast("已加入书签");
    if (drawerName === "bm") renderDrawer();
  }
  function jumpTo(bm) {
    closeDrawer();
    gotoChapter(bm.ch, { para: bm.para });
  }

  /* ───────────── 抽屉 ───────────── */
  function openDrawer(name) {
    drawerName = name;
    renderDrawer();
    els.drawer.classList.add("open");
    els.scrim.classList.remove("hidden");
    requestAnimationFrame(() => els.scrim.classList.add("show"));
  }
  function closeDrawer() {
    drawerName = null;
    els.drawer.classList.remove("open");
    els.scrim.classList.remove("show");
    setTimeout(() => { if (!drawerName) els.scrim.classList.add("hidden"); }, 220);
  }
  function renderDrawer() {
    if (!cur || !drawerName) return;
    if (drawerName === "toc") {
      els.drawerTitle.textContent = "目录";
      els.drawerBody.innerHTML = cur.chapters.map((c, i) =>
        `<div class="toc-item${i === chapterIdx ? " cur" : ""}" data-i="${i}">${esc(c.title)}</div>`).join("");
      const curEl = els.drawerBody.querySelector(".cur");
      if (curEl) curEl.scrollIntoView({ block: "center" });
    } else if (drawerName === "bm") {
      const list = currentBookmarks();
      els.drawerTitle.textContent = `书签（${list.length}）`;
      els.drawerBody.innerHTML = list.length ? list.map(b =>
        `<div class="bm-item" data-id="${b.id}">
           <div class="bm-ch">${esc(cur.chapters[clamp(b.ch, 0, cur.chapters.length - 1)]?.title || "")}</div>
           <div class="bm-snippet">${esc(b.snippet)}</div>
           <div class="bm-time">${fmtDate(b.ts)}</div>
           <button class="bm-del" data-del="${b.id}" title="删除书签">✕</button>
         </div>`).join("")
        : `<div class="bm-empty">还没有书签。<br>读到心动处，点上方「书签」或按 B 键。</div>`;
    } else if (drawerName === "set") {
      els.drawerTitle.textContent = "阅读设置";
      els.drawerBody.innerHTML = `
        <div class="set-row"><span class="label">字号</span>
          <div class="stepper">
            <button data-set="fs-" title="减小">A−</button><span class="val">${settings.fs}</span><button data-set="fs+" title="增大">A＋</button>
          </div></div>
        <div class="set-row"><span class="label">行距</span>
          <div class="seg">
            ${[["1.6", "紧凑"], ["1.9", "适中"], ["2.3", "宽松"]].map(([v, t]) =>
              `<button data-set="lh" data-v="${v}" class="${settings.lh == v ? "on" : ""}">${t}</button>`).join("")}
          </div></div>
        <div class="set-row"><span class="label">字体</span>
          <div class="seg">
            <button data-set="font" data-v="serif" class="${settings.serif ? "on" : ""}">宋体</button>
            <button data-set="font" data-v="sans" class="${!settings.serif ? "on" : ""}">黑体</button>
          </div></div>
        <div class="set-row"><span class="label">主题</span>
          <div class="seg">
            ${[["light", "宣纸"], ["sepia", "旧书"], ["dark", "夜读"]].map(([v, t]) =>
              `<button data-set="theme" data-v="${v}" class="${settings.theme === v ? "on" : ""}">${t}</button>`).join("")}
          </div></div>
        <div class="set-tip">快捷键：← → 或空格 翻页 · 点击页面中部 收起/展开工具栏<br>T 目录 · B 书签 · S 设置 · Esc 返回书库</div>`;
    }
  }

  els.drawerBody.addEventListener("click", ev => {
    const t = ev.target;
    const toc = t.closest(".toc-item");
    if (toc && drawerName === "toc") { gotoChapter(+toc.dataset.i, { para: 0 }); closeDrawer(); return; }
    const delId = t.closest(".bm-del");
    if (delId) {
      const list = currentBookmarks();
      bookmarkMap[cur.id] = list.filter(b => String(b.id) !== delId.dataset.del);
      saveBookmarks(); renderDrawer(); return;
    }
    const bm = t.closest(".bm-item");
    if (bm && drawerName === "bm") {
      const found = currentBookmarks().find(b => String(b.id) === bm.dataset.id);
      if (found) jumpTo(found);
      return;
    }
    const btn = t.closest("[data-set]");
    if (btn && drawerName === "set") {
      const k = btn.dataset.set;
      if (k === "fs-") settings.fs = clamp(settings.fs - 1, 14, 30);
      else if (k === "fs+") settings.fs = clamp(settings.fs + 1, 14, 30);
      else if (k === "lh") settings.lh = parseFloat(btn.dataset.v);
      else if (k === "font") settings.serif = btn.dataset.v === "serif";
      else if (k === "theme") settings.theme = btn.dataset.v;
      saveSettings(); applySettings();
      if (cur) repaginate();
      renderDrawer();
    }
  });

  /* ───────────── 事件绑定 ───────────── */
  $("#btn-import").addEventListener("click", () => els.fileInput.click());
  els.fileInput.addEventListener("change", () => { importFiles(els.fileInput.files); els.fileInput.value = ""; });
  els.search.addEventListener("input", renderLibrary);
  $("#btn-lib-theme").addEventListener("click", () => {
    const order = ["light", "sepia", "dark"];
    settings.theme = order[(order.indexOf(settings.theme) + 1) % 3];
    saveSettings(); applySettings();
    toast({ light: "宣纸", sepia: "旧书", dark: "夜读" }[settings.theme]);
  });

  /* 拖拽导入 */
  let dragDepth = 0;
  window.addEventListener("dragenter", e => { e.preventDefault(); dragDepth++; els.dropMask.classList.remove("hidden"); });
  window.addEventListener("dragover", e => e.preventDefault());
  window.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; els.dropMask.classList.add("hidden"); } });
  window.addEventListener("drop", e => {
    e.preventDefault(); dragDepth = 0; els.dropMask.classList.add("hidden");
    if (e.dataTransfer?.files?.length) importFiles(e.dataTransfer.files);
  });

  /* 阅读器控件 */
  $("#btn-back").addEventListener("click", backToLibrary);
  $("#btn-toc").addEventListener("click", () => drawerName === "toc" ? closeDrawer() : openDrawer("toc"));
  $("#btn-bm").addEventListener("click", () => drawerName === "bm" ? closeDrawer() : addBookmarkAndOpen());
  $("#btn-settings").addEventListener("click", () => drawerName === "set" ? closeDrawer() : openDrawer("set"));
  function addBookmarkAndOpen() { addBookmark(); if (drawerName !== "bm") openDrawer("bm"); }
  $("#btn-drawer-close").addEventListener("click", closeDrawer);
  els.scrim.addEventListener("click", closeDrawer);
  els.prevCh.addEventListener("click", () => { if (chapterIdx > 0) gotoChapter(chapterIdx - 1, { last: true }); });
  els.nextCh.addEventListener("click", () => { if (chapterIdx < cur.chapters.length - 1) gotoChapter(chapterIdx + 1, { para: 0 }); });

  $("#tz-left").addEventListener("click", () => { if (!swiped) prevPage(); });
  $("#tz-right").addEventListener("click", () => { if (!swiped) nextPage(); });
  $("#tz-mid").addEventListener("click", () => {
    if (swiped) return;
    document.body.classList.toggle("no-chrome");
    if (document.body.classList.contains("no-chrome")) {
      els.chromeHint.classList.remove("hidden");
      setTimeout(() => els.chromeHint.classList.add("hidden"), 2400);
    }
  });

  /* 滑动手势（触屏） */
  let touchX = 0, touchY = 0, swiped = false;
  els.stage.addEventListener("pointerdown", e => { touchX = e.clientX; touchY = e.clientY; swiped = false; }, true);
  els.stage.addEventListener("pointerup", e => {
    const dx = e.clientX - touchX, dy = e.clientY - touchY;
    if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.3) {
      swiped = true;
      dx < 0 ? nextPage() : prevPage();
      setTimeout(() => { swiped = false; }, 350);
    }
  }, true);

  /* 键盘 */
  window.addEventListener("keydown", e => {
    if (els.viewReader.classList.contains("hidden")) return;
    if (e.target && e.target.tagName === "INPUT") return;
    switch (e.key) {
      case "ArrowRight": case "ArrowDown": case " ": case "PageDown": e.preventDefault(); nextPage(); break;
      case "ArrowLeft": case "ArrowUp": case "PageUp": e.preventDefault(); prevPage(); break;
      case "Escape": drawerName ? closeDrawer() : backToLibrary(); break;
      case "t": case "T": drawerName === "toc" ? closeDrawer() : openDrawer("toc"); break;
      case "b": case "B": drawerName === "bm" ? closeDrawer() : addBookmarkAndOpen(); break;
      case "s": case "S": drawerName === "set" ? closeDrawer() : openDrawer("set"); break;
    }
  });

  /* 尺寸变化：重排并保持当前位置 */
  let rsTimer = 0;
  window.addEventListener("resize", () => {
    clearTimeout(rsTimer);
    rsTimer = setTimeout(() => { if (cur && !els.viewReader.classList.contains("hidden")) repaginate(); }, 150);
  });

  /* ───────────── 启动 ───────────── */
  async function init() {
    applySettings();
    try {
      if (!LS.get("sg-seeded", false)) {
        LS.set("sg-seeded", true);
        books = [];
        await addBook(DEMO_TXT, DEMO_TITLE, DEMO_TXT.length);
        const b = books[books.length - 1];
        if (b) { b.author = DEMO_AUTHOR; await DB.putBook(b); }
      }
      books = await DB.allBooks();
      renderLibrary();
    } catch (e) {
      console.error(e);
      toast("存储不可用：请用 python3 -m http.server 等方式在本机打开本站");
    }
  }
  init();
})();
