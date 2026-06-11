#!/usr/bin/env bash
# Instalador do VideoWall para Ubuntu.
# Execute como o usuário que vai operar o videowall (NÃO como root):
#   bash install.sh                -> instalação completa (máquina do telão)
#   bash install.sh --sem-player   -> só servidor/painel (máquina de administração)
set -e

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
USER_NAME="$(whoami)"
INSTALL_PLAYER=1
for arg in "$@"; do
  case "$arg" in
    --sem-player|--no-player) INSTALL_PLAYER=0 ;;
  esac
done

if [ "$USER_NAME" = "root" ]; then
  echo "Execute como usuário normal (o script pede sudo quando precisa)."; exit 1
fi

echo "==> VideoWall — instalação em $APP_DIR (usuário: $USER_NAME)"

# 1) Dependências ------------------------------------------------------------
command -v python3 >/dev/null || { echo "ERRO: python3 não encontrado (sudo apt install python3)"; exit 1; }
echo "  • python3: $(python3 --version)"

BROWSER=""
for b in chromium-browser chromium google-chrome google-chrome-stable; do
  command -v "$b" >/dev/null 2>&1 && { BROWSER="$b"; break; }
done
if [ -z "$BROWSER" ]; then
  echo "  • navegador: NÃO encontrado — instalando chromium..."
  sudo apt-get update -qq && sudo apt-get install -y chromium-browser \
    || sudo snap install chromium \
    || { echo "Instale manualmente o Chromium ou Google Chrome e rode de novo."; exit 1; }
else
  echo "  • navegador: $BROWSER"
fi

# 2) Diretórios e configuração ----------------------------------------------
mkdir -p "$APP_DIR/data/media" "$APP_DIR/data/logs" "$APP_DIR/data/backups"
[ -f "$APP_DIR/config/videowall.env" ] || cp "$APP_DIR/config/videowall.env.example" "$APP_DIR/config/videowall.env"
[ -f "$APP_DIR/config/player.env" ]    || cp "$APP_DIR/config/player.env.example"    "$APP_DIR/config/player.env"
chmod +x "$APP_DIR/scripts/"*.sh "$APP_DIR/install.sh" 2>/dev/null || true

# 3) Inicializa o banco (cria layout de exemplo e usuário admin) -------------
python3 - <<PY
import sys; sys.path.insert(0, "$APP_DIR")
from app import db
db.init_db()
print("  • banco de dados inicializado")
PY

# 4) Serviço do servidor (systemd, nível sistema) -----------------------------
echo "==> Instalando serviço videowall-server (systemd)"
sed -e "s|__INSTALL_DIR__|$APP_DIR|g" -e "s|__USER__|$USER_NAME|g" \
  "$APP_DIR/deploy/videowall-server.service" | sudo tee /etc/systemd/system/videowall-server.service >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable --now videowall-server

# 5) Player no login gráfico --------------------------------------------------
# IMPORTANTE: registra UMA única forma de inicialização (systemd de usuário,
# com fallback para autostart). Registrar as duas faz o player abrir em loop.
rm -f "$HOME/.config/autostart/videowall-player.desktop"
systemctl --user disable --now videowall-player 2>/dev/null || true
rm -f "$HOME/.config/systemd/user/videowall-player.service"
systemctl --user daemon-reload 2>/dev/null || true

if [ "$INSTALL_PLAYER" = "1" ]; then
  echo "==> Instalando inicialização automática do player"
  if systemctl --user show-environment >/dev/null 2>&1; then
    mkdir -p "$HOME/.config/systemd/user"
    sed "s|__INSTALL_DIR__|$APP_DIR|g" "$APP_DIR/deploy/videowall-player.service" \
      > "$HOME/.config/systemd/user/videowall-player.service"
    systemctl --user daemon-reload
    systemctl --user enable videowall-player
    echo "  • via serviço systemd de usuário (videowall-player)"
  else
    mkdir -p "$HOME/.config/autostart"
    sed "s|__INSTALL_DIR__|$APP_DIR|g" "$APP_DIR/deploy/videowall-player.desktop" \
      > "$HOME/.config/autostart/videowall-player.desktop"
    echo "  • via autostart do desktop (~/.config/autostart)"
  fi
else
  echo "==> Player NÃO instalado nesta máquina (--sem-player): use o painel via navegador"
fi

# 6) Resumo -------------------------------------------------------------------
PORT=$(grep -E '^VIDEOWALL_PORT=' "$APP_DIR/config/videowall.env" | cut -d= -f2)
PORT=${PORT:-8777}
echo
echo "============================================================"
echo " VideoWall instalado com sucesso!"
echo
echo "  Painel administrativo:  http://127.0.0.1:$PORT/admin"
echo "  Usuário/senha inicial:  admin / admin   (ALTERE em Configurações)"
if [ "$INSTALL_PLAYER" = "1" ]; then
  echo "  Player (kiosk):         $APP_DIR/scripts/start-player.sh"
  echo
  echo "  O player abre sozinho no próximo login gráfico."
  echo "  Para o videowall ligar sozinho após reboot, ative o login"
  echo "  automático do usuário '$USER_NAME' em:"
  echo "  Configurações do Ubuntu → Usuários → Login automático"
else
  echo "  Player:                 não instalado nesta máquina (--sem-player)"
fi
echo
echo "  Comandos úteis:  scripts/videowall-ctl.sh {start|stop|restart|status|logs|backup}"
echo "============================================================"
