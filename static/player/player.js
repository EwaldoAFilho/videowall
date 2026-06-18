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

  // Detecta URLs de mídia direta para tocar nativamente (sem iframe, sem "play").
  function streamKind(url) {
    const base = (url || "").split(/[?#]/)[0].toLowerCase();
    if (base.endsWith(".m3u8")) return "hls";                 // HLS (lives, câmeras via gateway)
    if (/\.(mp4|webm|ogv|ogg|mov|m4v)$/.test(base)) return "file";
    if (/\.(mjpg|mjpeg)$/.test(base)) return "mjpeg";         // câmera MJPEG
    return null;
  }

  // Converte links de Twitch e Vimeo para o player de incorporação com autoplay.
  function serviceEmbed(src, volume) {
    let u;
    try { u = new URL(src, location.href); } catch { return null; }
    const host = u.hostname.replace(/^www\./, "");
    const seg = u.pathname.split("/").filter(Boolean);
    const muted = (volume | 0) > 0 ? "false" : "true";
    if (host === "twitch.tv") {                               // twitch.tv/<canal> ou /videos/<id>
      const parent = location.hostname || "localhost";
      if (seg[0] === "videos" && seg[1])
        return `https://player.twitch.tv/?video=${seg[1]}&parent=${parent}&autoplay=true&muted=${muted}`;
      if (seg[0])
        return `https://player.twitch.tv/?channel=${encodeURIComponent(seg[0])}&parent=${parent}&autoplay=true&muted=${muted}`;
    }
    if (host === "vimeo.com" && /^\d+$/.test(seg[0] || "")) {
      const m = (volume | 0) > 0 ? "0" : "1";
      return `https://player.vimeo.com/video/${seg[0]}?autoplay=1&muted=${m}&background=1`;
    }
    return null;
  }

  // Detecta Power BI "Publicar na web" (tem barra inferior fixa de navegação/rodapé).
  function isPowerBI(url) {
    return /powerbi\.com/i.test(url || "");
  }

  // Aceita uma URL OU um código de incorporação completo (<iframe ...>): extrai
  // o src. Se não for HTML de iframe, devolve o texto como veio (não quebra nada).
  function iframeSrc(s) {
    s = (s || "").trim();
    if (s[0] !== "<") return s;
    const m = s.match(/<iframe[^>]*\bsrc\s*=\s*["']([^"']+)["']/i);
    return m ? m[1].replace(/&amp;/g, "&") : s;
  }

  // Converte links do YouTube (assistir, youtu.be, /live, shorts, canal ao vivo,
  // playlist) para a URL de incorporação (embed) que funciona em iframe, com
  // autoplay. Retorna null se não for YouTube — assim qualquer outra URL passa
  // sem alteração (não quebra conteúdos já configurados).
  function youtubeEmbed(src, volume, loop) {
    let u;
    try { u = new URL(src, location.href); } catch { return null; }
    const host = u.hostname.replace(/^www\./, "");
    if (host !== "youtu.be" && !host.endsWith("youtube.com") && !host.endsWith("youtube-nocookie.com"))
      return null;

    let id = "";
    const params = new URLSearchParams();
    if (host === "youtu.be") {
      id = u.pathname.slice(1).split("/")[0];
    } else {
      const p = u.pathname;
      if (p === "/watch") id = u.searchParams.get("v") || "";
      else if (p.startsWith("/embed/")) id = p.slice(7).split("/")[0];
      else if (p.startsWith("/live/")) id = p.slice(6).split("/")[0];
      else if (p.startsWith("/shorts/")) id = p.slice(8).split("/")[0];
      else {
        const ch = p.match(/^\/channel\/([^/]+)\/live\/?$/);
        if (ch) { id = "live_stream"; params.set("channel", ch[1]); }
        else if (u.searchParams.get("list")) id = "videoseries";
      }
      const list = u.searchParams.get("list");
      if (list && id === "videoseries") params.set("list", list);
    }
    if (!id) return null;

    params.set("autoplay", "1");
    params.set("mute", (volume | 0) > 0 ? "0" : "1"); // autoplay com som exige volume>0 (kiosk libera)
    params.set("playsinline", "1");
    params.set("rel", "0");
    params.set("modestbranding", "1");
    if (!params.has("controls")) params.set("controls", "0");
    if (loop && id !== "live_stream" && id !== "videoseries") {
      params.set("loop", "1");
      params.set("playlist", id); // necessário p/ loop de vídeo único no YouTube
    }
    const base = host.endsWith("youtube-nocookie.com")
      ? "https://www.youtube-nocookie.com" : "https://www.youtube.com";
    return `${base}/embed/${id}?${params.toString()}`;
  }

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
      this._hls = null;
    }

    start() {
      if (!this.items.length) {
        this.el.innerHTML =
          `<div class="vw-placeholder"><b>${esc(this.c.name)}</b><span>sem conteúdo configurado</span></div>`;
        return;
      }
      this.next();
    }

    stop() { this.clearTimers(); this.killHls(); }

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
      this.killHls();
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
        this.attachStream(v, mediaUrl(item.source), (m) => this.fail(item, m));
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

      } else { // web / stream
        const raw = iframeSrc(item.source);            // aceita código <iframe ...> colado
        const kind = streamKind(raw);

        if (kind === "mjpeg") {                        // câmera MJPEG -> <img>, sem "play"
          const img = document.createElement("img");
          img.style.objectFit = fit;
          img.onload = () => { this.errStreak = 0; };
          img.onerror = () => this.fail(item, "MJPEG não carregou: " + raw);
          img.src = raw;
          this.el.appendChild(img);
          if (!single || dur > 0) this.after(dur > 0 ? dur : 60, () => this.next());

        } else if (kind === "hls" || kind === "file") { // HLS (.m3u8) / vídeo direto -> <video>
          const v = document.createElement("video");
          v.style.objectFit = fit;
          v.autoplay = true; v.playsInline = true;
          v.muted = (item.volume | 0) === 0;            // mudo = autoplay garantido
          v.volume = Math.max(0, Math.min(100, item.volume | 0)) / 100;
          v.loop = !!item.loop && single && dur === 0;
          v.onerror = () => this.fail(item, "stream não carregou: " + raw);
          v.oncanplay = () => { this.errStreak = 0; };
          v.onended = () => { if (!v.loop) this.next(); };
          this.attachStream(v, raw, (m) => this.fail(item, m));
          v.play().catch(() => {});
          this.el.appendChild(v);
          if (dur > 0) this.after(dur, () => this.next());
          else if (!single) this.after(60, () => this.next());

        } else {                                        // iframe: YouTube, Twitch, Vimeo, site, dashboard
          const f = document.createElement("iframe");
          f.setAttribute("allow", "autoplay; fullscreen; encrypted-media; picture-in-picture");
          f.setAttribute("allowfullscreen", "");
          f.onload = () => { this.errStreak = 0; };
          const yt = youtubeEmbed(raw, item.volume, item.loop);
          const svc = yt ? null : serviceEmbed(raw, item.volume);
          const url = yt || svc || raw;
          f.src = url;
          this.el.appendChild(f);
          // "Preencher/Esticar": Power BI recorta só a barra inferior (vira fullscreen
          // no container); YouTube/Twitch/Vimeo (16:9) recorta para encher.
          if (fit === "cover" || fit === "fill") {
            if (isPowerBI(url)) this.powerbiCrop(f);
            else if (yt || svc) this.coverIframe(f);
          }
          const refresh = item.refresh | 0;
          if (refresh > 0) this.every(Math.max(10, refresh), () => { f.src = url; });
          if (!single || dur > 0) this.after(dur > 0 ? dur : 60, () => this.next());
        }
      }
    }

    // Liga o <video> à fonte: usa hls.js para .m3u8 (Chromium), nativo no resto.
    attachStream(v, url, onFatal) {
      if (/\.m3u8(\?|#|$)/i.test(url) && !v.canPlayType("application/vnd.apple.mpegurl")
          && window.Hls && window.Hls.isSupported()) {
        const hls = new window.Hls({ liveDurationInfinity: true });
        hls.on(window.Hls.Events.ERROR, (e, data) => {
          if (!data || !data.fatal) return;
          if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
          else if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
          else if (onFatal) onFatal("HLS: " + (data.details || "erro fatal"));
        });
        hls.loadSource(url);
        hls.attachMedia(v);
        this._hls = hls;
      } else {
        v.src = url;
      }
    }

    killHls() {
      if (this._hls) { try { this._hls.destroy(); } catch (e) {} this._hls = null; }
    }

    coverIframe(f) {
      const fit = () => {
        const cw = this.el.clientWidth, ch = this.el.clientHeight;
        if (!cw || !ch) return;
        const ar = 16 / 9;                  // proporção do player do YouTube
        let w, h;
        if (cw / ch > ar) { w = cw; h = Math.ceil(cw / ar); }  // container largo: encosta na largura
        else { h = ch; w = Math.ceil(ch * ar); }               // container alto: encosta na altura
        f.style.position = "absolute";
        f.style.width = w + "px"; f.style.height = h + "px";
        f.style.left = Math.round((cw - w) / 2) + "px";
        f.style.top = Math.round((ch - h) / 2) + "px";
      };
      fit();
      this.after(0.2, fit);                 // reajuste após o layout assentar
    }

    // Power BI "Publicar na web": estende o iframe para baixo e recorta a barra
    // inferior (navegação/rodapé), deixando só o relatório — "fullscreen" no container.
    powerbiCrop(f) {
      const bar = 48;                        // altura aprox. da barra inferior do Power BI
      const apply = () => {
        const cw = this.el.clientWidth, ch = this.el.clientHeight;
        if (!cw || !ch) return;
        f.style.position = "absolute";
        f.style.left = "0"; f.style.top = "0";
        f.style.width = cw + "px";
        f.style.height = (ch + bar) + "px";  // a barra cai abaixo do container e é clipada
      };
      apply();
      this.after(0.2, apply);
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
