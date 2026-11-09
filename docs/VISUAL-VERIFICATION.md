# Verificação visual e numérica

Este documento registra **o que foi medido**, com que método, e quais
divergências permanecem. Nenhuma afirmação de "pixel-perfect" é feita.

---

## 1. PDF de manutenções — comparação com o golden master

O arquivo `manutencoes-ebr7g53-2026-11-08.pdf` é tratado como **golden master**.
A verificação extrai cada fragmento de texto do PDF de referência e do PDF
gerado (decodificando os `ToUnicode` CMaps das fontes embutidas) e compara
conteúdo e posição.

```bash
npm run report:verify -w @yudirect/api -- ../../../manutencoes-ebr7g53-2026-11-08.pdf
```

### Resultado medido

| Métrica | Valor |
|---|---|
| Páginas | golden 2 · gerado **2** |
| Fragmentos de texto | golden 271 · gerado **271** |
| Fragmentos encontrados no gerado | **271 / 271 (100,0%)** |
| Δx (horizontal) | média **1,31 pt** · máximo 20,62 pt |
| Δy (vertical) | média **1,95 pt** · máximo 14,38 pt |

Para referência de escala: 1 pt = 1/72". A média de desvio é inferior a
0,5 mm.

### O que foi calibrado a partir do golden master

- Página A4 retrato, margens `36 / 90 / 36 / 40`.
- Fontes **Roboto Regular e Medium** — confirmadas pelos descritores embutidos
  (`BZZZZZ+Roboto-Medium`, `CZZZZZ+Roboto-Regular`).
- Larguras de coluna de cada tabela, medidas nos retângulos de fundo do PDF
  original (`apps/api/src/pdf/printer.ts` → `COLUMNS`).
- Paddings horizontais (8 pt nas tabelas com divisória, 10,2 pt nas tabelas de
  rótulo/valor) e verticais (5,4 / 6,2 / 5,7 pt).
- Cabeçalho (logo 96×64 pt à esquerda, organização e subtítulo à direita) e
  rodapé (`Documento para apresentação ao cliente.` + `n / total`).

### Divergências conhecidas

1. **Δx máximo de 20,6 pt** em cabeçalhos alinhados à direita das tabelas
   `Por tipo` / `Por situação` (ex.: a palavra `Quantidade`). A largura exata
   dessas colunas não é recuperável dos retângulos do PDF porque elas não têm
   preenchimento de fundo; o valor adotado é uma estimativa.
2. **Δy máximo de 14,4 pt** na primeira linha da tabela continuada no topo da
   página 2. O pdfmake reinicia a tabela com espaçamento próprio após a quebra
   de página.
3. Cores de preenchimento e espessura de filetes **não são verificáveis por
   extração de texto**; foram amostradas dos operadores de cor do PDF
   (`#E2E8F0` para filetes, `#F8FAFC` para zebra, `#0B1F3A` para títulos).

---

## 2. Números das telas — reproduzidos por cálculo

Os valores abaixo **não estão embutidos em nenhuma resposta**: são agregados a
partir dos registros persistidos pelo seed. Verificados em
`apps/api/src/__tests__/reference-figures.test.ts` (16 testes).

| Figura da referência | Página | Valor | Conferido |
|---|---:|---|---|
| Total de Veículos / Motoristas Ativos / Contratos Ativos | 14 | 7 / 6 / 6 | ✅ |
| Receita Mensal | 14 | R$ 5.603,00 | ✅ |
| Evolução da receita Jun→Nov | 14–15 | 0 · 0 · 8.637 · 12.800 · 15.703 · 5.603 | ✅ |
| Faturamento × Despesas × Lucro × Margem | 80 | 5.603,00 · 1.894,45 · 3.708,55 · 66,2% | ✅ |
| Comparativo de outubro | 80 | 15.703,00 · 9.538,98 · 6.164,02 · 39,3% | ✅ |
| Despesas por categoria | 81 | Financiamento 1.720,45 · Seguro 174,00 | ✅ |
| Extrato de novembro | 85 | 7.802,58 + 5.603,00 − 1.894,45 = 11.511,13 | ✅ |
| Saldo corrido da 1ª linha | 86 | R$ 8.452,58 | ✅ |
| Valor Pendente Total a receber | 91 | R$ 33.540,00 em 6 contas | ✅ |
| Receita por veículo (novembro) | 06 | EBR7G53 1.460 · RVA9F74 1.300 · GCQ0E23 1.000 · RNA8D85 800 · RVS9B58 650 · SEB9B67 393 · FQT3I57 0 | ✅ |
| Despesa por veículo (novembro) | 06 | RVS9B58 1.720,45 · RVA9F74 174,00 | ✅ |
| DRE de novembro | 09–10 | Receita líquida 5.603,00 · Lucro bruto 3.708,55 · Resultado 3.708,55 | ✅ |
| Manutenções EBR7G53 | 45 | 2 OS · 831,20 · média 415,60 · mão de obra 250,00 · peças 581,20 | ✅ |
| Cards de manutenção por veículo | 44 | EBR7G53 2/831,20 · RNA8D85 1/516,90 · RVS9B58 4/1.891,16 · SEB9B67 6/5.595,71 | ✅ |
| Assinatura | 18 | Essencial · 6 a 10 veículos · trimestral · 151,91/mês · 455,73 no ciclo | ✅ |

**Única divergência deliberada:** o saldo inicial da conta bancária
(`R$ 3.938,56` em 03/09/2026, enquanto a pág. 84 mostra `0`). Sem ele o extrato
de novembro não abriria em `R$ 7.802,58`. Ver `ASSUMPTIONS.md` → A-SEED-01.

---

## 3. Capturas da aplicação

```bash
# com a API e o Vite rodando
node e2e/capture-screens.mjs --out .cache/screens-light --theme light
node e2e/capture-screens.mjs --out .cache/screens-dark  --theme dark
```

- Viewport **1917 × 950**, `deviceScaleFactor: 1`, locale `pt-BR`, timezone
  `America/Sao_Paulo`.
- O ponteiro é movido para `(0, 0)` antes de cada captura: sem isso a linha
  sob o cursor ficava em `:hover` e aparecia como se a tabela tivesse faixas
  zebradas.
- A barra do navegador **não** faz parte da aplicação e não é reproduzida.
- 24 rotas + o estado de sidebar expandida são capturados em cada tema.

### Como comparar lado a lado

As páginas da referência são extraídas do PDF com o utilitário incluído:

```bash
node e2e/extract-reference-pages.mjs "../Captura de tela 2026-11-08 164843.pdf" .cache/reference
```

Cada página vira `page001.png` … `page093.png` (1917 × 963, RGB), na resolução
original — são as *screenshots embutidas*, copiadas sem rasterizar e sem perda.

---

## 4. Calibração métrica das telas

As referências **não** foram capturadas na escala 1:1 da aplicação: a imagem
tem 1917 px de largura, mas todo o conteúdo aparece ~1,2× maior do que em um
viewport de 1917 px CSS. Isso corresponde a um navegador de ~1598 px CSS com
zoom de 120%. Para medir, as capturas de conferência usam
`viewport 1598 × 762` com `deviceScaleFactor 1.2`, produzindo 1918 px — a mesma
escala efetiva da referência. A moldura do navegador ocupa os primeiros 48 px.

A medição é feita por análise de pixels, não a olho:

```bash
# transições de cor numa coluna (bordas de cartão, inputs, linhas de tabela)
node e2e/measure-screens.mjs rows .cache/reference/page001.png --x 1700 --chrome 48 --scale 1.2

# intervalos horizontais ocupados por texto (revela o alinhamento das colunas)
node e2e/measure-screens.mjs cols .cache/reference/page001.png --y0 583 --y1 592

# faixas verticais com texto (linhas de um bloco)
node e2e/measure-screens.mjs bands .cache/reference/page001.png --y0 164 --y1 315 --chrome 48 --scale 1.2
```

### O que a medição corrigiu

Seis divergências estruturais foram encontradas e corrigidas a partir das
medidas (págs. 001, 008, 034, 062, 066 e 091):

| Achado | Antes | Depois |
|---|---|---|
| Altura da faixa de título | 139 px CSS (`py-6`) | **125 px** (`py-[17px]`) — igual às 5 páginas medidas |
| Divisória sob a faixa | `border-b` + `mt-6` | **removida** — a referência vai direto da faixa ao cartão, com 24 px de intervalo |
| Filtros e tabela | dois cartões separados | **um único cartão** — em x = 137 px não há borda de cartão entre os seletores e o cabeçalho da tabela |
| Tabela | *full-bleed* até a borda do cartão | **dentro do respiro**: as divisórias começam em x ≈ 160 px e terminam em ≈ 1849 px, contra um cartão de 131–1878 px |
| Altura do cabeçalho da tabela | 51 px (`py-3.5`) | **43 px** (`py-2.5`) — borda inferior em 472,5 px CSS |
| Escala do eixo Y do gráfico de receita | 7 marcas (passo R$ 3k), escolhidas pelo ECharts | **5 marcas** (R$ 0 / 4k / 8k / 12k / 16k) — topo calculado em 4 intervalos "redondos" |

### Resultado medido (pág. 001 — Contas a Pagar)

Posição horizontal do início de cada coluna, em px de imagem:

| Coluna | Referência | Gerado | Δ |
|---|---:|---:|---:|
| Descrição | 183 | 188 | +5 |
| Categoria | 827 | 828 | +1 |
| Valor | 1025 | 1025 | **0** |
| Vencimento | 1199 | 1198 | −1 |
| Fornecedor | 1370 | 1369 | −1 |
| Status | 1631 | 1627 | −4 |
| Ações | 1767 | 1763 | −4 |

Posição vertical, em px CSS:

| Marco | Referência | Gerado | Δ |
|---|---:|---:|---:|
| Altura da barra superior | 70,8 | 72,0 | +1,2 |
| Topo da faixa de título | 96,7 | 96,0 | −0,7 |
| Base da faixa de título | 221,7 | 221,0 | −0,7 |
| Topo do cartão | 248,3 | 245,0 | −3,3 |
| Base do cabeçalho da tabela | 472,5 | 471,5 | −1,0 |
| Base da 1ª linha | 548,3 | 548,5 | +0,2 |
| Base da 2ª linha | 624,2 | 626,0 | +1,8 |
| Altura da linha | 75,8 | 77,0 | +1,2 |

Também foi medido que **todas as colunas da referência são alinhadas à
esquerda**, inclusive as monetárias e a de ações (confirmado nas págs. 001,
008 e 091) — o alinhamento à direita que havia nas colunas de valor foi
removido. No PDF de manutenções, ao contrário, `KM` e `Total` *são* alinhados
à direita; são artefatos diferentes.

### Formatação corrigida por medição de cor

| Item | Referência | Correção |
|---|---|---|
| Variação nos cards do painel | texto cinza `#6B7280`, sem ícone, inteiro (`+0%`, `-64%`) | removidos ícone e cor; `formatSignedPercent(valor, 0)` |
| Variação nos cards do financeiro | pílula colorida com uma casa (`−64,3%`, `+26,9 pp`) | mantida |
| Legenda da rosca de despesas | compacta (`R$ 1,7k`, `R$ 174`) | passou a usar `compactBRL` |
| Variação nula | `+0%` | `formatSignedPercent` passou a prefixar `+` também em zero |

### Divergências visuais remanescentes

| Item | Situação |
|---|---|
| Fotos de veículos e de vistorias | Não incorporadas (imagens de terceiros com placas legíveis). A interface mostra placeholder. Ver A-SEED-03. |
| Família tipográfica | Inter no lugar da fonte original, não recuperável de um raster. Ver A-UI-06. |
| Largura das colunas | Medida e fixada em Contas a Pagar (pág. 001). Nas demais tabelas a largura continua automática, por não haver medida de referência para todas. |
| Aba `Vistorias` em Notificações | Acréscimo — a referência mostra 4 abas. Ver A-UI-08. |
| Nomes, CPF, telefones | Fictícios por exigência de LGPD. Ver A-SEED-02. |

---

## 5. Suíte de testes

```
packages/contracts   17 testes   regras de dinheiro, CPF/CNPJ/placa, períodos, permissões
apps/api             66 testes   fluxos funcionais + figuras da referência + PDF
apps/web             34 testes   máscara monetária, cliente HTTP, permissões, status/cards
                    ───────────
                    117 testes
```

Execução: `npm test` na raiz. Os testes de API sobem um MongoDB em memória com
replica set (transações reais) e exercitam a API por injeção HTTP — sem mocks
de banco. Os testes de web montam os componentes de verdade com
`@vue/test-utils` sobre jsdom.

Além deles, `npm run test:e2e` roda **18 testes** de Playwright
(`e2e/yudirect.spec.ts`) contra a aplicação real: a API sobe com `dev:demo`
(banco em memória já populado) e o front em `vite preview` sobre o build de
produção. Cobre bloqueio de rota protegida, login com credencial errada sem
vazar se o e-mail existe, indicadores do painel, fechamento de
receita − despesa = lucro, hierarquia da DRE, download dos dois PDFs e da
planilha modelo, busca de veículos, ausência do veículo arquivado na consulta,
histórico de manutenções, extrato bancário, contas a receber e os avisos
honestos de integração não configurada.

A autenticação acontece **uma única vez**, no projeto `setup`
(`e2e/auth.setup.ts`), que grava o cookie em `.cache/e2e-auth.json`. Isso não
é uma conveniência: com login por teste a suíte esbarrava no rate limit de
`POST /auth/login` (10 tentativas por minuto) — comportamento desejado da API,
que seria errado afrouxar só para o teste passar. Os três casos do bloco
`acesso` declaram `storageState` vazio para rodar anônimos.
