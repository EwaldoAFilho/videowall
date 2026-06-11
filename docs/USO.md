# Manual de uso — VideoWall

## 1. Conceitos

- **Layout**: a composição completa da tela (resolução de trabalho + containers).
  Vários layouts podem existir; **um** fica ativo no videowall.
- **Container**: uma área retangular independente do layout, com posição,
  tamanho, camada e aparência próprias.
- **Conteúdo**: um item da playlist de um container (site, imagem, vídeo ou
  pasta de imagens). A playlist rotaciona automaticamente.

## 2. Editor de layouts

Aba **Editor**:

| Ação | Como fazer |
|---|---|
| Criar layout | `＋ Novo` na barra superior |
| Aplicar preset | Botões `1`, `2 ▥`, `2 ▤`, `2×2`, `3×2`, `4×2` (substitui os containers) |
| Criar container | `＋ Container` |
| Mover | Arrastar o container no canvas (ou setas do teclado; `Shift` = 1px) |
| Redimensionar | Alças azuis nas bordas/cantos do container selecionado |
| Duplicar | Botão `⧉ Duplicar` no painel de propriedades |
| Excluir | Botão `🗑 Excluir` ou tecla `Delete` |
| Ocupar tela inteira | Botão `⛶ Tela cheia` (o container passa a cobrir o layout) |
| Resolução do layout | Campos “Resolução” na barra do editor |
| Encaixe na grade | Caixa “Encaixar na grade” (grade de 10px) |

As edições são **salvas automaticamente** (indicador “alterações não salvas”
aparece enquanto grava). O botão **💾 Salvar** força a gravação imediata.

> Importante: salvar **não** altera o telão. O videowall só muda quando você
> clica em **▶ Aplicar no videowall**.

### Propriedades do container

- **Nome** — exibido no título (se habilitado) e nos logs.
- **X / Y / Largura / Altura** — em pixels da resolução de trabalho do layout.
- **Camada (z)** — containers com valor maior ficam por cima (sobreposição).
- **Ajuste do conteúdo** — manter proporção, preencher (corta) ou esticar.
- **Ativo** — container inativo não aparece no player.
- **Exibir título / Borda** — moldura visual opcional com cor configurável.

## 3. Playlists de conteúdo

Com um container selecionado, use **＋ Adicionar conteúdo**:

| Tipo | Fonte | Opções específicas |
|---|---|---|
| Site/Dashboard | URL (`https://…`) ou página interna (`/static/pages/...`) | Recarregar a cada N segundos |
| Imagem | Arquivo da mídia (`Procurar…`) ou URL | — |
| Vídeo | Arquivo da mídia ou URL | Loop, volume (0 = mudo) |
| Pasta de imagens | Pasta dentro da mídia | Trocar imagem a cada N segundos |

- **Tempo de exibição**: segundos que o item fica na tela antes do próximo.
  - `0` em vídeo = reproduz até o fim e passa ao próximo;
  - `0` nos demais = conteúdo fixo (não rotaciona — útil para item único).
- **Ordem**: setas ▲▼ reordenam; ⏸/▶ ativa/desativa o item sem excluir.
- **Testar**: para URLs, valida o acesso e avisa se o site bloqueia exibição
  em iframe (`X-Frame-Options`/CSP).

### Exemplo (Container “Indicadores Operacionais”)

1. Power BI (web) — 300 s, recarregar a cada 300 s
2. Imagem institucional — 30 s
3. Vídeo institucional — 0 s (até finalizar)
4. Site interno — 120 s

## 4. Dashboards de BI

- **Power BI**: use o link de *Publicar na web* (ou embed com login feito via
  `start-player.sh --setup`).
- **Grafana**: links de *Share → Embed*; ou dashboard em modo kiosk
  (`&kiosk` na URL).
- **Looker Studio / Metabase / Fluig / Protheus web**: use a URL de
  incorporação/pública quando existir; com autenticação, faça login uma vez no
  modo `--setup`.
- Configure **Recarregar a cada N segundos** para dados sempre atualizados.

## 5. Mídia

Aba **Mídia**: envie arquivos (imagens JPG/PNG/WEBP/GIF/SVG, vídeos MP4/WebM),
crie pastas (ex.: `campanhas/junho`) e exclua itens. Clique em um arquivo para
copiar seu caminho. Pastas podem ser usadas como conteúdo “Pasta de imagens”.

## 6. Pré-visualização e publicação

- **👁 Pré-visualizar**: abre o layout em nova aba, sem afetar o telão.
- **▶ Aplicar no videowall**: torna o layout ativo; o player recarrega sozinho
  em até ~10 segundos.
- **⭐ Definir como padrão**: marca o layout principal da instalação.
- **↻ Reiniciar player**: força recarga completa da exibição (sem reboot).

## 7. Status e logs

Aba **Status**: indica player **online/offline** (heartbeat), layout no ar e a
versão da configuração, além dos logs de erro reportados pelo player
(conteúdos que falharam ao carregar etc.).

## 8. Configurações

- **Segurança**: troque a senha do painel (obrigatório após instalar).
- **Exibição**: bloqueio da interface do player (cursor oculto + cliques
  desabilitados nos conteúdos).
- **Backup**: exportar/importar a configuração completa em JSON.
- **Testar URL**: diagnóstico rápido de sites/dashboards.
