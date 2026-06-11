#!/usr/bin/env bash
# Inicia o player do VideoWall em modo kiosk (Chromium/Chrome).
#
# Uso:
#   start-player.sh            -> kiosk em tela cheia (padrão)
#   start-player.sh --span     -> janela cobrindo TODOS os monitores (X11)
#   start-player.sh --setup    -> janela normal, para fazer login em dashboards
#                                 (Power BI, Grafana etc.); o login fica salvo no
#                                 perfil do player e vale para o modo kiosk.
set -u

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ -f "$APP_DIR/config/player.env" ] && . "$APP_DIR/config/player.env"

URL="${VIDEOWALL_URL:-http://127.0.0.1:8777/player}"
PROFILE="${VIDEOWALL_PROFILE:-$HOME/.config/videowall-player}"

# Trava: impede duas instâncias do player ao mesmo tempo (causa janelas em loop).
# O lock fica preso enquanto o navegador estiver aberto (fd herdado pelo exec).
LOCK="${XDG_RUNTIME_DIR:-/tmp}/videowall-player.lock"
exec 9>"$LOCK"
if ! flock -n 9; then
  echo "O player já está em execução. Para reiniciar: systemctl --user restart videowall-player" >&2
  exit 0
fi
MODE="kiosk"
case "${1:-}" in
  --span)  MODE="span"  ;;
  --setup) MODE="setup" ;;
esac
[ -n "${VIDEOWALL_PLAYER_MODE:-}" ] && [ $# -eq 0 ] && MODE="$VIDEOWALL_PLAYER_MODE"

# Detecta o navegador disponível
BROWSER=""
for b in chromium-browser chromium google-chrome google-chrome-stable; do
  command -v "$b" >/dev/null 2>&1 && { BROWSER="$b"; break; }
done
if [ -z "$BROWSER" ]; then
  echo "ERRO: instale o Chromium ou Google Chrome (sudo apt install chromium-browser)" >&2
  exit 1
fi

# Aguarda o servidor do VideoWall responder (até 60s)
for _ in $(seq 1 60); do
  if command -v curl >/dev/null 2>&1; then
    curl -fs -o /dev/null "$URL" && break
  else
    python3 -c "import urllib.request;urllib.request.urlopen('$URL',timeout=2)" 2>/dev/null && break
  fi
  sleep 1
done

FLAGS=(
  --user-data-dir="$PROFILE"
  --no-first-run
  --noerrdialogs
  --disable-session-crashed-bubble
  --disable-infobars
  --disable-translate
  --disable-features=TranslateUI
  --autoplay-policy=no-user-gesture-required
  --check-for-update-interval=31536000
  --overscroll-history-navigation=0
)

case "$MODE" in
  setup)
    echo "Modo configuração: faça login nos dashboards e feche a janela ao terminar."
    exec "$BROWSER" "${FLAGS[@]}" --new-window "$URL"
    ;;
  span)
    # Cobre todos os monitores (bounding box via xrandr) — requer sessão X11
    SIZE=$(xrandr 2>/dev/null | awk '/ connected/{
      match($0,/[0-9]+x[0-9]+\+[0-9]+\+[0-9]+/);
      if (RSTART) { split(substr($0,RSTART,RLENGTH),g,/[x+]/);
        r=g[3]+g[1]; b=g[4]+g[2]; if(r>W)W=r; if(b>H)H=b; } }
      END{ printf "%d,%d", W, H }')
    W="${VIDEOWALL_WINDOW_W:-${SIZE%,*}}"
    H="${VIDEOWALL_WINDOW_H:-${SIZE#*,}}"
    [ -z "$W" ] || [ "$W" = "0" ] && { W=1920; H=1080; }
    exec "$BROWSER" "${FLAGS[@]}" --app="$URL" \
      --window-position=0,0 --window-size="$W,$H"
    ;;
  *)
    exec "$BROWSER" "${FLAGS[@]}" --kiosk --app="$URL" \
      ${VIDEOWALL_WINDOW_POS:+--window-position="$VIDEOWALL_WINDOW_POS"}
    ;;
esac
