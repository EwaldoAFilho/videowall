/* VideoWall — lógica do painel administrativo */
(() => {
"use strict";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// Aceita uma URL ou um código de incorporação (<iframe ...>): extrai só o src.
const extractIframeSrc = (s) => {
  s = (s || "").trim();
  if (s[0] !== "<") return s;
  const m = s.match(/<iframe[^>]*\bsrc\s*=\s*["']([^"']+)["']/i);
  return m ? m[1].replace(/&amp;/g, "&") : s;
};

// Rótulo de proporção (16:9, 32:9, 4:3…) a partir de largura/altura.
const aspectLabel = (w, h) => {
  if (!w || !h) return "";
  const r = w / h;
  const common = [[16, 9], [4, 3], [21, 9], [32, 9], [1, 1], [3, 2], [16, 10], [9, 16]];
  for (const [a, b] of common) if (Math.abs(r - a / b) < 0.03) return `${a}:${b}`;
  const g = (a, b) => (b ? g(b, a % b) : a); const d = g(w, h);
  return `${Math.round(w / d)}:${Math.round(h / d)}`;
};

// Texto explicativo do que foi colado no campo de origem (URL × iframe × stream).
const describeSource = (s) => {
  s = (s || "").trim();
  if (!s) return "";
  let prefix = "", url = s;
  if (s[0] === "<") {
    url = extractIframeSrc(s);
    if (url === s) return "⚠ Parece HTML, mas não encontrei o src= do iframe.";
    prefix = "📋 Código <iframe> — usando: " + url + "\n";
  }
  let kind;
  if (/youtube\.com|youtu\.be/i.test(url)) kind = "▶ YouTube — toca automaticamente (vídeo ou ao vivo).";
  else if (/\.m3u8(\?|#|$)/i.test(url)) kind = "📡 Stream HLS — toca direto, sem precisar de play.";
  else if (/\.(mp4|webm|mov|m4v|ogv)(\?|#|$)/i.test(url)) kind = "🎬 Vídeo direto — autoplay.";
  else if (/\.(mjpg|mjpeg)(\?|#|$)/i.test(url)) kind = "📷 Câmera MJPEG — exibe direto.";
  else if (/twitch\.tv/i.test(url)) kind = "▶ Twitch — autoplay (precisa liberar o domínio em 'parent').";
  else if (/vimeo\.com/i.test(url)) kind = "▶ Vimeo — autoplay.";
  else if (url[0] === "/") kind = "📄 Página interna do VideoWall.";
  else if (/^https?:\/\//i.test(url)) kind = "🔗 URL de site/dashboard.";
  else kind = "ℹ Endereço/caminho — usado como está.";
  return prefix + kind;
};

// ------------------------------------------------------------------ API

async function api(method, url, body) {
  const opt = { method, headers: {} };
  if (body !== undefined) {
    opt.headers["Content-Type"] = "application/json";
    opt.body = JSON.stringify(body);
  }
  const r = await fetch(url, opt);
  if (r.status === 401) { location.href = "/login"; throw new Error("sessão expirada"); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Erro HTTP ${r.status}`);
  return data;
}

// ------------------------------------------------------------------ toast / modais

let toastTimer = null;
function toast(msg, isErr) {
  const t = $("toast");
  t.textContent = msg;
  t.className = isErr ? "err" : "";
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
}

function openModal(id) {
  $("modalBack").hidden = false;
  for (const m of document.querySelectorAll(".modal")) m.hidden = true;
  $(id).hidden = false;
}
function closeModals() { $("modalBack").hidden = true; }
$("modalBack").addEventListener("mousedown", (e) => {
  if (e.target === $("modalBack")) closeModals();
});

function confirmDlg(text, title = "Confirmar") {
  return new Promise((resolve) => {
    $("cfTitle").textContent = title;
    $("cfText").textContent = text;
    openModal("confirmModal");
    $("cfYes").onclick = () => { closeModals(); resolve(true); };
    $("cfNo").onclick = () => { closeModals(); resolve(false); };
  });
}
function promptDlg(title, value = "") {
  return new Promise((resolve) => {
    $("prTitle").textContent = title;
    $("prInput").value = value;
    openModal("promptModal");
    $("prInput").focus();
    const done = (v) => { closeModals(); resolve(v); };
    $("prYes").onclick = () => done($("prInput").value.trim() || null);
    $("prNo").onclick = () => done(null);
    $("prInput").onkeydown = (e) => { if (e.key === "Enter") $("prYes").click(); };
  });
}

// ------------------------------------------------------------------ estado

let layouts = [];
let activeLayoutId = null;   // layout aplicado no videowall
let layout = null;           // layout aberto no editor (árvore completa)
let selectedId = null;       // container selecionado
let scale = 1;
const SNAP = 10;
const pending = new Map();   // salvamentos com debounce: chave -> {timer, fn}

function schedSave(key, fn, delay = 400) {
  $("dirty").hidden = false;
  const p = pending.get(key);
  if (p) clearTimeout(p.timer);
  const timer = setTimeout(() => { pending.delete(key); run(fn); }, delay);
  pending.set(key, { timer, fn });
  async function run(f) {
    try { await f(); } catch (e) { toast(e.message, true); }
    if (!pending.size) $("dirty").hidden = true;
  }
}
async function flushSaves() {
  const items = [...pending.values()];
  pending.forEach((p) => clearTimeout(p.timer));
  pending.clear();
  for (const p of items) {
    try { await p.fn(); } catch (e) { toast(e.message, true); }
  }
  $("dirty").hidden = true;
}

const selContainer = () =>
  layout ? layout.containers.find((c) => c.id === selectedId) : null;

// ------------------------------------------------------------------ navegação entre views

for (const btn of document.querySelectorAll("#sidebar .nav")) {
  btn.addEventListener("click", () => showView(btn.dataset.view));
}
document.querySelectorAll("[data-goto]").forEach((a) =>
  a.addEventListener("click", (e) => { e.preventDefault(); showView(a.dataset.goto); }));

function showView(name) {
  document.querySelectorAll("#sidebar .nav").forEach((b) =>
    b.classList.toggle("active", b.dataset.view === name));
  document.querySelectorAll(".view").forEach((v) =>
    v.classList.toggle("active", v.id === "view-" + name));
  if (name === "media") loadMedia(mediaPath);
  if (name === "status") refreshStatus();
  if (name === "config") loadConfigView();
}

// ------------------------------------------------------------------ layouts

async function loadLayouts(selectId) {
  const data = await api("GET", "/api/layouts");
  layouts = data.layouts;
  activeLayoutId = data.active_layout_id;
  const sel = $("layoutSelect");
  sel.innerHTML = "";
  for (const l of layouts) {
    const o = document.createElement("option");
    o.value = l.id;
    o.textContent =
      l.name + (l.id === activeLayoutId ? " · NO AR" : "") + (l.is_default ? " ⭐" : "");
    sel.appendChild(o);
  }
  const pick = selectId || (layout && layout.id) || activeLayoutId || (layouts[0] && layouts[0].id);
  if (pick) { sel.value = pick; await openLayout(+pick); }
  else { layout = null; renderCanvas(); }
}

async function openLayout(id) {
  layout = await api("GET", "/api/layouts/" + id);
  selectedId = null;
  $("layW").value = layout.width;
  $("layH").value = layout.height;
  $("layBg").value = layout.background;
  renderCanvas();
  renderProps();
}

$("layoutSelect").addEventListener("change", async (e) => {
  await flushSaves();
  openLayout(+e.target.value).catch((er) => toast(er.message, true));
});

$("btnNewLayout").addEventListener("click", async () => {
  const name = await promptDlg("Nome do novo layout");
  if (!name) return;
  try {
    const lay = await api("POST", "/api/layouts", { name, width: 1920, height: 1080 });
    await loadLayouts(lay.id);
    toast("Layout criado");
  } catch (e) { toast(e.message, true); }
});

$("btnDupLayout").addEventListener("click", async () => {
  if (!layout) return;
  try {
    const lay = await api("POST", `/api/layouts/${layout.id}/duplicate`);
    await loadLayouts(lay.id);
    toast("Layout duplicado");
  } catch (e) { toast(e.message, true); }
});

$("btnDelLayout").addEventListener("click", async () => {
  if (!layout) return;
  if (!(await confirmDlg(`Excluir o layout "${layout.name}" e todos os seus containers?`))) return;
  try {
    await api("DELETE", "/api/layouts/" + layout.id);
    layout = null;
    await loadLayouts();
    toast("Layout excluído");
  } catch (e) { toast(e.message, true); }
});

for (const [el, field] of [[$("layW"), "width"], [$("layH"), "height"]]) {
  el.addEventListener("change", () => {
    if (!layout) return;
    layout[field] = Math.max(field === "width" ? 320 : 240, +el.value || 0);
    el.value = layout[field];
    renderCanvas();
    schedSave("layout", () => api("PUT", "/api/layouts/" + layout.id, {
      width: layout.width, height: layout.height,
    }));
  });
}
$("layBg").addEventListener("change", () => {
  if (!layout) return;
  layout.background = $("layBg").value;
  renderCanvas();
  schedSave("layout-bg", () => api("PUT", "/api/layouts/" + layout.id, {
    background: layout.background,
  }));
});

document.querySelectorAll(".preset").forEach((b) =>
  b.addEventListener("click", async () => {
    if (!layout) return;
    if (layout.containers.length &&
        !(await confirmDlg("Aplicar o preset substitui todos os containers atuais deste layout. Continuar?")))
      return;
    try {
      layout = await api("POST", `/api/layouts/${layout.id}/preset`, { preset: b.dataset.preset });
      selectedId = null;
      renderCanvas(); renderProps();
      toast("Preset aplicado");
    } catch (e) { toast(e.message, true); }
  }));

// ------------------------------------------------------------------ botões principais

$("btnSave").addEventListener("click", async () => {
  await flushSaves();
  toast("Configurações salvas");
});

$("btnPreview").addEventListener("click", async () => {
  if (!layout) return;
  await flushSaves();
  window.open(`/player?preview=1&layout_id=${layout.id}`, "_blank");
});

$("btnApply").addEventListener("click", async () => {
  if (!layout) return;
  await flushSaves();
  try {
    await api("POST", `/api/layouts/${layout.id}/apply`);
    await loadLayouts(layout.id);
    toast("Layout aplicado no videowall — o player recarrega em instantes");
  } catch (e) { toast(e.message, true); }
});

$("btnDefault").addEventListener("click", async () => {
  if (!layout) return;
  try {
    await api("POST", `/api/layouts/${layout.id}/set-default`);
    await loadLayouts(layout.id);
    toast("Layout definido como padrão");
  } catch (e) { toast(e.message, true); }
});

$("btnRestart").addEventListener("click", async () => {
  try {
    await api("POST", "/api/player/restart");
    toast("Reinício do player solicitado");
  } catch (e) { toast(e.message, true); }
});

$("btnLogout").addEventListener("click", async () => {
  await api("POST", "/api/logout").catch(() => {});
  location.href = "/login";
});

// ------------------------------------------------------------------ canvas do editor

function canvasScale() {
  const wrap = $("canvasWrap");
  const availW = wrap.clientWidth - 44, availH = wrap.clientHeight - 44;
  return Math.max(0.05, Math.min(availW / layout.width, availH / layout.height));
}

function renderCanvas() {
  const cv = $("canvas");
  cv.innerHTML = "";
  if (!layout) { cv.style.width = "0"; return; }
  scale = canvasScale();
  cv.style.width = layout.width * scale + "px";
  cv.style.height = layout.height * scale + "px";
  cv.style.background = layout.background;
  cv.style.backgroundSize = `${60 * scale}px ${60 * scale}px`;
  cv.style.backgroundImage =
    "linear-gradient(rgba(255,255,255,.05) 1px,transparent 1px)," +
    "linear-gradient(90deg,rgba(255,255,255,.05) 1px,transparent 1px)";

  for (const c of layout.containers) {
    const el = document.createElement("div");
    el.className = "cbox" + (c.active ? "" : " inactive") + (c.id === selectedId ? " selected" : "");
    el.dataset.id = c.id;
    positionBox(el, c);
    el.style.zIndex = 10 + (c.z_index | 0);
    const nItems = (c.contents || []).filter((i) => i.active).length;
    el.innerHTML =
      `<div class="cname">${esc(c.name)}</div>` +
      `<div class="cbadge">${nItems ? "▤ " + nItems : "vazio"}</div>` +
      `<div class="cinfo">${c.w}×${c.h} · ${aspectLabel(c.w, c.h)}</div>`;
    if (c.id === selectedId) {
      for (const dir of ["nw", "n", "ne", "e", "se", "s", "sw", "w"]) {
        const h = document.createElement("div");
        h.className = "handle h-" + dir;
        h.dataset.dir = dir;
        el.appendChild(h);
      }
    }
    cv.appendChild(el);
  }
}

function positionBox(el, c) {
  el.style.left = c.x * scale + "px";
  el.style.top = c.y * scale + "px";
  el.style.width = c.w * scale + "px";
  el.style.height = c.h * scale + "px";
}

function snap(v) { return $("snapToggle").checked ? Math.round(v / SNAP) * SNAP : Math.round(v); }
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function saveGeometry(c) {
  schedSave("container-" + c.id, () => api("PUT", "/api/containers/" + c.id, {
    x: c.x, y: c.y, w: c.w, h: c.h,
  }));
}

// arrastar / redimensionar
$("canvas").addEventListener("pointerdown", (e) => {
  if (!layout) return;
  const handle = e.target.closest(".handle");
  const box = e.target.closest(".cbox");
  if (!box) { selectedId = null; renderCanvas(); renderProps(); return; }
  const c = layout.containers.find((k) => k.id === +box.dataset.id);
  if (!c) return;
  if (selectedId !== c.id) { selectedId = c.id; renderCanvas(); renderProps(); }
  const el = $("canvas").querySelector(`.cbox[data-id="${c.id}"]`);
  const mode = handle ? "resize" : "move";
  const dir = handle ? handle.dataset.dir : "";
  const startX = e.clientX, startY = e.clientY;
  const orig = { x: c.x, y: c.y, w: c.w, h: c.h };
  el.setPointerCapture(e.pointerId);
  e.preventDefault();

  const onMove = (ev) => {
    const dx = (ev.clientX - startX) / scale;
    const dy = (ev.clientY - startY) / scale;
    if (mode === "move") {
      c.x = clamp(snap(orig.x + dx), 0, layout.width - c.w);
      c.y = clamp(snap(orig.y + dy), 0, layout.height - c.h);
    } else {
      let { x, y, w, h } = orig;
      if (dir.includes("e")) w = snap(orig.w + dx);
      if (dir.includes("s")) h = snap(orig.h + dy);
      if (dir.includes("w")) { x = snap(orig.x + dx); w = orig.w + (orig.x - x); }
      if (dir.includes("n")) { y = snap(orig.y + dy); h = orig.h + (orig.y - y); }
      w = clamp(w, 60, layout.width - Math.max(0, x));
      h = clamp(h, 40, layout.height - Math.max(0, y));
      x = clamp(x, 0, layout.width - 60);
      y = clamp(y, 0, layout.height - 40);
      Object.assign(c, { x, y, w, h });
    }
    positionBox(el, c);
    el.querySelector(".cinfo").textContent = `${c.w}×${c.h} · ${aspectLabel(c.w, c.h)}`;
    fillGeometryInputs(c);
  };
  const onUp = () => {
    el.removeEventListener("pointermove", onMove);
    el.removeEventListener("pointerup", onUp);
    if (c.x !== orig.x || c.y !== orig.y || c.w !== orig.w || c.h !== orig.h) saveGeometry(c);
  };
  el.addEventListener("pointermove", onMove);
  el.addEventListener("pointerup", onUp);
});

document.addEventListener("keydown", (e) => {
  if (["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement.tagName)) return;
  if (!$("view-editor").classList.contains("active")) return;
  const c = selContainer();
  if (!c) return;
  const step = e.shiftKey ? 1 : SNAP;
  let moved = true;
  if (e.key === "ArrowLeft") c.x = clamp(c.x - step, 0, layout.width - c.w);
  else if (e.key === "ArrowRight") c.x = clamp(c.x + step, 0, layout.width - c.w);
  else if (e.key === "ArrowUp") c.y = clamp(c.y - step, 0, layout.height - c.h);
  else if (e.key === "ArrowDown") c.y = clamp(c.y + step, 0, layout.height - c.h);
  else if (e.key === "Delete") { moved = false; $("btnDelContainer").click(); }
  else moved = false;
  if (moved) {
    e.preventDefault();
    renderCanvas(); fillGeometryInputs(c); saveGeometry(c);
  }
});

window.addEventListener("resize", () => { if (layout) renderCanvas(); });

// ------------------------------------------------------------------ propriedades do container

function fillGeometryInputs(c) {
  $("pX").value = c.x; $("pY").value = c.y; $("pW").value = c.w; $("pH").value = c.h;
  const ar = aspectLabel(c.w, c.h);
  $("pAspect").textContent = "Proporção " + ar + (ar === "16:9" ? "  ✓ ideal p/ vídeo e Power BI" : "");
}

function renderProps() {
  const c = selContainer();
  $("propsEmpty").hidden = !!c;
  $("propsForm").hidden = !c;
  if (!c) return;
  $("propTitle").textContent = c.name;
  $("pName").value = c.name;
  fillGeometryInputs(c);
  $("pZ").value = c.z_index;
  $("pFit").value = c.fit_mode;
  $("pBg").value = c.background;
  $("pActive").checked = !!c.active;
  $("pTitle").checked = !!c.show_title;
  $("pBorder").checked = !!c.show_border;
  $("pBorderColor").value = c.border_color;
  renderPlaylist();
}

function bindProp(el, field, transform) {
  el.addEventListener("change", () => {
    const c = selContainer();
    if (!c) return;
    c[field] = transform ? transform(el) : el.value;
    if (field === "name") $("propTitle").textContent = c.name;
    if (["x", "y", "w", "h"].includes(field)) {
      c.x = clamp(c.x | 0, 0, Math.max(0, layout.width - 60));
      c.y = clamp(c.y | 0, 0, Math.max(0, layout.height - 40));
      c.w = clamp(c.w | 0, 60, layout.width - c.x);
      c.h = clamp(c.h | 0, 40, layout.height - c.y);
      fillGeometryInputs(c);
    }
    renderCanvas();
    schedSave("container-" + c.id, () => api("PUT", "/api/containers/" + c.id, {
      name: c.name, x: c.x, y: c.y, w: c.w, h: c.h, z_index: c.z_index,
      fit_mode: c.fit_mode, background: c.background, active: c.active,
      show_title: c.show_title, show_border: c.show_border, border_color: c.border_color,
    }));
  });
}
bindProp($("pName"), "name");
bindProp($("pX"), "x", (el) => +el.value || 0);
bindProp($("pY"), "y", (el) => +el.value || 0);
bindProp($("pW"), "w", (el) => +el.value || 0);
bindProp($("pH"), "h", (el) => +el.value || 0);
bindProp($("pZ"), "z_index", (el) => +el.value || 0);
bindProp($("pFit"), "fit_mode");
bindProp($("pBg"), "background");
bindProp($("pActive"), "active", (el) => el.checked ? 1 : 0);
bindProp($("pTitle"), "show_title", (el) => el.checked ? 1 : 0);
bindProp($("pBorder"), "show_border", (el) => el.checked ? 1 : 0);
bindProp($("pBorderColor"), "border_color");

$("btnAddContainer").addEventListener("click", async () => {
  if (!layout) return toast("Crie um layout primeiro", true);
  try {
    const c = await api("POST", `/api/layouts/${layout.id}/containers`, {
      name: `Container ${layout.containers.length + 1}`,
      w: Math.round(layout.width / 3), h: Math.round(layout.height / 3),
    });
    layout.containers.push(c);
    selectedId = c.id;
    renderCanvas(); renderProps();
  } catch (e) { toast(e.message, true); }
});

$("btnDelContainer").addEventListener("click", async () => {
  const c = selContainer();
  if (!c) return;
  if (!(await confirmDlg(`Excluir o container "${c.name}"?`))) return;
  try {
    await api("DELETE", "/api/containers/" + c.id);
    layout.containers = layout.containers.filter((k) => k.id !== c.id);
    selectedId = null;
    renderCanvas(); renderProps();
  } catch (e) { toast(e.message, true); }
});

$("btnDupContainer").addEventListener("click", async () => {
  const c = selContainer();
  if (!c) return;
  try {
    const nc = await api("POST", `/api/containers/${c.id}/duplicate`);
    layout.containers.push(nc);
    selectedId = nc.id;
    renderCanvas(); renderProps();
  } catch (e) { toast(e.message, true); }
});

$("btnFullContainer").addEventListener("click", () => {
  const c = selContainer();
  if (!c) return;
  Object.assign(c, { x: 0, y: 0, w: layout.width, h: layout.height });
  renderCanvas(); fillGeometryInputs(c); saveGeometry(c);
});

$("btn169").addEventListener("click", () => {
  const c = selContainer();
  if (!c) return;
  let h = Math.round(c.w * 9 / 16);
  if (c.y + h > layout.height) {            // não cabe na altura: ajusta a largura
    h = layout.height - c.y;
    c.w = Math.min(c.w, Math.round(h * 16 / 9));
  }
  c.h = h;
  renderCanvas(); fillGeometryInputs(c); saveGeometry(c);
});

// ------------------------------------------------------------------ playlist

const TYPE_ICON = { web: "🌐", image: "🖼", video: "🎬", image_folder: "🗂" };
const TYPE_NAME = { web: "Site/Dashboard", image: "Imagem", video: "Vídeo", image_folder: "Pasta de imagens" };

function renderPlaylist() {
  const c = selContainer();
  const box = $("playlist");
  box.innerHTML = "";
  if (!c) return;
  const items = (c.contents || []).slice().sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);
  if (!items.length)
    box.innerHTML = '<div class="muted">Nenhum conteúdo. Adicione abaixo.</div>';
  items.forEach((it, idx) => {
    const div = document.createElement("div");
    div.className = "pl-item" + (it.active ? "" : " inactive");
    const dur = it.duration > 0 ? it.duration + "s"
      : it.type === "video" ? "até o fim" : "fixo";
    const extra = [
      it.refresh > 0 ? `↻${it.refresh}s` : "",
      it.loop ? "∞ loop" : "",
      it.type === "image_folder" ? `img ${it.img_interval}s` : "",
      it.type === "video" && it.volume > 0 ? `vol ${it.volume}` : "",
    ].filter(Boolean).join(" · ");
    div.innerHTML =
      `<span class="pl-type" title="${TYPE_NAME[it.type]}">${TYPE_ICON[it.type] || "❔"}</span>` +
      `<div class="pl-info"><div class="pl-name">${esc(it.name || it.source)}</div>` +
      `<div class="pl-meta">${dur}${extra ? " · " + extra : ""} · ${esc(it.source)}</div></div>` +
      `<div class="pl-actions">` +
      `<button class="icobtn" data-act="up" title="Subir" ${idx === 0 ? "disabled" : ""}>▲</button>` +
      `<button class="icobtn" data-act="down" title="Descer" ${idx === items.length - 1 ? "disabled" : ""}>▼</button>` +
      `<button class="icobtn" data-act="toggle" title="Ativar/desativar">${it.active ? "⏸" : "▶"}</button>` +
      `<button class="icobtn" data-act="edit" title="Editar">✎</button>` +
      `<button class="icobtn" data-act="del" title="Excluir">🗑</button></div>`;
    div.querySelectorAll(".icobtn").forEach((b) =>
      b.addEventListener("click", () => playlistAction(b.dataset.act, it)));
    box.appendChild(div);
  });
}

async function reloadSelectedContainer() {
  const fresh = await api("GET", "/api/layouts/" + layout.id);
  layout = fresh;
  renderCanvas(); renderProps();
}

async function playlistAction(act, it) {
  try {
    if (act === "up" || act === "down")
      await api("POST", `/api/contents/${it.id}/move`, { direction: act });
    else if (act === "toggle")
      await api("PUT", "/api/contents/" + it.id, { active: it.active ? 0 : 1 });
    else if (act === "edit")
      return openContentModal(it);
    else if (act === "del") {
      if (!(await confirmDlg(`Excluir o conteúdo "${it.name || it.source}"?`))) return;
      await api("DELETE", "/api/contents/" + it.id);
    }
    await reloadSelectedContainer();
  } catch (e) { toast(e.message, true); }
}

$("btnAddContent").addEventListener("click", () => {
  if (selContainer()) openContentModal(null);
});

// modal de conteúdo
let editingContent = null;

function syncContentModalFields() {
  const t = $("cmType").value;
  $("cmSourceLbl").textContent =
    t === "web" ? "URL ou código <iframe>" : t === "image_folder" ? "Pasta (dentro de mídia)" : "Arquivo (mídia ou URL)";
  $("cmSource").placeholder =
    t === "web" ? "URL, link do YouTube, código <iframe …>, ou /static/pages/relogio.html"
    : t === "image_folder" ? "ex.: campanhas/junho" : "ex.: videos/institucional.mp4";
  $("cmBrowse").hidden = t === "web";
  $("cmTest").hidden = t !== "web";
  $("cmRefreshWrap").style.display = t === "web" ? "" : "none";
  $("cmVolumeWrap").style.display = t === "video" ? "" : "none";
  $("cmLoopWrap").style.display = t === "video" ? "" : "none";
  $("cmIntervalWrap").style.display = t === "image_folder" ? "" : "none";
  $("cmDurHint").textContent =
    t === "video" ? "0 = reproduzir até o fim" : "0 = fixo (não rotaciona)";
}
$("cmType").addEventListener("change", syncContentModalFields);

// Mostra ao vivo o que foi colado (URL × código iframe × YouTube).
$("cmSource").addEventListener("input", () => {
  $("cmSourceHint").textContent = describeSource($("cmSource").value);
});
// Ao sair do campo: extrai o src do <iframe>, atualiza a dica e valida automaticamente.
$("cmSource").addEventListener("blur", () => {
  const v = extractIframeSrc($("cmSource").value);
  if (v !== $("cmSource").value.trim()) $("cmSource").value = v;
  $("cmSourceHint").textContent = describeSource($("cmSource").value);
  autoValidate();
});

// Valida no servidor conforme o tipo (site/HLS/vídeo/embed/interna/mídia).
let validateSeq = 0;
async function autoValidate() {
  const val = $("cmSource").value.trim();
  const msg = $("cmTestMsg");
  if (!val) { msg.textContent = ""; msg.className = "tmsg"; return; }
  const seq = ++validateSeq;
  msg.textContent = "Validando…"; msg.className = "tmsg";
  try {
    const r = await api("POST", "/api/check-url", { url: val });
    if (seq !== validateSeq) return;                 // ignora resposta antiga
    msg.textContent = (r.ok ? "✓ " : "✗ ") + (r.note || "") + (r.frame_blocked ? " ⚠" : "");
    msg.className = "tmsg " + (r.ok ? (r.frame_blocked ? "warn" : "ok") : "err");
  } catch (e) {
    if (seq !== validateSeq) return;
    msg.textContent = "✗ " + e.message; msg.className = "tmsg err";
  }
}

function openContentModal(it) {
  editingContent = it;
  $("cmTitle").textContent = it ? "Editar conteúdo" : "Novo conteúdo";
  $("cmName").value = it ? it.name : "";
  $("cmType").value = it ? it.type : "web";
  $("cmSource").value = it ? it.source : "";
  $("cmDuration").value = it ? it.duration : 60;
  $("cmRefresh").value = it ? it.refresh : 0;
  $("cmVolume").value = it ? it.volume : 0;
  $("cmInterval").value = it ? it.img_interval : 10;
  $("cmActive").checked = it ? !!it.active : true;
  $("cmLoop").checked = it ? !!it.loop : false;
  $("cmTestMsg").textContent = "";
  $("cmSourceHint").textContent = describeSource(it ? it.source : "");
  syncContentModalFields();
  openModal("contentModal");
}

$("cmCancel").addEventListener("click", closeModals);

$("cmSave").addEventListener("click", async () => {
  const c = selContainer();
  if (!c) return;
  const body = {
    name: $("cmName").value.trim(),
    type: $("cmType").value,
    source: extractIframeSrc($("cmSource").value),
    duration: +$("cmDuration").value || 0,
    refresh: +$("cmRefresh").value || 0,
    volume: +$("cmVolume").value || 0,
    img_interval: +$("cmInterval").value || 10,
    active: $("cmActive").checked ? 1 : 0,
    loop: $("cmLoop").checked ? 1 : 0,
  };
  if (!body.source) return toast("Informe a URL ou caminho", true);
  try {
    if (editingContent) await api("PUT", "/api/contents/" + editingContent.id, body);
    else await api("POST", `/api/containers/${c.id}/contents`, body);
    closeModals();
    await reloadSelectedContainer();
    toast("Conteúdo salvo");
  } catch (e) { toast(e.message, true); }
});

$("cmTest").addEventListener("click", autoValidate);

// seletor de mídia (para imagem / vídeo / pasta)
let pkPath = "", pkMode = "image";

$("cmBrowse").addEventListener("click", () => {
  pkMode = $("cmType").value; // image | video | image_folder
  pkPath = "";
  openModal("pickerModal");
  loadPicker();
});
$("pkCancel").addEventListener("click", () => openModal("contentModal"));
$("pkUp").addEventListener("click", () => {
  pkPath = pkPath.split("/").slice(0, -1).join("/");
  loadPicker();
});

async function loadPicker() {
  const data = await api("GET", "/api/media?path=" + encodeURIComponent(pkPath));
  $("pkPath").textContent = "/" + pkPath;
  $("pkUp").hidden = !pkPath;
  const grid = $("pkGrid");
  grid.innerHTML = "";
  if (pkMode === "image_folder" && pkPath) {
    const useBtn = document.createElement("button");
    useBtn.className = "btn sm primary";
    useBtn.textContent = "✓ Usar esta pasta (/" + pkPath + ")";
    useBtn.onclick = () => { $("cmSource").value = pkPath; openModal("contentModal"); };
    grid.appendChild(useBtn);
  }
  for (const f of data.folders) {
    const card = document.createElement("div");
    card.className = "mcard";
    card.innerHTML = `<div class="mthumb">📁</div><div class="mname">${esc(f.name)}</div><div class="msize">pasta</div>`;
    card.onclick = () => { pkPath = f.path; loadPicker(); };
    grid.appendChild(card);
  }
  const want = pkMode === "video" ? "video" : "image";
  for (const f of data.files.filter((x) => pkMode !== "image_folder" && x.kind === want)) {
    const card = document.createElement("div");
    card.className = "mcard";
    const thumb = f.kind === "image"
      ? `<img src="/media/${encodeURI(f.path)}" loading="lazy">` : "🎬";
    card.innerHTML = `<div class="mthumb">${thumb}</div><div class="mname">${esc(f.name)}</div>` +
      `<div class="msize">${fmtSize(f.size)}</div>`;
    card.onclick = () => { $("cmSource").value = f.path; openModal("contentModal"); };
    grid.appendChild(card);
  }
  if (!grid.childElementCount)
    grid.innerHTML = '<div class="muted">Nada aqui. Envie arquivos na aba Mídia.</div>';
}

// ------------------------------------------------------------------ mídia

let mediaPath = "";
const fmtSize = (b) =>
  b > 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(b / 1024)) + " KB";

async function loadMedia(path) {
  mediaPath = path || "";
  const data = await api("GET", "/api/media?path=" + encodeURIComponent(mediaPath));
  $("mediaPath").textContent = "/" + mediaPath;
  $("btnMediaUp").hidden = !mediaPath;
  const grid = $("mediaGrid");
  grid.innerHTML = "";
  for (const f of data.folders) {
    const card = document.createElement("div");
    card.className = "mcard";
    card.innerHTML = `<div class="mthumb">📁</div><div class="mname">${esc(f.name)}</div>` +
      `<div class="msize">pasta</div><button class="mdel" title="Excluir">🗑</button>`;
    card.querySelector(".mdel").onclick = (e) => { e.stopPropagation(); delMedia(f.path, true); };
    card.onclick = () => loadMedia(f.path);
    grid.appendChild(card);
  }
  for (const f of data.files) {
    const card = document.createElement("div");
    card.className = "mcard";
    const thumb = f.kind === "image"
      ? `<img src="/media/${encodeURI(f.path)}" loading="lazy">`
      : f.kind === "video" ? "🎬" : "📄";
    card.innerHTML = `<div class="mthumb">${thumb}</div><div class="mname" title="${esc(f.path)}">${esc(f.name)}</div>` +
      `<div class="msize">${fmtSize(f.size)} · clique copia o caminho</div>` +
      `<button class="mdel" title="Excluir">🗑</button>`;
    card.querySelector(".mdel").onclick = (e) => { e.stopPropagation(); delMedia(f.path, false); };
    card.onclick = () => {
      navigator.clipboard?.writeText(f.path);
      toast("Caminho copiado: " + f.path);
    };
    grid.appendChild(card);
  }
  if (!grid.childElementCount)
    grid.innerHTML = '<div class="muted">Pasta vazia — use “Enviar arquivos”.</div>';
}

async function delMedia(path, isFolder) {
  if (!(await confirmDlg(isFolder
    ? `Excluir a pasta "/${path}" e todo o conteúdo?` : `Excluir o arquivo "/${path}"?`))) return;
  try {
    await api("DELETE", "/api/media?path=" + encodeURIComponent(path));
    loadMedia(mediaPath);
  } catch (e) { toast(e.message, true); }
}

$("btnMediaUp").addEventListener("click", () =>
  loadMedia(mediaPath.split("/").slice(0, -1).join("/")));

$("btnNewFolder").addEventListener("click", async () => {
  const name = await promptDlg("Nome da nova pasta");
  if (!name) return;
  try {
    await api("POST", "/api/media/folder", { path: mediaPath, name });
    loadMedia(mediaPath);
  } catch (e) { toast(e.message, true); }
});

$("btnUpload").addEventListener("click", () => $("fileInput").click());
$("fileInput").addEventListener("change", async (e) => {
  const files = [...e.target.files];
  e.target.value = "";
  const prog = $("uploadProgress"), bar = $("uploadBar"), label = $("uploadLabel");
  prog.hidden = false;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    label.textContent = `Enviando ${i + 1}/${files.length}: ${f.name}`;
    try {
      await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("PUT", `/api/media/upload?folder=${encodeURIComponent(mediaPath)}&name=${encodeURIComponent(f.name)}`);
        xhr.upload.onprogress = (ev) =>
          { if (ev.lengthComputable) bar.style.width = (ev.loaded / ev.total * 100) + "%"; };
        xhr.onload = () => xhr.status < 300 ? resolve()
          : reject(new Error(JSON.parse(xhr.responseText || "{}").error || "falha no envio"));
        xhr.onerror = () => reject(new Error("falha de rede no envio"));
        xhr.send(f);
      });
    } catch (err) { toast(`${f.name}: ${err.message}`, true); }
  }
  prog.hidden = true;
  loadMedia(mediaPath);
  toast("Envio concluído");
});

// ------------------------------------------------------------------ status

async function refreshStatus() {
  try {
    const s = await api("GET", "/api/status");
    const hb = s.last_heartbeat
      ? new Date(s.last_heartbeat * 1000).toLocaleString("pt-BR") : "nunca";
    $("statusCards").innerHTML = `
      <div class="card"><h3>Player</h3>
        <div class="bignum" style="color:${s.player_online ? "var(--ok)" : "var(--err)"}">
          ${s.player_online ? "● Online" : "● Offline"}</div>
        <div class="muted">último sinal: ${hb}</div></div>
      <div class="card"><h3>Layout no ar</h3>
        <div class="bignum">${esc(s.active_layout ? s.active_layout.name : "—")}</div>
        <div class="muted">versão da configuração: ${esc(s.version)}</div></div>
      <div class="card"><h3>Interface do player</h3>
        <div class="bignum">${s.lock_ui ? "🔒 Bloqueada" : "🔓 Livre"}</div>
        <div class="muted">altere em Configurações → Exibição</div></div>`;
    const logs = await api("GET", "/api/logs?limit=100");
    $("logTable").querySelector("tbody").innerHTML = logs.logs.map((l) =>
      `<tr><td>${esc(l.ts)}</td><td class="lvl-${esc(l.level)}">${esc(l.level)}</td>` +
      `<td>${esc(l.source)}</td><td>${esc(l.message)}</td></tr>`).join("") ||
      '<tr><td colspan="4" class="muted">Nenhum log registrado.</td></tr>';
  } catch (e) { toast(e.message, true); }
}
$("btnRefreshStatus").addEventListener("click", refreshStatus);
$("btnClearLogs").addEventListener("click", async () => {
  await api("POST", "/api/logs/clear").catch(() => {});
  refreshStatus();
});

async function pollDot() {
  try {
    const s = await api("GET", "/api/status");
    $("playerDot").className = "dot " + (s.player_online ? "on" : "off");
    $("playerDot").title = s.player_online ? "Player online" : "Player offline";
  } catch { /* sessão expirada redireciona via api() */ }
}
setInterval(pollDot, 12000);

// ------------------------------------------------------------------ configurações

async function loadConfigView() {
  try {
    const s = await api("GET", "/api/status");
    $("cfgLock").checked = s.lock_ui;
  } catch {}
}

$("btnChangePass").addEventListener("click", async () => {
  try {
    await api("POST", "/api/password", {
      current: $("cfgCur").value, new: $("cfgNew").value,
    });
    $("cfgCur").value = $("cfgNew").value = "";
    $("passMsg").textContent = "✓ Senha alterada";
    $("defaultPassWarn").hidden = true;
    toast("Senha alterada com sucesso");
  } catch (e) { $("passMsg").textContent = "✗ " + e.message; }
});

$("btnSaveDisplay").addEventListener("click", async () => {
  try {
    await api("POST", "/api/settings", { lock_ui: $("cfgLock").checked });
    toast("Configuração de exibição salva");
  } catch (e) { toast(e.message, true); }
});

$("btnExport").addEventListener("click", async () => {
  const data = await api("GET", "/api/export");
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "videowall-config-" + new Date().toISOString().slice(0, 10) + ".json";
  a.click();
});

$("btnImport").addEventListener("click", () => $("importInput").click());
$("importInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  if (!(await confirmDlg("Importar substitui TODOS os layouts e containers atuais. Continuar?"))) return;
  try {
    const data = JSON.parse(await file.text());
    const r = await api("POST", "/api/import", data);
    await loadLayouts();
    toast(`Importação concluída (${r.layouts} layouts)`);
  } catch (err) { toast(err.message, true); }
});

$("btnTestUrl").addEventListener("click", async () => {
  $("testUrlMsg").textContent = "Testando…";
  try {
    const r = await api("POST", "/api/check-url", { url: $("cfgTestUrl").value.trim() });
    $("testUrlMsg").textContent = (r.ok ? "✓ " : "✗ ") + (r.note || "") +
      (r.frame_blocked ? " — ⚠ pode não abrir em container" : "");
  } catch (e) { $("testUrlMsg").textContent = "✗ " + e.message; }
});

// ------------------------------------------------------------------ inicialização

(async function init() {
  try {
    const me = await api("GET", "/api/me");
    $("defaultPassWarn").hidden = !me.default_password;
    await loadLayouts();
    pollDot();
  } catch (e) { toast(e.message, true); }
})();

window.addEventListener("beforeunload", (e) => {
  if (pending.size) { e.preventDefault(); e.returnValue = ""; }
});

})();
