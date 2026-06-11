# VideoWall — Gestão de Videowall Corporativo para Ubuntu

Plataforma para configurar, controlar e exibir um videowall de forma dinâmica:
a tela é dividida em **containers independentes**, e cada container recebe uma
**playlist de conteúdos** (sites, dashboards de BI, vídeos, imagens, pastas de
imagens) com rotação e atualização automáticas.

- **Zero dependências**: backend 100% em Python (biblioteca padrão) + SQLite.
  Só precisa de `python3` (já incluso no Ubuntu) e Chromium/Chrome.
- **Painel administrativo web local** com editor visual (arrastar/redimensionar).
- **Player em modo kiosk** com recuperação automática de falhas.
- **systemd** para iniciar tudo junto com o sistema.

---

## 1. Instalação no Ubuntu

```bash
# copie a pasta do projeto para o local definitivo, ex.:
sudo mkdir -p /opt/videowall && sudo chown $USER /opt/videowall
cp -r ./* /opt/videowall/ && cd /opt/videowall

bash install.sh
```

> **Máquina só de administração** (você acessa o painel pela rede e o player
> roda em outra máquina): instale com `bash install.sh --sem-player` para não
> registrar a abertura automática do player no login.

O instalador:
1. verifica `python3` e instala o Chromium se necessário;
2. cria `data/` (banco, mídia, logs, backups) e os arquivos de configuração;
3. inicializa o banco com **layout de exemplo 2×2** e usuário `admin/admin`;
4. instala e ativa o serviço `videowall-server` (systemd);
5. configura o player para abrir automaticamente no login gráfico.

> **Inicialização automática completa após reboot:** ative o *login automático*
> do usuário em **Configurações do Ubuntu → Usuários → Login automático**.
> O servidor sobe com o boot; o player abre com a sessão gráfica.

### Acesso

| O quê | Onde |
|---|---|
| Painel administrativo | `http://127.0.0.1:8777/admin` |
| Login inicial | `admin` / `admin` — **altere em Configurações** |
| Player (tela de exibição) | `http://127.0.0.1:8777/player` |

---

## 2. Iniciar, parar e reiniciar

```bash
scripts/videowall-ctl.sh start            # inicia o servidor
scripts/videowall-ctl.sh stop             # para o servidor
scripts/videowall-ctl.sh restart          # reinicia o servidor
scripts/videowall-ctl.sh status           # status servidor + player
scripts/videowall-ctl.sh restart-player   # reinicia o processo do player
scripts/videowall-ctl.sh logs             # últimos logs
scripts/videowall-ctl.sh backup           # backup (banco + mídia) em data/backups/
scripts/videowall-ctl.sh restore ARQ.tar.gz
```

Também é possível usar `systemctl` direto: `sudo systemctl restart videowall-server`
e `systemctl --user restart videowall-player`.

O botão **“Reiniciar player”** do painel recarrega a exibição **sem reiniciar o
computador** e sem mexer em serviço algum.

---

## 3. Player em tela cheia / kiosk

```bash
scripts/start-player.sh           # kiosk: tela cheia em um monitor (padrão)
scripts/start-player.sh --span    # janela cobrindo TODOS os monitores (X11)
scripts/start-player.sh --setup   # janela normal p/ fazer login em dashboards
```

- **Múltiplos monitores**: use `--span` (ou `VIDEOWALL_PLAYER_MODE=span` em
  `config/player.env`). O tamanho é detectado via `xrandr`; em Wayland prefira
  o modo kiosk por monitor ou force `VIDEOWALL_WINDOW_W/H`.
- **Escolher o monitor do kiosk**: `VIDEOWALL_WINDOW_POS=1920,0` (posição X,Y
  do monitor desejado).
- **Dashboards com autenticação** (Power BI, Grafana, Metabase, Fluig, Protheus):
  rode `--setup`, faça login normalmente e feche. As credenciais ficam salvas no
  perfil dedicado do player (`~/.config/videowall-player`) e valem para o kiosk.
- **Bloqueio da interface**: em *Configurações → Exibição* do painel, o bloqueio
  oculta o cursor e impede cliques nos conteúdos (evita alterações acidentais).

---

## 4. Uso básico

1. Acesse o painel e faça login.
2. **Crie um layout** (ou use um preset: 1, 2 lado a lado, 2 empilhadas, 2×2, 3×2, 4×2).
3. **Monte os containers** arrastando e redimensionando no editor
   (setas do teclado movem, `Shift` move 1px, `Delete` exclui).
4. Selecione um container e configure nome, posição, tamanho, camada,
   ajuste do conteúdo (manter proporção / preencher / esticar), borda e título.
5. Na **playlist** do container, adicione conteúdos:
   - **Site/Dashboard**: URL externa ou página interna, com recarregamento periódico;
   - **Imagem**: JPG, PNG, WEBP, GIF, SVG (upload na aba Mídia);
   - **Vídeo**: MP4/WebM local, com loop e volume por container;
   - **Pasta de imagens**: rotaciona todas as imagens da pasta no intervalo definido.
   Cada item tem tempo de exibição próprio (0 = vídeo até o fim / conteúdo fixo).
6. **Pré-visualize** (abre o player em nova aba sem afetar o videowall).
7. **Aplicar no videowall** — o player recarrega sozinho em segundos.
8. Marque o layout principal como **padrão** (⭐).

Documentação detalhada: [docs/USO.md](docs/USO.md).

---

## 5. Estrutura do projeto

```
videowall/
├── run.py                     # ponto de entrada (python3 run.py)
├── install.sh                 # instalador para Ubuntu
├── app/                       # backend (Python stdlib)
│   ├── server.py              # servidor HTTP, rotas estáticas, Range p/ vídeo
│   ├── api.py                 # API REST (layouts, containers, conteúdos, mídia…)
│   ├── auth.py                # PBKDF2 + sessões
│   ├── db.py                  # SQLite: schema, migrações, seed de exemplo
│   └── config.py              # caminhos e variáveis de ambiente
├── static/
│   ├── admin/                 # painel administrativo (HTML/CSS/JS puro)
│   ├── player/                # player (motor de playlists e watchdog)
│   └── pages/                 # páginas internas (relógio, boas-vindas, demo BI)
├── scripts/
│   ├── start-player.sh        # kiosk / span / setup
│   └── videowall-ctl.sh       # operação: start/stop/logs/backup/restore
├── deploy/                    # unidades systemd + autostart
├── config/                    # videowall.env / player.env
├── data/                      # criado em runtime: videowall.db, media/, logs/, backups/
└── docs/USO.md                # manual de uso
```

## 6. Modelo de dados (SQLite)

```
layouts     1 ── n  containers     1 ── n  contents (playlist)
settings (chave/valor: layout ativo, versão do player, senha, bloqueio de UI)
sessions / player_log
```

- `layouts`: nome, resolução de trabalho (largura×altura), cor de fundo, padrão.
- `containers`: nome, x, y, largura, altura, camada (z), ativo, título, borda,
  cor de fundo, modo de ajuste do conteúdo.
- `contents`: tipo (`web`, `image`, `video`, `image_folder`), URL/caminho, nome
  amigável, tempo de exibição, ordem, ativo, loop, recarregamento, volume,
  intervalo de troca de imagens.

As coordenadas usam a resolução de trabalho do layout; o player escala
automaticamente para a resolução real da tela.

## 7. Fluxo de funcionamento

```
Painel (/admin) ──REST──> Servidor Python ──SQLite──> data/videowall.db
                                   ▲
Player kiosk (/player) ──poll 9s───┘  (heartbeat + versão da configuração)
```

“Aplicar no videowall” grava o layout ativo e **incrementa a versão da
configuração**; o player detecta a mudança no próximo poll e recarrega. Falhas
de conteúdo são registradas, o item é pulado e re-tentado no ciclo seguinte; se
o servidor cair, o player exibe aviso e se recupera sozinho.

## 8. Segurança

- Painel protegido por **login/senha** (hash PBKDF2-SHA256, 240k iterações).
- Servidor escuta **apenas em 127.0.0.1 por padrão** (`config/videowall.env`).
  Para acesso remoto, mude `VIDEOWALL_BIND` conscientemente (firewall/VPN) e
  use uma senha forte.
- Sessões HttpOnly/SameSite; uploads restritos a extensões de mídia;
  proteção contra path traversal em mídia e estáticos.

## 9. Backup e restauração

- **Configuração** (layouts/containers/playlists): exporte/importe em JSON pelo
  painel (*Configurações → Backup*).
- **Completo** (banco + arquivos de mídia): `scripts/videowall-ctl.sh backup`.

## 10. Solução de problemas

| Sintoma | Verificação |
|---|---|
| Painel não abre | `scripts/videowall-ctl.sh status` e `logs` |
| Player abrindo janelas em loop | Há duas inicializações registradas. Rode `systemctl --user disable --now videowall-player` e `rm -f ~/.config/autostart/videowall-player.desktop`, depois reinstale com `bash install.sh` (versões atuais registram apenas uma) |
| Player abriu numa máquina que é só de administração | `systemctl --user disable --now videowall-player && rm -f ~/.config/autostart/videowall-player.desktop` (ou reinstale com `--sem-player`) |
| Player em branco | O servidor está de pé? O player se recupera sozinho em ~10s |
| Site não aparece no container | Teste a URL no painel — sites com `X-Frame-Options`/CSP bloqueiam iframe; use o link *embed* do serviço (Power BI “Publicar na web”, Grafana share, etc.) |
| Vídeo sem som | Ajuste o volume do item (>0); o kiosk já libera autoplay com áudio |
| Dashboard pede login | `scripts/start-player.sh --setup`, faça o login e feche |
| Mudanças não aparecem | Clique em **Aplicar no videowall** (edições não são enviadas automaticamente ao telão) |

## 11. Requisitos

- Ubuntu 20.04+ (desktop) — X11 recomendado para modo *span* multi-monitor
- Python 3.8+ (já incluso no Ubuntu)
- Chromium ou Google Chrome
- Sem dependências pip

## 12. Evolução prevista

A arquitetura (API REST + versão de configuração + player desacoplado) já
comporta: agendamento de layouts por horário, múltiplos players sincronizados,
controle remoto via API, perfis de usuário, captura de screenshot e
monitoramento por container.
