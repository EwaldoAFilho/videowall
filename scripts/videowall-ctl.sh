#!/usr/bin/env bash
# Utilitário de operação do VideoWall.
# Uso: videowall-ctl.sh {start|stop|restart|status|restart-player|logs|backup|restore <arquivo>}
set -u
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${VIDEOWALL_DATA:-$APP_DIR/data}"
BACKUP_DIR="$DATA_DIR/backups"

case "${1:-}" in
  start)   sudo systemctl start videowall-server ;;
  stop)    sudo systemctl stop videowall-server ;;
  restart) sudo systemctl restart videowall-server ;;
  status)
    systemctl status videowall-server --no-pager || true
    systemctl --user status videowall-player --no-pager 2>/dev/null || true
    ;;
  restart-player)
    systemctl --user restart videowall-player 2>/dev/null \
      || echo "Serviço de usuário não ativo; o player também pode ser recarregado pelo painel (Reiniciar player)."
    ;;
  logs)
    echo "--- servidor (journal) ---"
    sudo journalctl -u videowall-server -n 50 --no-pager || true
    echo "--- servidor (arquivo) ---"
    tail -n 30 "$DATA_DIR/logs/server.log" 2>/dev/null || true
    ;;
  backup)
    mkdir -p "$BACKUP_DIR"
    F="$BACKUP_DIR/videowall-backup-$(date +%Y%m%d-%H%M%S).tar.gz"
    tar -czf "$F" -C "$DATA_DIR" videowall.db media 2>/dev/null
    echo "Backup criado: $F"
    ;;
  restore)
    [ -f "${2:-}" ] || { echo "Uso: $0 restore <arquivo.tar.gz>"; exit 1; }
    sudo systemctl stop videowall-server 2>/dev/null || true
    tar -xzf "$2" -C "$DATA_DIR"
    sudo systemctl start videowall-server 2>/dev/null || true
    echo "Backup restaurado de: $2"
    ;;
  *)
    echo "Uso: $0 {start|stop|restart|status|restart-player|logs|backup|restore <arquivo>}"
    exit 1
    ;;
esac
