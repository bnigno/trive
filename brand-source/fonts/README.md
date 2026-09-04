# Fontes do comprovante (assets de runtime)

O comprovante de pagamento (`src/receipts/render.tsx`) é desenhado pelo Satori
do `next/og`, que só aceita fontes estáticas (ttf/otf/woff) e ignora o eixo
`wght` das variáveis. As fontes do site (next/font) não servem, então:

- `Jost-Regular.ttf` (400) e `Jost-Medium.ttf` (500): estáticas do upstream
  [indestructible-type/Jost](https://github.com/indestructible-type/Jost)
  (`fonts/ttf/Jost-400-Book.ttf` e `Jost-500-Medium.ttf`).
- `CormorantGaramond-SemiBold.ttf` (600) e `CormorantGaramond-Italic.ttf`
  (400 itálico): estáticas do upstream
  [CatharsisFonts/Cormorant](https://github.com/CatharsisFonts/Cormorant)
  (`fonts/ttf/`).
- Licença SIL OFL 1.1 (`OFL-Jost.txt`, `OFL-Cormorant.txt`).

`subset/` guarda os mesmos arquivos reduzidos ao latim (U+0020–017F,
travessões, aspas, bullet, reticências, ·, →, − U+2212), gerados com
`pyftsubset <fonte> --unicodes=... --layout-features='kern,liga,calt' --no-hinting`
(fonttools). São eles que `scripts/generate-receipt-assets.mjs` embute em
base64 em `src/receipts/assets.generated.ts` — nada é lido do disco em
produção.
