# Resenha

Seis jogos de festa num celular só: **Quem Sou Eu?**, **Mímica**, **Palavra Proibida**, **Impostor**, **Na Medida** e **Stop**.

- Cada pessoa ou time escolhe o próprio nível: Fácil vale ×1 nos pontos, Médio ×2, Difícil ×3 e Impossível ×5.
- São cerca de 1.500 cartas no Quem Sou Eu?, e a roda pode escrever as próprias palavras, cartas, escalas e categorias.
- Tem placar, cartas +18 opcionais e funciona sem internet depois da primeira visita.

É um site estático, só com HTML, CSS e JavaScript, sem build e sem dependências.

## Publicar no Vercel

1. Em [vercel.com](https://vercel.com), clique em **Add New → Project** e importe este repositório.
2. Em **Framework Preset**, escolha **Other**. Deixe **Build Command** e **Output Directory** em branco.
3. Clique em **Deploy**. A partir daí, cada push na branch `main` publica a versão nova.

## Sala online (Quem Sou Eu? · Todos juntos)

No Quem Sou Eu?, a opção **Todos juntos** deixa cada pessoa jogar no próprio celular: uma pessoa cria a sala, os outros entram com o código de 4 letras e cada tela mostra uma carta diferente. Quem acerta primeiro ganha mais pontos: com 5 pessoas, o 1º ganha 4, o 2º ganha 3, e assim até o último, que ganha 0, tudo multiplicado pelo nível de cada um.

A sala usa a função `api/room.js` e um banco Redis gratuito da Upstash:

1. No projeto no Vercel, abra **Storage → Create Database → Upstash for Redis** e escolha o plano Free.
2. Conecte o banco ao projeto, com o prefixo padrão. O Vercel cria as variáveis `KV_REST_API_URL` e `KV_REST_API_TOKEN`.
3. Faça um novo deploy para a função enxergar as variáveis.

As salas somem sozinhas depois de 6 horas sem uso.

## Instalar como app no celular

- **Android (Chrome):** abra o site, toque no menu ⋮ e em **Instalar app** (ou **Adicionar à tela inicial**).
- **iPhone (Safari):** abra o site, toque em **Compartilhar** e em **Adicionar à Tela de Início**.

## Arquivos

| Arquivo | Para que serve |
| --- | --- |
| `index.html` | O app inteiro: jogos, cartas, placar e visual. |
| `manifest.webmanifest` | Nome, cores e ícones do app instalado. |
| `sw.js` | Guarda o app no celular para funcionar sem internet. |
| `vercel.json` | Faz o celular sempre buscar a versão mais nova do `sw.js`. |
| `api/room.js` | Guarda as salas do modo Todos juntos no Redis. |
| `icon*.png`, `icon.svg`, `apple-touch-icon.png` | Ícones do app. |

## Mudar as cartas

As cartas ficam no começo do `<script>` do `index.html`, nas constantes `DECKS` (Quem Sou Eu?, Mímica e Impostor), `PROIBIDA`, `ESCALAS` (Na Medida) e `STOP_CATS`. Cada baralho tem quatro listas, uma por nível: fácil, médio, difícil e impossível.

Depois de mudar qualquer arquivo, aumente a versão em `CACHE` no `sw.js` (de `resenha-v1` para `resenha-v2`, por exemplo) para os celulares baixarem tudo de novo.

Nomes, níveis, pontos e palavras de cada pessoa ficam salvos só no aparelho dela.
