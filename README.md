# Chess Analyzer

Aplicativo de desktop para revisar suas partidas do **chess.com** na sua própria
máquina, com uma tela de análise no estilo do *Game Review*: tabuleiro, barra de
avaliação, gráfico de avaliação, classificação de cada lance e precisão dos dois
jogadores.

Tudo roda local: as partidas vêm da API pública do chess.com (sem login) e a
avaliação é feita pelo **Stockfish 18** instalado junto com o app.

## Como rodar

```bash
uv run python main.py
```

Ou dê dois cliques em `Chess-Analyzer.bat`.

O app abre numa janela própria (pywebview). Se a janela nativa não estiver
disponível, ele cai para o navegador padrão. Opções:

| Flag | Efeito |
|---|---|
| `--browser` | abre no navegador em vez da janela nativa |
| `--no-window` | só sobe o servidor (útil para depurar) |
| `--port N` | porta do servidor local (padrão 8765) |

## Como usar

1. Digite seu usuário do chess.com e escolha quantas partidas buscar.
2. Escolha a profundidade da análise (veja a tabela abaixo).
3. Clique numa partida. O Stockfish avalia lance a lance com barra de progresso.
4. Na tela de revisão: setas do teclado navegam, `F` gira o tabuleiro, e dá para
   clicar no gráfico ou na lista de lances para pular direto.

Também dá para colar um PGN avulso, sem passar pela lista do chess.com.

Cada análise fica em cache em `data/reviews/`, então reabrir a mesma partida na
mesma profundidade é instantâneo.

## Análise em lote — "achar meu erro mais comum"

O botão **Achar meu erro mais comum** na lista de partidas analisa um grupo
(5, 10, 20 ou a lista toda) e monta um resumo: qual tipo de erro você mais
comete, em que fase, em quais aberturas, e quanto cada erro custou.

O lote usa um único processo do Stockfish do começo ao fim e aproveita o cache,
então partidas já analisadas naquela profundidade entram de graça. Dá para
cancelar no meio — o resumo é montado com as partidas que já terminaram.

Cada erro na tela é clicável e abre a posição exata na tela de revisão.

### Os tipos de erro

A classificação sai de como o Stockfish pune o lance (a linha principal a partir
da posição resultante), sem nenhuma chamada extra ao engine:

| Tipo | Como é detectado |
|---|---|
| Permitiu mate forçado | depois do lance existe mate contra você |
| Deixou escapar mate forçado | você tinha mate e jogou outra coisa |
| Levou tática | a punição começa com xeque e ganha material |
| Deixou material pendurado | o adversário ganha material na sequência, sem xeque |
| Capturou ou trocou mal | seu lance foi captura e a sequência saiu no prejuízo |
| Erro posicional (abertura / meio-jogo / final) | a posição piorou sem perda de material |

O erro posicional é separado por fase de propósito: junto num balde só, ele vira
a maioria dos casos e não diz nada sobre o que estudar.

## Profundidade x tempo

Medido num Intel i5-3337U (2 núcleos, 1.8 GHz) — numa máquina mais nova é bem
mais rápido.

| Profundidade | Ritmo | Partida de 40 lances |
|---|---|---|
| 10 — rápida | ~1 lance/s | ~1min30 |
| 14 — equilibrada | ~0,7 lance/s | ~2min |
| 18 — profunda | ~0,25 lance/s | ~5min |

## Como os lances são classificados

A avaliação em centipeões vira **chance de vitória** pela curva usada no
lichess, e o rótulo sai da queda de chance de vitória causada pelo lance:

| Rótulo | Critério |
|---|---|
| Brilhante | melhor lance **e** sacrifício de material que se sustenta |
| Ótimo | melhor lance e praticamente o único que segura a posição |
| Melhor | é o lance que o Stockfish escolheria |
| Excelente | perde menos de 2% de chance de vitória |
| Bom | perde menos de 5% |
| Livro | posição conhecida de teoria de abertura |
| Impreciso | perde menos de 10% |
| Erro | perde menos de 20% |
| Chance perdida | havia mate forçado e escapou |
| Erro grave | perde 20% ou mais |

A **precisão** de cada jogador é a média (ponderada por volatilidade + harmônica)
da precisão de cada lance, o mesmo método do lichess. Ela não bate exatamente
com o número do chess.com, que usa uma fórmula própria e fechada, mas fica na
mesma faixa.

## Versão web (para publicar)

A pasta `web/` é a mesma ferramenta, só que **sem backend**: o Stockfish roda no
navegador de quem visita, via WebAssembly, e as partidas vêm direto da API
pública do chess.com. São arquivos estáticos, então dá para hospedar de graça e
sem servidor.

Isso é possível porque a API do chess.com responde
`Access-Control-Allow-Origin: *` — o navegador pode chamá-la sem proxy. E como
cada visitante analisa na própria máquina e chama a API do próprio IP, o site
aguenta qualquer número de pessoas sem custo e sem concentrar limite de taxa.

### Rodar localmente

```bash
python web/serve.py 8080
```

Precisa ser por HTTP (não abrindo o arquivo direto), porque a página usa módulos
ES e Web Workers.

### Publicar no Cloudflare Pages

1. Suba o repositório para o GitHub (a pasta `web/vendor/` **entra no commit** —
   são o engine e o chess.js).
2. Em *Workers & Pages* → *Create* → *Pages* → *Connect to Git*, escolha o repo.
3. Build command: deixe vazio. Build output directory: `web`.
4. Deploy. Sai uma URL `https://<projeto>.pages.dev`, pública e grátis.

O arquivo `web/_headers` já vai configurado e o Cloudflare Pages o aplica
sozinho. Netlify lê o mesmo arquivo. GitHub Pages também funciona, só ignora os
cabeçalhos (veja abaixo por que isso não importa muito).

### Sobre desempenho e threads

O app tenta o Stockfish multi-thread e cai sozinho no single-thread quando o
navegador não permite. Medido neste projeto, num i5-3337U com Chrome 151, em
profundidade 14:

| Build | ms por posição |
|---|---|
| 1 thread | 1336 |
| 3 threads | 1331 |

Ou seja: **em profundidade fixa o multi-thread não acelera**. O ganho do Lazy SMP
do Stockfish aparece em busca por tempo fixo, não por profundidade fixa. Os
cabeçalhos COOP/COEP e o build multi-thread continuam no projeto porque podem
render em máquinas com mais núcleos, mas se quiser simplificar dá para apagar
`stockfish-18-lite.js/.wasm` e o `_headers` sem perder velocidade perceptível.

O engine tem 7 MB e só é baixado quando a primeira análise começa — quem só
quer olhar a lista de partidas não paga esse download. Depois fica no cache do
navegador. As revisões ficam no `localStorage` de cada visitante, então nada do
que as pessoas analisam passa por você.

### Licença

O Stockfish é GPL-3.0 e o binário WebAssembly é redistribuído em `web/vendor/`.
Publicar o site com ele exige manter o código-fonte disponível — o repositório
público no GitHub já cumpre isso.

## Estrutura

```
chess-analyzer/
├── main.py              # sobe o servidor e abre a janela
├── app/
│   ├── engine.py        # descoberta e operação do Stockfish (UCI)
│   ├── chesscom.py      # API pública do chess.com + leitura de PGN
│   ├── review.py        # avaliação lance a lance, precisão e classificação
│   ├── aggregate.py     # padrões de erro no lote de partidas
│   ├── server.py        # API local + progresso por Server-Sent Events
│   ├── assets/          # livro de aberturas (EPD)
│   └── static/          # interface (HTML/CSS/JS, sem dependências externas)
├── engine/stockfish/    # binário do Stockfish 18 (só a versão local)
├── data/reviews/        # cache das análises (só a versão local)
└── web/                 # versão publicável, sem backend
    ├── index.html
    ├── app.js           # interface (módulo ES)
    ├── engine.js        # Stockfish WASM em Web Worker, com fallback de threads
    ├── chesscom.js      # API do chess.com direto do navegador
    ├── review.js        # porte de review.py
    ├── aggregate.js     # porte de aggregate.py
    ├── serve.py         # servidor local só para testar
    ├── _headers         # COOP/COEP para Cloudflare Pages / Netlify
    └── vendor/          # stockfish.wasm + chess.js
```

As duas versões calculam a mesma coisa, mas os números não batem exatamente: a
versão web usa a rede neural **Lite** do Stockfish (7 MB em vez de 108 MB), então
as avaliações variam um pouco. Nas mesmas 5 partidas, a local deu 78,5% de
precisão média e a web 80,3% — e as duas apontaram o mesmo erro mais comum.

## Base

Este app foi construído em cima de duas skills públicas de Claude Code:

- [robominds/stockfish-skill](https://github.com/robominds/stockfish-skill) —
  wrapper UCI do Stockfish, descoberta do binário e modos de análise.
- [hhkarimi/claude-chess-skills](https://github.com/hhkarimi/claude-chess-skills) —
  pipeline de busca no chess.com, cálculo de perda por lance, detecção de fase da
  partida e o livro de aberturas em EPD (derivado de
  [lichess-org/chess-openings](https://github.com/lichess-org/chess-openings), CC0).

O Stockfish é GPLv3 — o binário em `engine/` vem do
[release oficial](https://github.com/official-stockfish/Stockfish/releases)
(build `sse41-popcnt`, escolhido porque esta CPU não tem AVX2).

## Requisitos

- Python 3.10+ e [uv](https://docs.astral.sh/uv/)
- O Stockfish já vai em `engine/`. Para usar outro binário, defina
  `STOCKFISH_PATH`.
