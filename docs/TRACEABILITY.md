# Matriz de rastreabilidade — 93 capturas + 2 páginas de PDF

Cada página da referência está mapeada para **rota / componente**, **endpoint**
e **cenário de teste**. Páginas repetidas são marcadas como *estado* da mesma
rota (scroll, modal, menu, tema), conforme o item §0.3 do prompt master: 93
capturas documentam cerca de duas dezenas de rotas.

Legenda dos testes:
`api/flows` = `apps/api/src/__tests__/flows.test.ts` ·
`api/ref` = `apps/api/src/__tests__/reference-figures.test.ts` ·
`contracts` = `packages/contracts/src/__tests__/domain.test.ts` ·
`e2e` = `e2e/yudirect.spec.ts` · `pdf` = `npm run report:verify -w @yudirect/api`

| Pág. | Estado observado | Rota / componente | Endpoint | Teste |
|---:|---|---|---|---|
| 01 | Contas a Pagar — lista, filtros, badge `Paga` | `/dashboard/finance/accounts-payable` · `PayablesPage.vue` | `GET /payables` | api/flows T12, e2e |
| 02 | Menu `⋮` com `Excluir` em vermelho | *estado* de 01 · `ActionMenu.vue` | `DELETE /payables/:id` | api/flows T12 |
| 03 | Nova Conta a Pagar — topo do formulário | `/dashboard/finance/accounts-payable/new` · `PayableFormPage.vue` | `POST /payables` | api/flows T12 |
| 04 | Continuação: URL do documento, recorrência, já paga | *estado* (scroll) de 03 | `POST /payables` | api/flows T12 |
| 05 | Relatório por veículo — KPIs e gráfico vazio | `/dashboard/finance/reports/by-vehicle` · `VehicleReportPage.vue` | `GET /reports/by-vehicle` | api/ref |
| 06 | Tabela `Lucro por veículo` com barras de margem | *estado* (scroll) de 05 | idem | api/ref |
| 07 | Dropdown de veículos + gráfico anual preenchido | *estado* de 05 | idem | api/ref |
| 08 | Relatório por Cliente | `/dashboard/finance/reports/by-client` · `ClientReportPage.vue` | `GET /reports/by-client` | api/ref |
| 09 | DRE Mensal — seletores e 3 cards | `/dashboard/finance/reports/dre` · `DrePage.vue` | `GET /reports/dre` | api/ref |
| 10 | DRE — deduções, IRPJ/CSLL, nota de rodapé | *estado* (scroll) de 09 | idem + `GET /reports/dre.pdf` | api/ref |
| 11 | Colaboradores — banner de cota, abas, vazio | `/dashboard/employees` · `EmployeesPage.vue` | `GET /employees` | api/flows T18 |
| 12 | Modal `Adicionar colaborador` + matriz de permissões | *modal* de 11 | `POST /invitations` | api/flows T18 |
| 13 | Aba `Convites` vazia | *estado* de 11 | `GET /employees` | api/flows T18 |
| 14 | Dashboard claro — 4 KPIs + curva verde | `/dashboard` · `DashboardPage.vue` | `GET /dashboard/summary` | api/ref, e2e |
| 15 | Dashboard — tooltip e dois rankings | *estado* (scroll/hover) de 14 | idem | api/ref |
| 16 | Meu Perfil — dados, notificações, segurança | `/dashboard/profile` · `ProfilePage.vue` | `GET /profile` | api/flows T19 |
| 17 | Perfil — campos de senha e botão | *estado* (scroll) de 16 | `POST /auth/password/change` | api/flows T19 |
| 18 | Assinatura — status e extrato do período | `/dashboard/subscription` · `SubscriptionPage.vue` | `GET /subscription` | api/ref |
| 19 | Histórico de Cobranças — atrasada/paga | *estado* (scroll) de 18 | `GET /subscription/invoices/:id/link` | api/ref |
| 20 | Dashboard **escuro** — topo | *tema* de 14 · `useThemeStore` | idem | e2e (captura dark) |
| 21 | Dashboard escuro — tooltip e rankings | *tema/scroll* de 15 | idem | e2e |
| 22 | Popover do avatar | `ProfileMenu.vue` | `POST /auth/logout` | api/flows T01 |
| 23 | Popover do sino | `NotificationPopover.vue` | `GET /notifications` | api/ref |
| 24 | Notificações (escuro) — abas e filtros | `/dashboard/notifications` · `NotificationsPage.vue` | `GET /notifications`, `POST /notifications/mark-all-read` | api/ref |
| 25 | Popover com item em hover | *estado* de 23 | idem | — |
| 26 | Notificações — outro estado de rolagem | *estado* de 24 | idem | — |
| 27 | Detalhe do Motorista — pessoais e contato | `/dashboard/drivers/:id` · `DriverDetailPage.vue` | `GET /drivers/:id` | api/flows T06 |
| 28 | Detalhe — endereço, CNH, documentos | *estado* (scroll) de 27 | idem | api/flows T06 |
| 29 | Detalhe — informações do sistema | *estado* (scroll) de 27 | idem | api/flows T06 |
| 30 | Editar Motorista — dois painéis | `/dashboard/drivers/:id/edit` · `DriverFormPage.vue` | `PATCH /drivers/:id` | api/flows T06 |
| 31 | Editar — uploads e `Salvar Alterações` | *estado* (scroll) de 30 | `POST /files` | api/flows T06 |
| 32 | Disparo de Mensagens — template, editor, prévia | `/dashboard/dispatch` · `DispatchPage.vue` | `GET /message-templates` | api/flows T17 |
| 33 | Disparo — destinatários e `Enviar para 6` | *estado* (scroll) de 32 | `POST /message-dispatches` | api/flows T17 |
| 34 | Consulta de Veículos — sidebar expandida | `/dashboard/vehicles` · `VehicleListPage.vue` | `GET /vehicles` | api/flows T04, e2e |
| 35 | Mesma lista com sidebar colapsada | *estado* de 34 · `useSidebarStore` | idem | e2e |
| 36 | Menu de ações do veículo (4 itens) | *menu* de 34 | `GET /vehicles/:id/traffic-fines` | api/flows T04 |
| 37 | Detalhe VW GOL MPI · EBR7G53 | `/dashboard/vehicles/:id` · `VehicleDetailPage.vue` | `GET /vehicles/:id` | api/flows T04 |
| 38 | Editar Veículo — básicas + dados | `/dashboard/vehicles/:id/edit` · `VehicleFormPage.vue` | `PATCH /vehicles/:id` | api/flows T04 |
| 39 | Editar — dropzone, foto, financeiras | *estado* (scroll) de 38 | `POST /files` | api/flows T04 |
| 40 | Detalhe de outro veículo (FIAT MOBI LIKE) | *estado* de 37 (template reutilizado) | idem | api/flows T04 |
| 41 | Novo Veículo — formulário vazio | `/dashboard/vehicles/new` | `POST /vehicles` | api/flows T04 |
| 42 | Novo Veículo — rodapé e `Cadastrar Veículo` | *estado* (scroll) de 41 | idem | api/flows T04 |
| 43 | Importar Veículos — dropzone e modelo | `/dashboard/vehicles/import` · `VehicleImportPage.vue` | `POST /vehicles/import/preview`, `/commit` | api/flows T05 |
| 44 | Manutenções — grade de cards | `/dashboard/maintenance` · `MaintenanceVehiclesPage.vue` | `GET /maintenance/vehicles` | api/ref |
| 45 | Histórico por veículo — 3 KPIs e tabela | `/dashboard/maintenance/:vehicleId` | `GET /vehicles/:id/maintenance` | api/ref |
| 46 | Menu da OS (`Ver detalhes`, `Excluir`) | *menu* de 45 | `DELETE /maintenance/:id` | api/flows T08 |
| 47 | Popover de anexos da OS | *estado* de 45 | `GET /files/:id/content` | api/flows T08 |
| 48 | Nova Manutenção — etapa 1 | `/dashboard/maintenance/:vehicleId/new` · `MaintenanceWizardPage.vue` | `POST /vehicles/:id/maintenance` | api/flows T08 |
| 49 | Etapa 1 — nota fiscal, observações, `Próximo` | *estado* (scroll) de 48 | idem | api/flows T08 |
| 50 | Select `Tipo de Manutenção` aberto | *estado* de 48 | — | contracts |
| 51 | Etapa 2 — peças/itens | *etapa* de 48 | idem | api/flows T08 |
| 52 | Etapa 2 — totais, pagamento, conta bancária | *estado* (scroll) de 51 | idem | api/flows T08 |
| 53 | Etapa 2 — segunda captura (totais/banco) | *estado* de 51 | idem | api/flows T08 |
| 54 | Etapa 3 — garantia vazia, `Registrar Manutenção` | *etapa* de 48 | idem | api/flows T08 |
| 55 | Vistorias — cards por veículo | `/dashboard/inspections` · `InspectionVehiclesPage.vue` | `GET /inspections/vehicles` | api/flows T10 |
| 56 | Histórico de vistorias — filtros e acordeões | `/dashboard/inspections/:vehicleId` | `GET /vehicles/:id/inspections` | api/flows T10 |
| 57 | Acordeão expandido — KM e aviso | *estado* de 56 | idem | api/flows T10 |
| 58 | Galeria de 5 fotos | *estado* de 56 | `GET /files/:id/content` | api/flows T11 |
| 59 | Modal `Solicitar Vistoria` | *modal* · `RequestInspectionModal.vue` | `POST /vehicles/:id/inspections/request` | api/flows T10 |
| 60 | Configuração de fotos — slots e limite | `/dashboard/inspections/settings` | `GET/PUT /inspection/photo-slots` | api/flows T11 |
| 61 | Configuração — `Painel / KM` e adicionar | *estado* (scroll) de 60 | `POST /inspection/photo-slots` | api/flows T11 |
| 62 | Consulta de Motoristas | `/dashboard/drivers` · `DriverListPage.vue` | `GET /drivers` | api/flows T06 |
| 63 | Menu do motorista (`Editar`/`Excluir`) | *menu* de 62 | `DELETE /drivers/:id` | api/flows T06 |
| 64 | Novo Motorista — identidade, CNH, endereço | `/dashboard/drivers/new` | `POST /drivers` | api/flows T06 |
| 65 | Novo Motorista — uploads e `Cadastrar` | *estado* (scroll) de 64 | `POST /files` | api/flows T06 |
| 66 | Consulta de Locações | `/dashboard/rentals` · `RentalListPage.vue` | `GET /rentals` | api/flows T07 |
| 67 | Menu da locação | *menu* de 66 | `DELETE /rentals/:id` | api/flows T07 |
| 68 | Editar Locação — veículo/motorista travados | `/dashboard/rentals/:id/edit` · `RentalFormPage.vue` | `PATCH /rentals/:id` | api/flows T07 |
| 69 | Editar — regras de vistoria e financeiras | *estado* (scroll) de 68 | idem | api/flows T07 |
| 70 | Editar — switches, KM, contrato | *estado* (scroll) de 68 | idem | api/flows T07 |
| 71 | Editar — rodapé e `Atualizar Locação` | *estado* (scroll) de 68 | idem | api/flows T07 |
| 72 | Nova Locação — `+ Novo Veículo` / `+ Novo Cliente` | `/dashboard/rentals/new` | `POST /rentals` | api/flows T07 |
| 73 | Nova Locação — periodicidade e financeiras | *estado* (scroll) de 72 | idem | api/flows T07 |
| 74 | Nova Locação — caução, KM, contrato | *estado* (scroll) de 72 | idem | api/flows T07 |
| 75 | Nova Locação — rodapé e `Cadastrar Locação` | *estado* (scroll) de 72 | idem | api/flows T07 |
| 76 | Novo Veículo (repetição para calibração) | *estado* de 41 | — | e2e |
| 77 | Novo Veículo — parte inferior (repetição) | *estado* de 42 | — | e2e |
| 78 | Novo Motorista (repetição) | *estado* de 64 | — | e2e |
| 79 | Novo Motorista — final (repetição) | *estado* de 65 | — | e2e |
| 80 | Dashboard Financeiro — KPIs e destaques | `/dashboard/finance` · `FinanceDashboardPage.vue` | `GET /finance/dashboard` | api/ref, e2e |
| 81 | Barras, rosca, indicadores da frota | *estado* (scroll) de 80 | idem | api/ref |
| 82 | Ocupação, caixa e próximos vencimentos | *estado* (scroll) de 80 | idem | api/ref |
| 83 | Contas Bancárias — card e ações | `/dashboard/finance/bank-accounts` · `BankAccountsPage.vue` | `GET /bank-accounts` | api/ref, api/flows T12 |
| 84 | Modal `Editar conta` | *modal* de 83 | `PATCH /bank-accounts/:id` | api/flows T12 |
| 85 | Extrato — filtros, 4 cards, tabela | `/dashboard/finance/bank-accounts/:id` · `BankStatementPage.vue` | `GET /bank-accounts/:id/statement` | api/ref |
| 86 | Extrato — movimentações e saldo corrido | *estado* (scroll) de 85 | idem + `.csv` | api/ref, api/flows T12 |
| 87 | Popover `Período personalizado` | *estado* de 80 | `GET /finance/dashboard?from=&to=` | api/ref |
| 88 | Contas Bancárias (repetição) | *estado* de 83 | idem | — |
| 89 | Modal `Nova conta bancária` | *modal* de 83 | `POST /bank-accounts` | api/flows T12 |
| 90 | Modal `Lançamento manual` | *modal* de 83 | `POST /bank-accounts/:id/manual-transactions` | api/flows T12 |
| 91 | Contas a Receber — total pendente e filtros | `/dashboard/finance/accounts-receivable` · `ReceivablesPage.vue` | `GET /receivables` | api/ref |
| 92 | Contas a Receber — tabela e contagem | *estado* (scroll) de 91 | idem | api/ref |
| 93 | Menu com ação `Pagar` | *menu* de 91 | `POST /receivables/:id/payments` | api/flows T14 |
| ext | Atalho "Lançar pagamento" (baixa) no detalhe do motorista e no menu da locação — extensão ao spec | `DriverDetailPage.vue`, `RentalListPage.vue` · `LaunchPaymentDialog.vue` | `GET /receivables?driverId=&rentalId=&openOnly=true` + `POST /receivables/:id/payments` | api/flows T14 |
| ext | Parcelamento de Contas a Pagar (financiamento, seguro, IPVA, licenciamento): N parcelas mensal/trimestral/semestral/anual, baixa por parcela — extensão ao spec | `PayableFormPage.vue`, `PayablesPage.vue` (badge "Parcela n/N") | `POST /payables` (`installments`) + `POST /payables/:id/payments` | api/payable-installments, web/payable-form-installments |
| ext | Categorias padrão de Contas a Pagar: IPVA, Licenciamento, Outro (upsert por slug) | `PayableFormPage.vue` | `GET /expense-categories` | api/flows T12/T14 |
| PDF 1 | Relatório de manutenções — identificação, resumo, grupos, histórico | `apps/api/src/pdf/maintenance-report.ts` | `GET /vehicles/:id/maintenance/report.pdf` | pdf, api/ref |
| PDF 2 | Detalhamento das OS, nota de canceladas, rodapé | idem | idem | pdf, api/ref |

---

## Cobertura dos testes do prompt master (§10)

| ID | Escopo | Onde |
|---|---|---|
| T01 | Login, sessão, permissões, isolamento entre organizações | api/flows |
| T02 | Sidebar, submenus, tema, popovers | e2e |
| T03 | Busca, filtros, ordenação, estado vazio, menus `⋮` | api/flows + e2e |
| T04 | CRUD de veículo, placa normalizada, duplicidade | api/flows |
| T05 | Importação: preview, limite 200, erros por linha, commit | api/flows |
| T06 | Motorista: CPF inválido, duplicado, CNH vencida, CEP | api/flows |
| T07 | Locação: datas, conflito, encerramento, disponibilidade | api/flows |
| T08 | Wizard de manutenção: validação por etapa e somas | api/flows + contracts |
| T09 | Concluir/cancelar OS e PDF equivalente ao golden master | api/flows, api/ref, pdf |
| T10 | Solicitar vistoria, envio honesto, formulário público | api/flows |
| T11 | Limite de 12 slots e preservação do histórico | api/flows |
| T12 | Conta padrão única, lançamento manual, extrato e CSV | api/flows |
| T13 | Contas a pagar com categoria, veículo, recorrência | api/flows |
| T14 | Recebível vencido, pagamento parcial, idempotência | api/flows |
| T15 | Dashboards, relatórios e DRE calculados | api/ref |
| T16 | Notificações críticas, filtros e leitura | api/ref |
| T17 | Template, tokens, prévia, rejeição sem destinatário | api/flows |
| T18 | Colaborador, convite, permissões, 403 | api/flows |
| T19 | Perfil, troca de senha, assinatura sem cobrança fingida | api/flows, api/ref |
| T20 | Capturas em 1917 px, claro/escuro, calibração métrica | `e2e/capture-screens.mjs`, `e2e/extract-reference-pages.mjs`, `e2e/measure-screens.mjs` + `docs/VISUAL-VERIFICATION.md` §4 |
| T21 | 400/401/403/404/409/422, tenant crossover, idempotência | api/flows |
| T22 | README reproduz o ambiente do zero | `README.md` |

## Vistoria pelo WhatsApp (YuDirect ⇄ Whaply)

Plano: `docs/architecture/yudirect-whaply-vistoria-plan.md`. Testes em
`apps/api/src/__tests__/whatsapp-integration.test.ts` contra o simulador
HTTP `apps/api/src/testing/fake-whaply.ts` (contrato v1 real: HMAC,
idempotência, sequência de eventos e mídia por referência).

| ID | Cenário | Cobertura |
|---|---|---|
| WA22 | Agendamento → disparo único (2 workers) → envio → status → fotos → KM → aguardando revisão → aprovação concorrente (1 vence) | api/whatsapp |
| WA23/WA24 | Painel: resumo, filtros, "requer ação", detalhe com linha do tempo, máscara de telefone, 403 sem permissão | api/whatsapp + e2e |
| WA25/WA27 | Fotos parciais: encerramento incompleto mantém PENDING e alerta | api/whatsapp |
| WA26 | Custos estimados por categoria com tarifa de referência; nunca exibidos como cobrança | api/whatsapp + e2e |
| WA27b | Foto duplicada (mesmo wamid) não duplica evidência | api/whatsapp |
| WA28 | Mídia inválida ou corrompida (hash) não é associada | api/whatsapp |
| WA29 | Ângulo não exigido vira evidência adicional | api/whatsapp |
| WA30 | Foto após a aprovação vira evidência tardia, sem alterar a decisão | api/whatsapp |
| WA31 | Whaply 503 + Retry-After → nova tentativa no horário | api/whatsapp |
| WA32 | Lembrete único (2 workers) e expiração com CANCEL da sessão | api/whatsapp |
| WA33 | Timeout com aceite posterior: retry com a mesma chave, sem duplicar | api/whatsapp |
| WA34/WA35 | Evento duplicado idempotente; fora de ordem não regride | api/whatsapp |
| WA34b | Mesmo telefone com coleta ativa: SESSION_BUSY aguarda sem consumir o limite | api/whatsapp |
| WA36 | Processo caiu durante o POST: reconciliação reenfileira com a mesma chave | api/whatsapp |
| WA37/WA37b | Cancelamento antes do disparo e entre intenção e envio | api/whatsapp |
| WA38 | Reagendamento antes do disparo; recusado após o envio | api/whatsapp |
| WA39 | Template não aprovado: falha definitiva, link manual, alerta, sem retry | api/whatsapp |
| WA40 | Opt-out (SAIR) revoga consentimento e cancela pendências | api/whatsapp |
| WA41/WA41b/WA41c | Sem consentimento / revogado / telefone diferente do cadastro | api/whatsapp + e2e |
| WA42/WA42b | Rota de eventos: assinatura, chave, relógio, replay de nonce; integração desligada → 503 | api/whatsapp |
| WA43 | Tipo de evento desconhecido aceito e ignorado (compatibilidade) | api/whatsapp |
| WA44 | Foto sem vínculo: resolução manual auditada, 403 sem permissão | api/whatsapp |
| WA45 | Correção: volta a PENDING, rodada nova, versiona evidências, ignora foto da rodada antiga | api/whatsapp + e2e |
| WA46 | Aprovar/corrigir em estado inválido → 409; sem permissão → 403 | api/whatsapp |
| WA47 | Mídia indisponível: inbox reprocessa depois | api/whatsapp |
| WA48/WA48b | Callback perdido: replay por sequência; polling do estado | api/whatsapp |
| WA49/WA49b | Reenvio manual (nova chave, auditado, sem duplicidade); reprocessamento de transporte (mesma chave) | api/whatsapp |
| WA50 | Instruções da coleta (serviço) registradas por wamid para custos | api/whatsapp |
| WA21 | Envio pelo link web rejeita arquivo de outra organização (IDOR corrigido) | api/whatsapp |

### E2E entre sistemas e de interface

| ID | Cenário | Cobertura |
|---|---|---|
| WAX1 | Caminho completo com o código real dos dois lados: template pela conta da FF, status com pricing, botão assinado, 5 fotos + KM, bytes íntegros (sha256), aprovação humana; nenhum envio por outro tenant | `e2e-whaply-cross.test.ts` |
| WAX2 | Resposta perdida + retry com a mesma chave: 1 único envio na Meta | `e2e-whaply-cross.test.ts` |
| WAX3 | Template pausado no Whaply → falha definitiva e link manual no YuDirect | `e2e-whaply-cross.test.ts` |
| WAX4 | Falha permanente da Meta (131026) chega com origem META | `e2e-whaply-cross.test.ts` |
| WAX5 | YuDirect fora do ar: eventos acumulam e a reconciliação recupera por sequência | `e2e-whaply-cross.test.ts` |
| WAX6 | SAIR revoga o consentimento no YuDirect | `e2e-whaply-cross.test.ts` |
| WAX7 | Foto fora da coleta → "sem vínculo" → atribuição pela equipe | `e2e-whaply-cross.test.ts` |
| WAX8 | Correção em nova rodada pelo template de correção, foto antiga vira histórico | `e2e-whaply-cross.test.ts` |
| WAX9 | Chave errada → 401 SIGNATURE_INVALID, nada enviado | `e2e-whaply-cross.test.ts` |
| WAU1 | Consentimento: registrar (origem) e revogar com confirmação | `e2e/whatsapp-vistoria.spec.ts` |
| WAU2 | Configuração da coleta persiste; canal desconectado exibido com honestidade | `e2e/whatsapp-vistoria.spec.ts` |
| WAU3 | Painel: menu, aviso de canal, métricas = API, histórico vazio com filtros, custos (estimativa + tarifa válida/inválida), fotos sem vínculo | `e2e/whatsapp-vistoria.spec.ts` |
| WAU4 | Solicitar correção: validação, fallback para link web sem canal, vistoria volta a Pendente | `e2e/whatsapp-vistoria.spec.ts` |

### Vistorias recorrentes (regra da locação)

Regra: `WEEKLY` a cada 7 dias e `MONTHLY` a cada 30 dias a partir do início
da locação (a vistoria de retirada não é repetida); com dia da semana
definido, vai para o próximo dia escolhido. Criadas com antecedência de
2 dias pelo job das rotinas (`generateScheduledInspections`), sem gerar
atrasados e sem passar do fim da locação.

| ID | Cenário | Cobertura |
|---|---|---|
| WA51 | Uma única vistoria por ocorrência com dois workers e execuções repetidas; auditoria | api/inspection-schedule |
| WA52 | Com consentimento: coleta pelo WhatsApp no horário configurado da data e envio ao Whaply | api/inspection-schedule |
| WA53 | Sem consentimento: link manual + alerta, nada enviado | api/inspection-schedule |
| WA54 | Gerada e cancelada não é recriada; semana seguinte gerada | api/inspection-schedule |
| WA55 | Vistoria aberta próxima da data (ex.: manual) evita empilhar | api/inspection-schedule |
| WA56 | Sem atrasados, sem passar do fim da locação, locação sem regra fora | api/inspection-schedule |
| WA57 | Cartão do painel mostra a próxima data pela mesma regra | api/inspection-schedule |
| WA58 | Histórico identifica a vistoria recorrente | api/inspection-schedule + UI |
| — | Calendário: dia da semana, semanal/mensal, fim da locação, locação longa | api/inspection-schedule (unitário) |
