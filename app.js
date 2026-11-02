/* Keepsake Wall — plain JS, no build step. */
"use strict";
const $ = id => document.getElementById(id);
const BUCKET = "memory-photos", MAX = 10, NAME_MAX = 60, MSG_MAX = 3000, SIGN_TTL = 3600;
const APP_NAME = window.APP_NAME || "Keepsake Wall";
const configured = window.supabase && /^https:\/\//.test(window.SUPABASE_URL || "") && (window.SUPABASE_ANON_KEY || "").length > 20;
const sb = configured ? window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY) : null;

let user = null, myPages = [], page = null, posts = [], token = null, isOwner = false, signedAt = 0;

/* ---------- wording (memorial vs celebration) ---------- */
const WORDS = {
  memorial:    { eyebrow: "In loving memory", add: "+ Share a memory", edit: "Edit my memory", head: "Share a memory", editHead: "Edit your memory",
                 msgLbl: "Your memory or message", ph: "A story, a moment, something you'll always remember…", empty: "No memories yet. Be the first to share one.", one: "memory", many: "memories" },
  celebration: { eyebrow: "Celebrating", add: "+ Add a message", edit: "Edit my message", head: "Add a message", editHead: "Edit your message",
                 msgLbl: "Your message", ph: "A wish, a favorite story, a note to share…", empty: "Nothing here yet. Be the first to post!", one: "post", many: "posts" }
};
const W = () => WORDS[page && page.kind] || WORDS.memorial;

/* ---------- helpers ---------- */
const hex = n => [...crypto.getRandomValues(new Uint8Array(n))].map(b => b.toString(16).padStart(2, "0")).join("");
async function sha256(s) { const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)); return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, "0")).join(""); }
const fmt = d => new Date(d).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const errText = e => (e && (e.message || e.error_description || e.error)) || "Something went wrong. Please try again.";
let toastT = 0;
function toast(msg) { const t = $("toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, 3200); }
function msg(el, text, isErr) { el.textContent = text || ""; el.classList.toggle("err", !!isErr); }
const tokenFromHash = h => { const m = /^#p=([A-Za-z0-9_-]{32,})$/.exec(h || ""); return m ? m[1] : null; };
const shareLink = t => location.origin + location.pathname + "#p=" + t;
const mineKey = t => "mw-mine-" + t;
function getMine() { try { return JSON.parse(localStorage.getItem(mineKey(token)) || "null"); } catch { return null; } }
function setMine(v) { if (v) localStorage.setItem(mineKey(token), JSON.stringify(v)); else localStorage.removeItem(mineKey(token)); }

$("brandName").textContent = APP_NAME;

/* ---------- views & routing ---------- */
const VIEWS = ["loginV", "pagesV", "wallV", "naV", "setupV"];
function show(v) { VIEWS.forEach(x => $(x).hidden = x !== v); $("myPagesBtn").hidden = !(user && v !== "pagesV"); }
async function route() {
  closeFeed(true);
  if (!configured) return show("setupV");
  const t = tokenFromHash(location.hash);
  if (t) return openWall(t);
  token = null; page = null; document.title = APP_NAME;
  if (user) { show("pagesV"); loadPages(); } else show("loginV");
}
addEventListener("hashchange", route);
$("myPagesBtn").onclick = () => { location.hash = ""; history.replaceState(null, "", location.pathname); route(); };

/* ---------- organizer auth ---------- */
$("loginF").onsubmit = async e => {
  e.preventDefault(); $("lgo").disabled = true; msg($("lmsg"), "Signing in…");
  const { error } = await sb.auth.signInWithPassword({ email: $("em").value.trim(), password: $("pw").value });
  $("lgo").disabled = false;
  if (error) return msg($("lmsg"), /invalid/i.test(error.message) ? "That email and password didn't match. Please try again." : errText(error), true);
  msg($("lmsg"), "");
};
$("signOut").onclick = async () => { await sb.auth.signOut(); };

/* ---------- organizer: my pages ---------- */
async function loadPages() {
  msg($("pagesMsg"), "Loading…");
  const { data, error } = await sb.from("mw_pages").select("id,token,title,description,kind,cover_path,is_open,created_at").order("created_at", { ascending: false });
  if (error) return msg($("pagesMsg"), /relation|does not exist|schema cache/i.test(error.message) ? "The database isn't set up yet — run setup.sql in Supabase (see README)." : errText(error), true);
  myPages = data || []; msg($("pagesMsg"), "");
  const urls = await signPaths(myPages.map(p => p.cover_path).filter(Boolean));
  const L = $("pageList"); L.innerHTML = "";
  if (!myPages.length) { L.innerHTML = '<div class="emptylist">You haven\'t made a page yet.<br>Tap <b>+ New page</b> to start one.</div>'; return; }
  for (const p of myPages) {
    const b = document.createElement("button"); b.type = "button"; b.className = "pcard";
    const c = urls[p.cover_path] ? Object.assign(new Image(), { src: urls[p.cover_path], alt: "", className: "pc" }) : Object.assign(document.createElement("span"), { className: "pc", textContent: (p.title[0] || "•").toUpperCase() });
    const t = document.createElement("div"); t.innerHTML = "<b></b><small></small>";
    t.querySelector("b").textContent = p.title;
    t.querySelector("small").textContent = (p.kind === "celebration" ? "Celebration" : "Memorial") + " · " + (p.is_open ? "Open for posts" : "Closed");
    b.append(c, t); b.onclick = () => { location.hash = "p=" + p.token; }; L.appendChild(b);
  }
}
$("newPage").onclick = () => openPageForm(null);

/* ---------- signed URLs (photos are private) ---------- */
async function signPaths(paths) {
  const m = {}; paths = [...new Set(paths)];
  for (let i = 0; i < paths.length; i += 100) {
    const { data } = await sb.storage.from(BUCKET).createSignedUrls(paths.slice(i, i + 100), SIGN_TTL);
    (data || []).forEach(d => { if (d.signedUrl) m[d.path] = d.signedUrl; });
  }
  return m;
}

/* ---------- wall ---------- */
async function openWall(t) {
  const changed = t !== token; token = t;
  if (changed) { $("grid").innerHTML = ""; $("wTitle").textContent = ""; $("wCount").textContent = "Loading…"; $("cover").hidden = true; $("addBtn").hidden = true; $("ownBar").hidden = true; $("empty").hidden = true; $("eyebrow").textContent = ""; $("wDesc").hidden = true; $("closedNote").hidden = true; }
  show("wallV");
  const { data, error } = await sb.rpc("get_page", { p_token: t });
  if (t !== token) return;
  page = data && data[0];
  if (error || !page) { show("naV"); return; }
  isOwner = false;
  if (user) { const r = await sb.from("mw_pages").select("id").eq("token", t).maybeSingle(); isOwner = !!(r.data && r.data.id); }
  await loadPosts();
}
async function loadPosts() {
  const { data, error } = await sb.rpc("get_page_posts", { p_token: token });
  if (error) { toast("Couldn't load posts. Please refresh."); return; }
  posts = data || [];
  const urls = await signPaths(posts.flatMap(p => p.paths || []).concat(page.cover_path ? [page.cover_path] : []));
  posts.forEach(p => p.urls = (p.paths || []).map(x => urls[x] || ""));
  page.coverUrl = page.cover_path ? urls[page.cover_path] : null;
  signedAt = Date.now();
  const mine = getMine(); if (mine && !posts.some(p => p.id === mine.id)) setMine(null);   // removed by organizer
  renderWall();
}
function renderWall() {
  const w = W(), mine = getMine();
  document.title = page.title + " · " + APP_NAME;
  $("eyebrow").textContent = w.eyebrow; $("wTitle").textContent = page.title;
  $("wDesc").textContent = page.description || ""; $("wDesc").hidden = !page.description;
  const cv = $("cover"); cv.innerHTML = ""; cv.hidden = !page.coverUrl;
  if (page.coverUrl) cv.appendChild(Object.assign(new Image(), { src: page.coverUrl, alt: page.title }));
  $("wCount").textContent = posts.length + " " + (posts.length === 1 ? w.one : w.many);
  $("ownBar").hidden = !isOwner; $("oOpen").checked = page.is_open; $("oOpenTxt").textContent = page.is_open ? "Posting is open" : "Posting is closed";
  const canAdd = page.is_open || mine;
  $("addBtn").hidden = !canAdd; $("addBtn").textContent = mine ? w.edit : w.add;
  $("closedNote").hidden = page.is_open;
  $("empty").textContent = w.empty; $("empty").hidden = posts.length > 0;
  const g = $("grid"); g.innerHTML = "";
  for (const p of posts) {
    const b = document.createElement("button"); b.type = "button"; b.dataset.id = p.id;
    b.setAttribute("aria-label", "Post by " + p.name);
    const who = Object.assign(document.createElement("span"), { className: "who", textContent: p.name });
    if (p.urls.length) {
      b.className = "tile"; const img = new Image(); img.loading = "lazy"; img.alt = ""; img.src = p.urls[0]; b.appendChild(img);
      if (p.urls.length > 1) b.insertAdjacentHTML("beforeend", '<svg class="multi" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3h12a2 2 0 0 1 2 2v12h-2V5H7z"/><rect x="3" y="7" width="14" height="14" rx="2"/></svg>');
    } else {
      b.className = "tile text"; const q = document.createElement("q"); q.textContent = p.message; b.appendChild(q);
    }
    b.appendChild(who); b.onclick = () => openFeed(p.id); g.appendChild(b);
  }
}
// refresh signed links if the tab sat open a long time
document.addEventListener("visibilitychange", () => { if (!document.hidden && page && Date.now() - signedAt > 45 * 60 * 1000) loadPosts(); });

/* ---------- carousel (from Photo Journal) ---------- */
function carousel(p) {
  const u = p.urls; const c = document.createElement("div"); c.className = "car";
  c.innerHTML = '<div class="track"></div><button type="button" class="nav prev" aria-label="Previous photo">‹</button><button type="button" class="nav next" aria-label="Next photo">›</button><div class="counter"></div><div class="dots"></div>';
  const tr = c.querySelector(".track"), dots = c.querySelector(".dots"), ctr = c.querySelector(".counter"), pv = c.querySelector(".prev"), nx = c.querySelector(".next");
  u.forEach((src, i) => { const s = document.createElement("div"); s.className = "slide"; const img = new Image(); img.loading = "lazy"; img.alt = "Photo " + (i + 1) + " of " + u.length + " from " + p.name; img.src = src; s.appendChild(img); tr.appendChild(s); dots.appendChild(document.createElement("span")); });
  const multi = u.length > 1; pv.hidden = nx.hidden = ctr.hidden = dots.hidden = !multi;
  const idx = () => tr.clientWidth ? Math.round(tr.scrollLeft / tr.clientWidth) : 0;
  const upd = () => { const i = Math.min(idx(), u.length - 1); ctr.textContent = (i + 1) + "/" + u.length; [...dots.children].forEach((d, k) => d.classList.toggle("on", k === i)); pv.disabled = i <= 0; nx.disabled = i >= u.length - 1; };
  const go = d => tr.scrollTo({ left: (idx() + d) * tr.clientWidth, behavior: "smooth" });
  tr.addEventListener("scroll", () => requestAnimationFrame(upd), { passive: true }); pv.onclick = () => go(-1); nx.onclick = () => go(1);
  c.tabIndex = -1; c.addEventListener("keydown", e => { if (e.key === "ArrowLeft") go(-1); if (e.key === "ArrowRight") go(1); }); c.go = go; upd(); return c;
}

/* ---------- feed ---------- */
let gridY = 0, feedPushed = false, ignorePop = 0;
function buildFeed() {
  const f = $("feed"), mine = getMine(); f.innerHTML = ""; $("fTitle").textContent = page.title;
  for (const p of posts) {
    const a = document.createElement("article"); a.className = "post"; a.dataset.id = p.id;
    a.innerHTML = '<div class="phead"><span class="av"></span><span class="nm"></span><time></time></div>';
    a.querySelector(".av").textContent = (p.name.trim()[0] || "?").toUpperCase();
    a.querySelector(".nm").textContent = p.name;
    const tm = a.querySelector("time"); tm.textContent = fmt(p.created_at); tm.dateTime = p.created_at;
    const head = a.querySelector(".phead");
    if (mine && mine.id === p.id) { const e = Object.assign(document.createElement("button"), { type: "button", className: "link", textContent: "Edit" }); e.onclick = () => openCompose(); head.appendChild(e); }
    if (isOwner) { const o = Object.assign(document.createElement("button"), { type: "button", className: "icon", textContent: "⋯" }); o.setAttribute("aria-label", "Post options"); o.onclick = () => openOpt(p); head.appendChild(o); }
    if (p.urls.length) head.after(carousel(p));
    if (p.message) { const m = document.createElement("p"); m.className = "pmsg"; m.textContent = p.message; a.appendChild(m); }
    f.appendChild(a);
  }
}
function openFeed(id) {
  gridY = scrollY; buildFeed(); $("feedV").hidden = false; document.body.classList.add("lock");
  const el = $("feed").querySelector('[data-id="' + CSS.escape(id) + '"]');
  $("feedV").scrollTop = el ? el.offsetTop - $("feedV").querySelector(".fbar").offsetHeight - 8 : 0;
  if (!feedPushed) { history.pushState({ feed: true }, ""); feedPushed = true; }
}
function closeFeed(silent) {
  if ($("feedV").hidden) return; $("feedV").hidden = true; document.body.classList.remove("lock"); scrollTo(0, gridY);
  if (!silent && feedPushed) { feedPushed = false; ignorePop++; history.back(); }
}
$("back").onclick = () => closeFeed();
addEventListener("popstate", () => { if (ignorePop) { ignorePop--; return; } feedPushed = false; closeFeed(true); });
addEventListener("keydown", e => {
  if ($("feedV").hidden || document.querySelector("dialog[open]")) return;
  if (e.key === "Escape") closeFeed();
  if (e.key === "ArrowLeft" || e.key === "ArrowRight") { const top = $("feedV").scrollTop + 80; const a = [...$("feed").children].find(x => x.offsetTop + x.offsetHeight > top); const c = a && a.querySelector(".car"); c && c.go(e.key === "ArrowLeft" ? -1 : 1); }
});
function refreshFeedIfOpen() { if (!$("feedV").hidden) { const y = $("feedV").scrollTop; buildFeed(); $("feedV").scrollTop = y; } }

/* ---------- robust resize (from Photo Journal: iOS canvas memory, HEIC, blank/black output) ---------- */
const MAX_EDGE = 1600, MIN_BLOB = 2000;
const isHeic = f => /hei[cf]/i.test(f.type) || /\.hei[cf]$/i.test(f.name || "");
function loadImg(file) { return new Promise((res, rej) => { const img = new Image(), u = URL.createObjectURL(file);
  img.onload = () => res({ img, done: () => { URL.revokeObjectURL(u); img.src = ""; } }); img.onerror = () => { URL.revokeObjectURL(u); rej(new Error("decode")); }; img.decoding = "async"; img.src = u; }); }
function freeCanvas(c) { c.width = 0; c.height = 0; }
// true when the canvas is a single flat color (failed draw = white fill; lost context = black/transparent)
function looksBlank(c) { const s = document.createElement("canvas"); s.width = s.height = 24; const x = s.getContext("2d"); if (!x) return true; x.drawImage(c, 0, 0, 24, 24);
  let d; try { d = x.getImageData(0, 0, 24, 24).data; } catch { freeCanvas(s); return false; } freeCanvas(s); let sum = 0, sq = 0, n = d.length / 4, alpha = 0;
  for (let i = 0; i < d.length; i += 4) { const l = .299 * d[i] + .587 * d[i + 1] + .114 * d[i + 2]; sum += l; sq += l * l; alpha += d[i + 3]; }
  const mean = sum / n, sd = Math.sqrt(Math.max(0, sq / n - mean * mean)); return alpha / n < 250 || sd < 2; }
function toBlobSafe(c) { return new Promise(res => { try { c.toBlob(b => { if (b && b.size) return res(b); try { const u = c.toDataURL("image/jpeg", .85); fetch(u).then(r => r.blob()).then(res, () => res(null)); } catch { res(null); } }, "image/jpeg", .85); } catch { res(null); } }); }
async function encode(img, edge) { const w = img.naturalWidth, h = img.naturalHeight, s = Math.min(1, edge / Math.max(w, h));
  const c = document.createElement("canvas"); c.width = Math.max(1, Math.round(w * s)); c.height = Math.max(1, Math.round(h * s));
  try { const x = c.getContext("2d"); if (!x) return null; x.fillStyle = "#fff"; x.fillRect(0, 0, c.width, c.height); x.imageSmoothingQuality = "high"; x.drawImage(img, 0, 0, c.width, c.height);
    if (looksBlank(c)) return null; const b = await toBlobSafe(c); return b && b.size >= MIN_BLOB ? b : null; } finally { freeCanvas(c); } }
async function resize(file, maxEdge) { let L;
  try { L = await loadImg(file); } catch { throw new Error(isHeic(file) ? "“" + file.name + "” is a HEIC photo this browser can't read. Try from your iPhone's Safari, or save it as JPEG first." : "Couldn't read “" + (file.name || "photo") + "”. Try a JPEG or PNG."); }
  try { if (!L.img.naturalWidth || !L.img.naturalHeight) throw new Error("Couldn't read “" + (file.name || "photo") + "”.");
    // one at a time, release memory between tries; smaller retries help iPhones when memory is tight
    for (const edge of [maxEdge || MAX_EDGE, 1200, 900]) { const b = await encode(L.img, edge); if (b) return b; await sleep(250); }
    throw new Error("“" + (file.name || "photo") + "” came out blank while processing (usually the phone running low on memory). Try adding it again, or add fewer photos at once.");
  } finally { L.done(); } }

/* ---------- compose (guest post) ---------- */
let pending = [], editing = null, busy = false;   // pending: {path?, url, blob?}
function openCompose() {
  if ($("postD").open) return;
  const w = W(), mine = getMine(); editing = mine ? posts.find(p => p.id === mine.id) || null : null;
  if (!editing && !page.is_open) return toast("This page is closed to new posts.");
  pending.forEach(p => p.blob && URL.revokeObjectURL(p.url));
  pending = editing ? editing.paths.map((path, i) => ({ path, url: editing.urls[i] })) : [];
  $("postH").textContent = editing ? w.editHead : w.head; $("pMsgLbl").textContent = w.msgLbl; $("pMsg").placeholder = w.ph;
  $("pName").value = editing ? editing.name : (localStorage.getItem("mw-name") || "");
  $("pMsg").value = editing ? editing.message : "";
  $("pSave").textContent = editing ? "Save changes" : "Post"; $("pDel").hidden = !editing;
  $("pSave").disabled = editing && !page.is_open; msg($("nmsg"), editing && !page.is_open ? "This page is closed, so changes can't be saved — but you can still delete your post." : "");
  drawThumbs(); $("postD").showModal();
}
$("addBtn").onclick = openCompose;
$("pCancel").onclick = () => { if (!busy) $("postD").close(); };
$("postD").addEventListener("cancel", e => { if (busy) e.preventDefault(); });
function drawThumbs() {
  const t = $("thumbs"); t.innerHTML = "";
  pending.forEach((p, i) => { const d = document.createElement("div"); d.className = "thumb"; d.appendChild(Object.assign(new Image(), { src: p.url, alt: "Photo " + (i + 1) }));
    const x = Object.assign(document.createElement("button"), { type: "button", textContent: "×" }); x.setAttribute("aria-label", "Remove photo " + (i + 1));
    x.onclick = () => { const [r] = pending.splice(i, 1); if (r.blob) URL.revokeObjectURL(r.url); drawThumbs(); }; d.appendChild(x); t.appendChild(d); });
  $("pCount").textContent = "(" + pending.length + " of " + MAX + ")"; $("addPh").hidden = pending.length >= MAX;
}
$("files").onchange = async e => { const files = [...e.target.files]; e.target.value = ""; await addFiles(files); };
async function addFiles(files) {
  const list = files.filter(f => f.type.startsWith("image/") || isHeic(f));
  if (!list.length) return msg($("nmsg"), "Please choose photos (image files).", true);
  const room = MAX - pending.length; if (room <= 0) return msg($("nmsg"), "You can add up to " + MAX + " photos.", true);
  const take = list.slice(0, room), errs = []; busy = true; $("pSave").disabled = true;
  for (let k = 0; k < take.length; k++) { msg($("nmsg"), "Preparing photo " + (k + 1) + " of " + take.length + "…");
    try { const blob = await resize(take[k]); pending.push({ blob, url: URL.createObjectURL(blob) }); drawThumbs(); } catch (er) { errs.push(er.message); } await sleep(50); }
  busy = false; $("pSave").disabled = false;
  if (list.length > room) errs.push("Only " + MAX + " photos per post — added the first " + room + ".");
  msg($("nmsg"), errs.join(" "), errs.length > 0);
}
$("postF").onsubmit = async e => {
  e.preventDefault(); if (busy) return;
  const name = $("pName").value.replace(/\s+/g, " ").trim().slice(0, NAME_MAX), message = $("pMsg").value.trim().slice(0, MSG_MAX);
  if (!name) return msg($("nmsg"), "Please type your name.", true);
  if (!pending.length && !message) return msg($("nmsg"), "Please add at least one photo or a message.", true);
  busy = true; $("pSave").disabled = true; $("pDel").disabled = true;
  try {
    const paths = [];
    for (let i = 0; i < pending.length; i++) { const p = pending[i];
      if (p.path) { paths.push(p.path); continue; }
      msg($("nmsg"), "Uploading photo " + (i + 1) + " of " + pending.length + "…");
      const path = page.id + "/" + hex(12) + ".jpg";
      const { error } = await sb.storage.from(BUCKET).upload(path, p.blob, { contentType: "image/jpeg", upsert: false });
      if (error) throw new Error(/row-level|policy|security/i.test(error.message) ? "This page isn't accepting photos right now." : "A photo didn't upload (" + errText(error) + "). Please try again.");
      p.path = path; paths.push(path);
    }
    msg($("nmsg"), "Saving…");
    if (editing) {
      const mine = getMine();
      const { error } = await sb.rpc("update_post", { p_token: token, p_post_id: mine.id, p_edit_key: mine.key, p_name: name, p_message: message, p_paths: paths });
      if (error) throw error;
    } else {
      const key = hex(32), hash = await sha256(key);
      const { data, error } = await sb.rpc("create_post", { p_token: token, p_name: name, p_message: message, p_paths: paths, p_edit_key_hash: hash });
      if (error) throw error;
      setMine({ id: data, key });
    }
    localStorage.setItem("mw-name", name);
    $("postD").close(); toast(editing ? "Your changes are saved." : "Thank you for sharing. ♥");
    await loadPosts(); refreshFeedIfOpen();
  } catch (er) { msg($("nmsg"), errText(er), true); }
  finally { busy = false; $("pSave").disabled = false; $("pDel").disabled = false; }
};
$("pDel").onclick = async () => {
  if (busy || !confirm("Delete your post from this page? This can't be undone.")) return;
  const mine = getMine(); busy = true;
  const { error } = await sb.rpc("delete_post", { p_token: token, p_post_id: mine.id, p_edit_key: mine.key });
  busy = false; if (error) return msg($("nmsg"), errText(error), true);
  setMine(null); $("postD").close(); toast("Your post was deleted."); await loadPosts(); refreshFeedIfOpen();
};

/* ---------- organizer: create / edit page ---------- */
let gEdit = null, gCover = null;   // gCover: {blob,url} new | "remove" | null (unchanged)
function openPageForm(p) {
  gEdit = p; gCover = null; $("pageF").reset();
  $("pageH").textContent = p ? "Edit page" : "New page"; $("gSave").textContent = p ? "Save" : "Create page"; $("gDel").hidden = !p;
  $("gTitle").value = p ? p.title : ""; $("gDesc").value = p ? p.description || "" : "";
  document.querySelector('input[name=kind][value="' + (p ? p.kind : "memorial") + '"]').checked = true;
  drawCov(p && p.coverUrl); msg($("gmsg"), ""); $("pageD").showModal();
}
function drawCov(url) { const c = $("covPrev"); c.innerHTML = ""; if (url) c.appendChild(Object.assign(new Image(), { src: url, alt: "Cover" })); else c.textContent = "No photo"; $("covRm").hidden = !url; }
$("covFile").onchange = async e => { const f = e.target.files[0]; e.target.value = ""; if (!f) return;
  msg($("gmsg"), "Preparing photo…"); try { const blob = await resize(f, 1200); gCover = { blob, url: URL.createObjectURL(blob) }; drawCov(gCover.url); msg($("gmsg"), ""); } catch (er) { msg($("gmsg"), er.message, true); } };
$("covRm").onclick = () => { gCover = "remove"; drawCov(null); };
$("gCancel").onclick = () => $("pageD").close();
$("pageF").onsubmit = async e => {
  e.preventDefault(); const title = $("gTitle").value.trim().slice(0, 120); if (!title) return msg($("gmsg"), "Please enter a name.", true);
  const row = { title, description: $("gDesc").value.trim().slice(0, 600) || null, kind: document.querySelector("input[name=kind]:checked").value };
  $("gSave").disabled = true; msg($("gmsg"), "Saving…");
  try {
    let id = gEdit && gEdit.id, tok = gEdit && gEdit.token, oldCover = gEdit && gEdit.cover_path;
    if (gEdit) { const { error } = await sb.from("mw_pages").update(row).eq("id", id); if (error) throw error; }
    else { const { data, error } = await sb.from("mw_pages").insert(row).select("id,token").single(); if (error) throw error; id = data.id; tok = data.token; }
    if (gCover && gCover !== "remove") {
      const path = id + "/cover-" + hex(10) + ".jpg";
      const up = await sb.storage.from(BUCKET).upload(path, gCover.blob, { contentType: "image/jpeg" }); if (up.error) throw up.error;
      const { error } = await sb.from("mw_pages").update({ cover_path: path }).eq("id", id); if (error) throw error;
      if (oldCover) sb.storage.from(BUCKET).remove([oldCover]);
    } else if (gCover === "remove" && oldCover) {
      await sb.from("mw_pages").update({ cover_path: null }).eq("id", id); sb.storage.from(BUCKET).remove([oldCover]);
    }
    $("pageD").close();
    if (gEdit) { toast("Page saved."); await openWall(token); }
    else { toast("Your page is ready! Share the link or QR code."); location.hash = "p=" + tok; setTimeout(() => openShare(tok, title), 400); }
  } catch (er) { msg($("gmsg"), errText(er), true); }
  finally { $("gSave").disabled = false; }
};
$("gDel").onclick = async () => {
  if (!confirm("Delete this whole page, including every post and photo? This can't be undone.")) return;
  const id = gEdit.id;
  const { data: files } = await sb.storage.from(BUCKET).list(id, { limit: 1000 });
  if (files && files.length) await sb.storage.from(BUCKET).remove(files.map(f => id + "/" + f.name));
  const { error } = await sb.from("mw_pages").delete().eq("id", id);
  if (error) return msg($("gmsg"), errText(error), true);
  $("pageD").close(); toast("Page deleted."); location.hash = ""; history.replaceState(null, "", location.pathname); route();
};
$("oEdit").onclick = async () => { const { data } = await sb.from("mw_pages").select("*").eq("token", token).maybeSingle(); if (data) openPageForm({ ...data, coverUrl: page.coverUrl }); };
$("oOpen").onchange = async () => {
  const on = $("oOpen").checked; const { error } = await sb.from("mw_pages").update({ is_open: on }).eq("token", token);
  if (error) { $("oOpen").checked = !on; return toast(errText(error)); }
  page.is_open = on; renderWall(); toast(on ? "Posting is open again." : "Posting is closed. People can still view the page.");
};

/* ---------- organizer: remove a post ---------- */
let optPost = null;
function openOpt(p) { optPost = p; $("optTxt").textContent = "Posted by " + p.name + " on " + fmt(p.created_at) + "."; $("optD").showModal(); }
$("optClose").onclick = () => $("optD").close();
$("optRm").onclick = async () => {
  if (!confirm("Remove this post and its photos for everyone?")) return;
  const { error } = await sb.from("mw_posts").delete().eq("id", optPost.id);
  if (error) return toast(errText(error));
  if (optPost.paths.length) await sb.storage.from(BUCKET).remove(optPost.paths);
  $("optD").close(); toast("Post removed."); await loadPosts(); refreshFeedIfOpen();
};

/* ---------- share link + QR ---------- */
let qrName = "page";
function drawQR(text) {
  const q = qrcode(0, "M"); q.addData(text); q.make();
  const n = q.getModuleCount(), quiet = 4, c = $("qr"), x = c.getContext("2d"), cell = Math.floor(600 / (n + quiet * 2)), size = cell * (n + quiet * 2);
  c.width = c.height = size; x.fillStyle = "#fff"; x.fillRect(0, 0, size, size); x.fillStyle = "#00171F";
  for (let r = 0; r < n; r++) for (let k = 0; k < n; k++) if (q.isDark(r, k)) x.fillRect((k + quiet) * cell, (r + quiet) * cell, cell, cell);
}
function openShare(t, title) { const link = shareLink(t); $("shLink").value = link; qrName = (title || "page").replace(/[^\w]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "page"; drawQR(link); $("shareD").showModal(); }
$("oShare").onclick = () => openShare(token, page.title);
$("shCopy").onclick = async () => { try { await navigator.clipboard.writeText($("shLink").value); toast("Link copied."); } catch { $("shLink").select(); toast("Press and hold the link to copy it."); } };
$("shDl").onclick = () => $("qr").toBlob(b => { const a = document.createElement("a"); a.href = URL.createObjectURL(b); a.download = qrName + "-qr.png"; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); }, "image/png");
$("shClose").onclick = () => $("shareD").close();

/* ---------- start ---------- */
if (sb) {
  let first = true;
  sb.auth.onAuthStateChange((_ev, s) => {
    const was = user && user.id; user = s && s.user || null;
    if (first || was !== (user && user.id)) { first = false; route(); }
  });
} else route();
