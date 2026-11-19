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
| `icon*.png`, `icon.svg`, `apple-touch-icon.png` | Ícones do app. |

## Mudar as cartas

As cartas ficam no começo do `<script>` do `index.html`, nas constantes `DECKS` (Quem Sou Eu?, Mímica e Impostor), `PROIBIDA`, `ESCALAS` (Na Medida) e `STOP_CATS`. Cada baralho tem quatro listas, uma por nível: fácil, médio, difícil e impossível.

Depois de mudar qualquer arquivo, aumente a versão em `CACHE` no `sw.js` (de `resenha-v1` para `resenha-v2`, por exemplo) para os celulares baixarem tudo de novo.

Nomes, níveis, pontos e palavras de cada pessoa ficam salvos só no aparelho dela.
