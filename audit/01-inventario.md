# 01 — Inventário (estado real do código)

Branch: `audit/auditoria-financeira` (base: `main` @ `4074a19`). Ambiente: banco MongoDB **em memória** (replica set) + seed fictício. Nenhum dado real foi acessado.

## Stack e comandos
| Item | Valor |
|---|---|
| Monorepo | npm workspaces: `apps/api`, `apps/web`, `packages/contracts`, `e2e` |
| Backend | Node 24, Fastify, MongoDB (driver oficial, transações), Zod |
| Frontend | Vue 3 + Vite + Pinia + Tailwind |
| Contrato compartilhado | `packages/contracts` (schemas Zod, enums, utilitários de data/dinheiro). **API e web consomem o `dist`**: é preciso `npm run build -w @yudirect/contracts` após mudar o contrato |
| Testes | Vitest (contracts, api, web) + Playwright (`e2e/`, usa o Chrome instalado) |
| Qualidade | `npm run lint`, `npm run typecheck`, `npm run build` |

## Números levantados
| Métrica | Valor | Como foi contado |
|---|---|---|
| Módulos de API | 12 | pastas em `apps/api/src/modules` |
| Endpoints HTTP | 120 | rotas `app.get/post/patch/put/delete` (+ `/health`, `/ready`) |
| Coleções MongoDB | 34 | `database/mongo.ts` |
| Índices | 78 (31 únicos) | `database/indexes.ts` |
| Rotas do front | 40 | `apps/web/src/router/index.ts` |
| Componentes Vue | 70 | `apps/web/src/**/*.vue` |
| Arquivos TS da API (sem testes) | 55 | contagem de arquivos |
| Módulos de permissão | 8 | dashboard, vehicles, drivers, rentals, inspections, maintenance, finance, notifications (ações: read/create/update/delete/pay/export) |

## Matriz Módulo × Funcionalidade × Estado

Legenda: **V** implementado e validado · **F** implementado com falha comprovada (ver `04`) · **P** parcial · **N** não implementado · **NV** não verificável/não auditado.

| Módulo | Funcionalidade | Implementação | Integrações | Testes existentes | Estado | Riscos |
|---|---|---|---|---|---|---|
| Auth | Login, sessão por cookie, logout, troca de senha, convites | `modules/auth` | — | flows T01/T19, E2E acesso | V | `SESSION_SECRET` padrão aceito em produção (R-01) |
| Organização | Colaboradores, convites, permissões por módulo/ação | `modules/organization` | assinatura (provedor sem credencial no demo) | flows T02/T03, permissions.test (web) | V (permissões) / NV (cobrança real) | — |
| Veículos | CRUD, fotos, importação XLSX/CSV, arquivar | `modules/vehicles` | consulta de multas (fontes externas) | flows T05, E2E | V (CRUD) / NV (multas reais) | arquivar tirava o custo do relatório por veículo (B-08, corrigido) |
| Motoristas | CRUD, documentos, consentimento WhatsApp | `modules/drivers` | CEP | flows T06 | V | LGPD não auditada (R-08) |
| Locações | Criar, editar, encerrar, excluir, conta a receber por contrato | `modules/rentals` | — | flows T07 + `payment-schedule` | **F** | encerrar não ajusta a cobrança (B-03, aberto) |
| Cronograma semanal | `GET /rentals/:id/payment-schedule` | `services/finance.ts` | — | payment-schedule (17) + E2E | V | cálculo derivado da conta única (A-FIN-02) |
| Contas a receber | Listar, filtrar, baixar (parcial/total), estornar | `modules/finance/accounts.ts` | — | payment-settlement, audit, E2E | V após correções | UI de estorno inexistente (B-04) |
| Contas a pagar | CRUD, categorias, recorrência, **parcelamento**, baixa, estorno | `modules/finance/accounts.ts` | — | flows T12/T14, payable-installments, audit | V após correções | veículo opcional (PEND-01); sem "responsável" (PEND-04) |
| Contas bancárias / extrato | CRUD, lançamento manual, extrato, CSV | `modules/finance/bank.ts` | — | flows T12, E2E, AUD-14c | V | lançamento manual com data futura não é barrado |
| Dashboard (painel) | Cards, evolução, top lucrativos/mais caros | `modules/reports`, `services/analytics.ts` | — | reference-figures, AUD-06/14b | V após correções | fórmulas só "realizado" (ver `03`) |
| Dashboard financeiro / DRE / por veículo / por cliente | Indicadores, PDF | `modules/reports` | — | reference-figures, E2E | V após correções | sem indicador "previsto" nem "lançado" |
| Manutenção | OS, peças, garantia, conclusão com lançamento, PDF | `modules/maintenance` | — | flows T08/T09 | V | despesa entra pela conclusão (`completedAt`) |
| Vistorias | Slots de foto, link público, revisão, agenda por regra | `modules/inspections`, `services/inspection-schedule.ts` | — | flows T10/T11, inspection-schedule | V | não é escopo financeiro |
| WhatsApp (Whaply) | Coleta de vistoria, mensagens, custos | `modules/whatsapp`, `integrations/whaply` | Whaply (simulado nos testes) | whatsapp-integration, E2E | V no simulado / **NV** com provedor real | `e2e-whaply-cross` pulado (exige Whaply real) |
| Notificações | CNH, manutenção, locações; modelos e disparo | `modules/notifications` | provedor de mensagens | flows | V | — |
| Jobs | recorrência, status vencidos, vistorias, contas de locação sem término | `jobs/scheduler.ts` | — | AUD-13 (idempotência) | V | execução depende de `JOBS_ENABLED` |
| Segurança transversal | CSRF por Origin, rate limit, helmet, isolamento por organização | `app.ts`, `plugins` | — | AUD-10, AUD-15 | V (isolamento/permissões) | segredos/produção (R-01) |
| Operação | Build, deploy (Heroku), backup, logs/monitoramento | `Procfile`/scripts | — | — | **NV** | backup/restauração e pipeline não auditados |

## Observações
- Não foi tratada como defeito a ausência de módulos fora do escopo (ex.: faturamento por provedor real, multas por integração real).
- A documentação OpenAPI (`docs/openapi.json`) **não** lista os endpoints novos (cronograma, estorno, filtros) e o gerador (`npm run openapi`) falha neste ambiente por incompatibilidade de versão do `esbuild` (host 0.23.1 × binário 0.24.2). Registrado como R-07.
