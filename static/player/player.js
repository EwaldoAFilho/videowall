/* VideoWall Player — renderiza o layout ativo e roda as playlists de cada container. */
(() => {
  "use strict";

  const params = new URLSearchParams(location.search);
  const PREVIEW = params.get("preview") === "1";
  const LAYOUT_ID = params.get("layout_id");
  const stage = document.getElementById("stage");
  const offlineBadge = document.getElementById("offline");

  let state = null;          // estado vindo do servidor
  let runners = [];          // PlaylistRunner por container
  let pollFailures = 0;

  const mediaUrl = (src) =>
    /^(https?:)?\/\//.test(src) || src.startsWith("/")
      ? src
      : "/media/" + src.split("/").map(encodeURIComponent).join("/");

  function logServer(level, source, message) {
    if (PREVIEW) return;
    fetch("/api/player/log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ level, source, message: String(message).slice(0, 480) }),
    }).catch(() => {});
  }

  window.addEventListener("error", (e) =>
    logServer("error", "player.js", e.message || "erro de script"));

  // ---------------------------------------------------------------- playlist

  class PlaylistRunner {
    constructor(container, contentEl, scale) {
      this.c = container;
      this.el = contentEl;
      this.scale = scale;
      this.items = (container.contents || [])
        .filter((i) => i.active)
        .sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);
      this.idx = -1;
      this.timers = [];
      this.errStreak = 0;
    }

    start() {
      if (!this.items.length) {
        this.el.innerHTML =
          `<div class="vw-placeholder"><b>${esc(this.c.name)}</b><span>sem conteúdo configurado</span></div>`;
        return;
      }
      this.next();
    }

    stop() { this.clearTimers(); }

    clearTimers() {
      this.timers.forEach(clearTimeout);
      this.timers = [];
    }

    after(seconds, fn) {
      this.timers.push(setTimeout(fn, seconds * 1000));
    }

    every(seconds, fn) {
      const tick = () => { fn(); this.after(seconds, tick); };
      this.after(seconds, tick);
    }

    next() {
      this.clearTimers();
      if (this.errStreak >= this.items.length && this.items.length > 0) {
        // todos os itens falharam: aguarda e tenta o ciclo novamente
        this.el.innerHTML =
          `<div class="vw-placeholder"><b>${esc(this.c.name)}</b><span>falha ao carregar conteúdos — nova tentativa em 30s</span></div>`;
        this.errStreak = 0;
        this.after(30, () => this.next());
        return;
      }
      this.idx = (this.idx + 1) % this.items.length;
      this.show(this.items[this.idx]);
    }

    fail(item, why) {
      logServer("error", `${this.c.name} / ${item.name || item.source}`, why);
      this.errStreak++;
      this.after(4, () => this.next());
    }

    show(item) {
      this.el.innerHTML = "";
      const dur = item.duration | 0;
      const single = this.items.length === 1;
      const fit = this.c.fit_mode || "contain";

      if (item.type === "image") {
        const img = document.createElement("img");
        img.style.objectFit = fit;
        img.onload = () => { this.errStreak = 0; };
        img.onerror = () => this.fail(item, "imagem não carregou: " + item.source);
        img.src = mediaUrl(item.source);
        this.el.appendChild(img);
        if (!single || dur > 0) this.after(dur > 0 ? dur : 60, () => this.next());

      } else if (item.type === "video") {
        const v = document.createElement("video");
        v.style.objectFit = fit;
        v.autoplay = true;
        v.playsInline = true;
        const vol = Math.max(0, Math.min(100, item.volume | 0));
        v.muted = vol === 0;
        v.volume = vol / 100;
        v.loop = !!item.loop && single && dur === 0;
        v.onerror = () => this.fail(item, "vídeo não carregou: " + item.source);
        v.onended = () => {
          if (v.loop) return;
          if (item.loop && dur === 0) { v.currentTime = 0; v.play().catch(() => {}); }
          else this.next();
        };
        v.oncanplay = () => { this.errStreak = 0; };
        v.src = mediaUrl(item.source);
        v.play().catch(() => {});
        this.el.appendChild(v);
        if (dur > 0) this.after(dur, () => this.next());
        // dur==0 e sem loop: avança no 'ended'

      } else if (item.type === "image_folder") {
        fetch("/api/player/folder?path=" + encodeURIComponent(item.source))
          .then((r) => r.json())
          .then((data) => {
            const imgs = data.images || [];
            if (!imgs.length) return this.fail(item, "pasta sem imagens: " + item.source);
            this.errStreak = 0;
            const img = document.createElement("img");
            img.style.objectFit = fit;
            this.el.appendChild(img);
            let i = 0;
            img.src = mediaUrl(imgs[0]);
            const step = Math.max(2, item.img_interval | 0 || 10);
            if (imgs.length > 1) this.every(step, () => {
              i = (i + 1) % imgs.length;
              img.src = mediaUrl(imgs[i]);
            });
            if (dur > 0) this.after(dur, () => this.next());
            else if (!single) this.after(step * imgs.length, () => this.next());
          })
          .catch(() => this.fail(item, "erro ao listar pasta: " + item.source));

      } else { // web
        const f = document.createElement("iframe");
        f.setAttribute("allow", "autoplay; fullscreen");
        f.onload = () => { this.errStreak = 0; };
        f.src = item.source;
        this.el.appendChild(f);
        const refresh = item.refresh | 0;
        if (refresh > 0) this.every(Math.max(10, refresh), () => { f.src = item.source; });
        if (!single || dur > 0) this.after(dur > 0 ? dur : 60, () => this.next());
      }
    }
  }

  // ---------------------------------------------------------------- render

  function esc(s) {
    return String(s ?? "").replace(/[&<>"]/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  function render() {
    runners.forEach((r) => r.stop());
    runners = [];
    stage.innerHTML = "";
    const lay = state && state.layout;
    if (!lay) {
      stage.innerHTML =
        '<div class="vw-placeholder" style="height:100vh"><b>VideoWall</b><span>nenhum layout ativo — configure no painel administrativo</span></div>';
      return;
    }
    document.body.classList.toggle("locked", !!state.lock_ui && !PREVIEW);
    stage.style.background = lay.background || "#000";
    const sx = window.innerWidth / lay.width;
    const sy = window.innerHeight / lay.height;

    for (const c of lay.containers.filter((c) => c.active)) {
      const div = document.createElement("div");
      div.className = "vw-container";
      div.style.left = c.x * sx + "px";
      div.style.top = c.y * sy + "px";
      div.style.width = c.w * sx + "px";
      div.style.height = c.h * sy + "px";
      div.style.zIndex = c.z_index;
      div.style.background = c.background || "#000";
      if (c.show_border)
        div.style.boxShadow = `inset 0 0 0 2px ${c.border_color || "#3b82f6"}`;

      const content = document.createElement("div");
      content.className = "vw-content";
      if (c.show_title) {
        const th = Math.max(22, Math.round(34 * sy));
        const t = document.createElement("div");
        t.className = "vw-title";
        t.style.height = th + "px";
        t.style.fontSize = Math.round(th * 0.5) + "px";
        t.textContent = c.name;
        div.appendChild(t);
        content.style.top = th + "px";
      }
      div.appendChild(content);
      stage.appendChild(div);

      const runner = new PlaylistRunner(c, content, { sx, sy });
      runners.push(runner);
      runner.start();
    }
  }

  // ---------------------------------------------------------------- ciclo de vida

  async function loadState() {
    const q = LAYOUT_ID ? "?layout_id=" + encodeURIComponent(LAYOUT_ID) : "";
    const r = await fetch("/api/player/state" + q, { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    state = await r.json();
    render();
  }

  async function poll() {
    try {
      const r = await fetch("/api/player/heartbeat" + (PREVIEW ? "?preview=1" : ""), {
        method: "POST", cache: "no-store",
      });
      const data = await r.json();
      pollFailures = 0;
      offlineBadge.style.display = "none";
      if (state && data.version !== state.version && !LAYOUT_ID) {
        location.reload(); // nova configuração aplicada ou reinício solicitado
      }
    } catch {
      pollFailures++;
      offlineBadge.style.display = "block";
      if (pollFailures >= 40) location.reload(); // ~6 min sem servidor: força recuperação
    }
  }

  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(render, 300);
  });
  document.addEventListener("contextmenu", (e) => {
    if (document.body.classList.contains("locked")) e.preventDefault();
  });

  loadState().catch((e) => {
    logServer("error", "player", "falha ao carregar estado: " + e.message);
    stage.innerHTML =
      '<div class="vw-placeholder" style="height:100vh"><b>VideoWall</b><span>servidor indisponível — tentando novamente…</span></div>';
    setTimeout(() => location.reload(), 10000);
  });
  setInterval(poll, 9000);
})();
