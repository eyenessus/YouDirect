# YuDirect

Plataforma SaaS de gestão de frotas e locadoras, reconstruída a partir de um
conjunto de referências visuais (93 capturas de tela) e de um PDF de relatório
usado como *golden master*.

O sistema é **funcional de ponta a ponta**: veículos, motoristas, locações,
manutenções, vistorias, financeiro (contas a pagar/receber, extrato bancário,
DRE), notificações, colaboradores com permissões e assinatura. Nenhuma tela
exibe número decorativo — todos os indicadores são calculados a partir dos
dados persistidos.

---

## Índice

- [Stack](#stack)
- [Começando](#começando)
  - [Opção A — demonstração em um comando](#opção-a--demonstração-em-um-comando)
  - [Opção B — Docker (MongoDB + MinIO)](#opção-b--docker-mongodb--minio)
  - [Opção C — MongoDB em memória](#opção-c--mongodb-em-memória)
- [Acesso](#acesso)
- [Estrutura do repositório](#estrutura-do-repositório)
- [Scripts](#scripts)
- [Testes e verificação](#testes-e-verificação)
- [Configuração](#configuração)
- [Integrações externas](#integrações-externas)
- [Decisões de arquitetura](#decisões-de-arquitetura)
- [Segurança e LGPD](#segurança-e-lgpd)
- [Documentação complementar](#documentação-complementar)
- [Limitações conhecidas](#limitações-conhecidas)

---

## Stack

| Camada | Tecnologia |
|---|---|
| Front-end | Vue 3 + TypeScript, Vite, Tailwind CSS, Pinia, Vue Router, ECharts |
| API | Node.js 20 + Fastify 5, TypeScript, Zod |
| Banco | MongoDB 7 (replica set — transações multi-documento) |
| Arquivos | Disco local ou bucket S3/MinIO, servidos por URL assinada |
| PDF | pdfmake (Roboto embutido, igual ao golden master) |
| Testes | Vitest (unidade + integração), Playwright (E2E) |

Tipos, schemas de validação, formatadores e regras de domínio ficam em um
pacote compartilhado (`packages/contracts`) usado pela API **e** pelo front —
há uma única fonte de verdade para validação de placa, CPF, cálculo de totais
de OS, rótulos de status e formatação monetária.

---

## Começando

Pré-requisitos: **Node.js ≥ 20.11** e npm 10. Docker é opcional.

```bash
npm install
```

### Opção A — demonstração em um comando

Sobe a API com um MongoDB **em memória** (replica set) já populado e o
front-end em modo desenvolvimento. Não exige Docker nem banco instalado; os
dados são descartados ao encerrar o processo.

```bash
npm run dev:demo
```

- Front-end: <http://localhost:5173>
- API: <http://localhost:3333/api/v1>
- Health check: <http://localhost:3333/health>

> Na primeira execução o `mongodb-memory-server` baixa o binário do MongoDB
> (~100 MB) para `.cache/mongodb-binaries`.

### Opção B — Docker (MongoDB + MinIO)

Para um ambiente persistente, próximo de produção:

```bash
cp .env.example .env
docker compose -f infra/docker-compose.yml up -d
npm run seed            # popula a organização de demonstração
npm run dev             # API + front-end
```

O compose sobe MongoDB 7 em replica set de um nó (`rs0`, já inicializado) e
MinIO com o bucket `yudirect` criado. Para usar o MinIO, ajuste no `.env`:

```env
STORAGE_DRIVER=s3
S3_BUCKET=yudirect
S3_ENDPOINT=http://localhost:9000
S3_ACCESS_KEY_ID=yudirect
S3_SECRET_ACCESS_KEY=yudirect123
S3_REGION=us-east-1
```

### Opção C — MongoDB em memória

Deixando `MONGODB_URI` vazio no `.env`, `npm run dev` sobe o MongoDB em
memória automaticamente. Útil para desenvolvimento sem Docker — mas o `seed`
precisa de um banco persistente, então use a Opção A para ver dados.

---

## Acesso

O seed cria a organização de demonstração **FF Veículos** com um usuário
proprietário:

| Campo | Valor |
|---|---|
| E-mail | `erik@ffveiculos.example.com` |
| Senha | `YuDirect@2026` |

Ambos são configuráveis por `SEED_OWNER_EMAIL` / `SEED_OWNER_PASSWORD`.

**Os dados pessoais do seed são fictícios.** Nomes, CPF, RG, telefones e
e-mails das capturas de referência **não** foram reutilizados. Os dados de
frota e os valores financeiros, sim — para que os relatórios reproduzam os
números verificáveis das referências (ver
[`docs/VISUAL-VERIFICATION.md`](docs/VISUAL-VERIFICATION.md)).

---

## Estrutura do repositório

```
yudirect/
├─ packages/contracts/        # tipos, Zod schemas, regras e formatadores (API + web)
├─ apps/api/
│  └─ src/
│     ├─ app.ts               # montagem do Fastify (CORS, helmet, rate limit, CSRF)
│     ├─ server.ts            # bootstrap + graceful shutdown
│     ├─ config/env.ts        # schema de ambiente e status real das integrações
│     ├─ database/            # conexão, índices, tipos dos documentos, seed
│     ├─ modules/             # rotas por domínio (vehicles, rentals, finance, …)
│     ├─ services/            # razão bancário, finanças, notificações, analytics
│     ├─ pdf/                 # relatório de manutenções (golden master) e DRE
│     ├─ integrations/        # adapters de WhatsApp, e-mail, CEP, multas, cobrança
│     ├─ jobs/                # rotinas periódicas idempotentes
│     └─ __tests__/           # testes de integração sobre a API real
├─ apps/web/
│  └─ src/
│     ├─ components/          # UI (ui/, layout/, charts/)
│     ├─ features/            # uma pasta por área da navegação
│     ├─ lib/api.ts           # cliente HTTP tipado
│     ├─ stores/              # Pinia (auth, notifications, ui)
│     └─ styles/tokens.css    # tokens de cor/tipografia (tema claro e escuro)
├─ e2e/                       # Playwright + script de captura de telas
├─ infra/                     # docker-compose (MongoDB replica set + MinIO)
└─ docs/                      # ASSUMPTIONS, TRACEABILITY, VISUAL-VERIFICATION, openapi.json
```

---

## Scripts

| Comando | O que faz |
|---|---|
| `npm run dev` | API + front-end em modo desenvolvimento |
| `npm run dev:demo` | Igual, com MongoDB em memória já populado |
| `npm run seed` | Popula a organização de demonstração (exige `MONGODB_URI`) |
| `npm run build` | Build dos três workspaces |
| `npm run typecheck` | `tsc` / `vue-tsc` em contracts, API e web |
| `npm run lint` | ESLint em `.ts` e `.vue` |
| `npm test` | Testes de unidade e integração (contracts + API + web) |
| `npm run test:e2e` | Playwright contra a aplicação real |
| `npm run openapi` | Regera `docs/openapi.json` |
| `npm run report:verify -w @yudirect/api` | Compara o PDF gerado com o golden master |

---

## Testes e verificação

```bash
npm test          # 17 contracts + 66 API + 34 web = 117 testes
npm run test:e2e  # 18 fluxos de ponta a ponta no navegador
```

Os testes da API sobem a aplicação **completa** (Fastify + MongoDB em memória
com replica set + armazenamento temporário) e exercitam as rotas de verdade —
sem mocks de banco. Dois arquivos cobrem áreas diferentes:

- `flows.test.ts` — fluxos funcionais: isolamento entre organizações,
  permissões, unicidade de placa/CPF, importação de planilha, soma de OS,
  idempotência de pagamentos, estorno em vez de exclusão, URLs assinadas de
  arquivo, vistoria por token de uso único, troca de senha.
- `reference-figures.test.ts` — cada número verificável das capturas é
  **recalculado** a partir do seed: receita de R$ 5.603,00, despesas de
  R$ 1.894,45, lucro de R$ 3.708,55, extrato fechando
  7.802,58 + 5.603,00 − 1.894,45 = 11.511,13, pendente de R$ 33.540,00,
  manutenções do EBR7G53 somando R$ 831,20, DRE e assinatura.

### Comparação com o golden master do PDF

```bash
npm run report:verify -w @yudirect/api -- ../../../manutencoes-ebr7g53-2026-11-08.pdf
```

O script extrai cada fragmento de texto posicionado dos dois PDFs
(decodificando os CMaps `ToUnicode` das fontes embutidas) e compara conteúdo e
coordenadas. Resultado medido: **271/271 fragmentos (100%)**, Δx médio
**1,31 pt**, Δy médio **1,95 pt**, mesmo número de páginas. Não se afirma
"pixel-perfect" — os desvios residuais estão listados em
[`docs/VISUAL-VERIFICATION.md`](docs/VISUAL-VERIFICATION.md).

### Conferência visual das telas

As 93 páginas de referência são extraídas do PDF como PNGs na resolução
original e comparadas com capturas da aplicação real:

```bash
npm run dev:demo                                  # em outro terminal
node e2e/extract-reference-pages.mjs "../Captura de tela 2026-11-08 164843.pdf" .cache/reference
node e2e/capture-screens.mjs --out .cache/screens-light --theme light
node e2e/capture-screens.mjs --out .cache/screens-dark  --theme dark
```

A comparação **não** é feita a olho: `e2e/measure-screens.mjs` analisa os
pixels e reporta bordas de cartão, alturas de linha e os intervalos
horizontais ocupados por texto em cada coluna.

```bash
node e2e/measure-screens.mjs rows .cache/reference/page001.png --x 1700 --chrome 48 --scale 1.2
node e2e/measure-screens.mjs cols .cache/reference/page001.png --y0 583 --y1 592
```

Essa medição mostrou que as referências foram capturadas a ~1,2× (navegador de
~1598 px CSS com zoom de 120%) e revelou cinco divergências estruturais, todas
corrigidas: altura da faixa de título, divisória sob o título, filtros e tabela
em cartões separados, tabela *full-bleed* e altura do cabeçalho da tabela.
Depois do ajuste, as colunas de Contas a Pagar caem a **0–5 px** das posições
da referência e os marcos verticais a **0,2–3,3 px**. Os números medidos estão
em [`docs/VISUAL-VERIFICATION.md`](docs/VISUAL-VERIFICATION.md) §4.

---

## Configuração

Todas as variáveis estão documentadas em [`.env.example`](.env.example) e
validadas por Zod na inicialização — a API **não sobe** com configuração
inválida, em vez de falhar em tempo de execução.

Pontos que merecem atenção em produção:

| Variável | Observação |
|---|---|
| `MONGODB_URI` | Obrigatória; deve apontar para um **replica set** (transações) |
| `SESSION_SECRET` | Mínimo 16 caracteres; troque o valor padrão |
| `COOKIE_SECURE` | `true` atrás de HTTPS |
| `CORS_ORIGINS` | Lista explícita de origens; também alimenta a checagem de CSRF |
| `STORAGE_DRIVER` | `mongo` (padrão): arquivos em Base64 na coleção `fileBlobs` (até ~10 MB cada); `local` grava em disco; `s3` exige bucket e credenciais |

---

## Integrações externas

WhatsApp, e-mail, consulta de CEP, consulta de multas e cobrança da assinatura
são integrações reais via adapter. **Sem credenciais configuradas, nada é
simulado**: a API responde com indisponibilidade explícita e a interface diz o
que está faltando, oferecendo a alternativa manual quando existe (por exemplo,
link `wa.me` por destinatário no disparo de mensagens).

| Integração | Sem credenciais |
|---|---|
| WhatsApp | Disparo não é marcado como enviado; oferece link manual por motorista |
| E-mail | Convite não é enviado; o link de aceite é devolvido para entrega manual |
| CEP | Campo de endereço permanece manual |
| Multas | Nenhum dado de DETRAN é exibido ou inventado |
| Cobrança | Nenhum link de pagamento ou 2ª via é exposto |

`GET /api/v1/integrations/status` devolve o estado real de cada uma.

---

## Decisões de arquitetura

**Multi-tenancy.** Toda coleção de domínio carrega `organizationId`, e todo
índice começa por ele. Nenhuma consulta de domínio é feita sem o filtro de
organização, que vem da sessão — nunca do corpo da requisição.

**Dinheiro em centavos.** Valores monetários são inteiros em centavos em todo o
caminho: banco, API, cliente HTTP e campo de formulário. A máscara `R$` é
apresentação; nunca há ponto flutuante em cálculo financeiro.

**Datas de negócio como `YYYY-MM-DD`.** Vencimentos, competências e datas de
execução são strings de data pura — comparáveis, indexáveis e imunes a
deslocamento de fuso. Timestamps de auditoria continuam `Date`.

**Razão bancário com estorno.** Cada fato financeiro gera exatamente um
lançamento, protegido por `dedupeKey`. Excluir uma conta já paga ou cancelar
uma OS **não apaga o extrato**: cria o movimento espelho de estorno. O saldo é
sempre `saldo inicial + entradas − saídas` a partir da data do saldo inicial.

**Idempotência.** Pagamentos aceitam `Idempotency-Key`; sem o header, a chave é
derivada de (conta, valor, data, origem). Geradores de notificação e
recorrências usam chaves de deduplicação, de modo que os jobs podem rodar
quantas vezes for preciso sem duplicar alerta ou lançamento.

**Concorrência otimista.** Veículos, motoristas, locações, OS e contas têm
`version`; uma edição concorrente devolve `409` com mensagem orientada ao
usuário em vez de sobrescrever silenciosamente.

**Status derivados.** `PAID` / `OVERDUE` / `PARTIAL` são calculados de
`gross`, `paid` e `dueDate` contra a data efetiva do sistema, e gravados na
mesma transação do pagamento — a tela nunca mostra um status que o cálculo
contradiz.

**Transações.** Fluxos financeiros usam transações multi-documento. Sem replica
set o servidor registra um aviso e segue com as escritas idempotentes, em vez
de quebrar.

---

## Segurança e LGPD

- Sessão opaca em cookie `HttpOnly` + `SameSite=Lax`, com TTL e revogação;
  trocar a senha revoga as outras sessões.
- Senhas com hash memory-hard (scrypt, parâmetros versionados no hash, pronto
  para migrar para Argon2id sem invalidar o que já existe).
- Permissões por módulo **e** ação, checadas no servidor em cada rota; a
  interface apenas esconde o que o backend também recusaria.
- CPF e RG cifrados em repouso (AES-256-GCM) com hash determinístico separado
  apenas para checagem de duplicidade.
- Arquivos nunca ficam em URL pública adivinhável: o acesso é por URL assinada
  (HMAC) de curta duração, emitida após checar sessão, organização e permissão.
  Upload valida *magic number*, não o `Content-Type` do navegador.
- Logs com redação de cookies, cabeçalhos de autorização, senhas e PII.
- Trilha de auditoria para ações críticas, com PII redigida antes de persistir.
- Rate limiting global e mais restrito em login, convites e disparos.
- Proteção CSRF por validação de `Origin` nos métodos de escrita.

---

## Documentação complementar

| Documento | Conteúdo |
|---|---|
| [`docs/ASSUMPTIONS.md`](docs/ASSUMPTIONS.md) | Tudo que **não** está provado pelas referências, classificado em observado / inferido / recomendação de engenharia / pendente de validação |
| [`docs/TRACEABILITY.md`](docs/TRACEABILITY.md) | Matriz das 93 capturas + 2 páginas de PDF → rota, componente, endpoint e teste |
| [`docs/VISUAL-VERIFICATION.md`](docs/VISUAL-VERIFICATION.md) | O que foi medido, com que método, e as divergências que permanecem |
| [`docs/openapi.json`](docs/openapi.json) | Contrato da API (OpenAPI 3.1); também em `GET /api/v1/openapi.json` |

---

## Limitações conhecidas

1. **Telas sem referência.** Login, aceite de convite e o formulário público de
   vistoria não aparecem em nenhuma captura. Foram construídos com os mesmos
   tokens visuais, mas não têm equivalente para comparação (`A-UI-01`,
   `A-UI-02`).
2. **Fotos dos veículos.** As referências são capturas rasterizadas e as fotos
   mostram placas legíveis de terceiros, por isso não foram incorporadas. O
   seed usa placeholder neutro.
3. **Gatilho das contas a receber.** A referência mostra uma linha por contrato
   com total e pendente, não uma linha por parcela. Modelamos um recebível por
   contrato; o gatilho exato do produto original não é observável (`A-FIN-02`).
4. **Classificação da DRE.** Todas as categorias de despesa entram em "Custos
   da frota", como nas capturas. As demais linhas existem e ficam em zero até
   que a classificação por categoria seja definida pelo negócio.
5. **Saldo de abertura do seed.** Para o extrato de novembro começar exatamente
   em R$ 7.802,58, a conta de demonstração tem saldo inicial em 03/09/2026
   (`A-SEED-01`). É o único campo do seed ajustado para fechar a referência.
6. **Provisão de IRPJ/CSLL.** Fica em zero: é apuração contábil, não derivável
   dos dados operacionais. A nota de rodapé do relatório diz isso.
