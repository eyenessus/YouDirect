# 04 — Defeitos comprovados, riscos e lacunas (priorizados)

Classificação: **P0** perda de dados / falha financeira crítica / acesso indevido / fluxo principal indisponível · **P1** regra de negócio incorreta ou inconsistência relevante · **P2** usabilidade/robustez de baixo risco.
**Nenhum P0 foi encontrado.** Cada item abaixo marca se é *defeito confirmado por teste executado*, *risco/hipótese* ou *lacuna de produto*. Os testes são `apps/api/src/__tests__/audit-financeiro.test.ts` (ids AUD-xx), `apps/web/src/__tests__/payment-date-timezone.test.ts` e `e2e/zz-auditoria-baixa.spec.ts`.

Resumo: **P0: 0 · P1: 4 defeitos + 1 risco de segurança · P2: 3 defeitos.** Corrigidos: 7. Abertos: 1 defeito (B-03) + riscos/lacunas.

---
## B-01 · P1 · Estorno de despesa paga não saía do dashboard nem do ranking — **CONFIRMADO, CORRIGIDO**
- **Módulo:** Contas a pagar / Dashboard.
- **Código:** `services/finance.ts` → `reversePaymentsOf` (l. 603); `services/analytics.ts` (7 agregações de `payments`).
- **Reproduzir:** pagar uma conta (R$ 555,55) → `DELETE /payables/:id` → comparar `GET /finance/dashboard`.
- **Esperado:** despesa do mês cai R$ 555,55 e o veículo deixa de acumulá-la. **Obtido:** extrato estornado, mas dashboard manteve a despesa (`expected 1382654 to be 1327099`, diferença exata de 55.555).
- **Causa raiz:** o estorno inseria o lançamento inverso no extrato mas deixava o documento `payments` intacto, e as agregações somavam `payments` sem distinguir estornados.
- **Correção:** marcar o pagamento (`reversedAt`, `reversedReason`, `reversalTransactionId`) e filtrar `reversedAt: null` nas 7 agregações.
- **Regressão:** AUD-07a (falhava antes, passa depois).

## B-02 · P1 · Datas de calendário inválidas eram aceitas (`2026-02-30`) — **CONFIRMADO, CORRIGIDO**
- **Módulo:** contratos compartilhados (todas as rotas com data).
- **Código:** `packages/contracts/src/common.ts` → `isoDateSchema`.
- **Reproduzir:** `POST /receivables/:id/payments` com `paidAt: "2026-02-30"` → **201** (antes). Idem `dueDate` de conta a pagar (AUD-11, AUD-11b).
- **Causa raiz:** validação por `Date.parse`, que "rola" 30/02 para março em vez de rejeitar.
- **Correção:** validar por ida e volta (`new Date(v).toISOString().slice(0,10) === v`).
- **Regressão:** AUD-11, AUD-11b e 12 casos em `contracts/__tests__/domain.test.ts`.
- **Hipótese (não executada):** como os relatórios filtram por comparação de strings de data, um `paidAt` inválido não cairia em nenhuma faixa mensal.

## B-03 · P1 · Encerrar a locação não ajusta a cobrança — **CONFIRMADO, ABERTO (decisão de produto)**
- **Módulo:** Locações / Contas a receber. **Código:** `modules/rentals/routes.ts` → `POST /rentals/:id/close` (l. 490).
- **Reproduzir:** locação de 4 semanas (R$ 3.200) sem pagamentos, encerrar no 1º dia → `grossAmountCents` continua 320000 (AUD-09, marcado `it.fails`).
- **Esperado:** não restar cobrança de períodos posteriores ao encerramento. **Obtido:** o contrato inteiro segue "a receber"/vencendo.
- **Por que não corrigi:** exige política (cobrar o período corrente inteiro? pró-rata? multa?). Ver PEND-02.
- **Proposta:** ao encerrar, reduzir o total a `períodos iniciados até a data × valor` (política A) ou pró-rata (B), registrar a alteração na auditoria e cancelar o saldo de períodos futuros.
- **Obs.:** locação **sem término** já não ganha semanas novas após encerrada (AUD-09b ✔).

## B-04 · P1 · Recebimento não podia ser estornado/corrigido — **LACUNA CONFIRMADA, API CORRIGIDA, UI PENDENTE**
- **Código:** não havia rota; criado `POST /receivables/:id/payments/:paymentId/reverse` (`accounts.ts` l. 651, permissão `finance.delete`) e `reverseReceivablePayment` (`services/finance.ts` l. 414).
- **Obtido antes:** `404` (AUD-07b). **Agora:** histórico preservado (pagamento marcado como estornado), extrato recebe o estorno, receita do período cai exatamente o valor, repetir o estorno não duplica o efeito, auditoria `receivable.payment.reversed`.
- **Pendente:** botão na interface (e exibição de "estornado" na lista de pagamentos). **Correção de valor (800 → 700)** = estornar + lançar de novo.

## B-05 · P2 · Pagamento "realizado" com data futura era aceito — **CONFIRMADO, CORRIGIDO**
- **Código:** `services/finance.ts` → `assertPaidAtNotFuture` (l. 389), usado nas duas baixas. **Antes:** AUD-08b recebia **201** com `paidAt` +60 dias (inflaria um mês futuro). **Agora:** 422.
- **Efeito colateral tratado:** testes antigos usavam datas futuras fixas e foram ajustados para `businessDate()`.

## B-06 · P2 · Chave de idempotência reutilizada com outro valor retornava sucesso — **CONFIRMADO, CORRIGIDO**
- **Código:** `assertSameIdempotentRequest` (l. 396). **Antes (AUD-02c):** segunda chamada com mesma chave e **valor diferente** → 200 "ok", mas os R$ 500 não eram gravados (sucesso falso). **Agora:** 409. Repetição **idêntica** continua 200 (AUD-02/02b).

## B-07 · P2 · Datas padrão em UTC nos formulários — **CONFIRMADO (teste de regressão), CORRIGIDO NO FINANCEIRO; resto ABERTO**
- Os formulários usavam `new Date().toISOString().slice(0,10)` (UTC). Em São Paulo, após 21h já é "amanhã": **com a regra B-05 a baixa noturna seria recusada.** Corrigido em `RegisterPaymentModal`, `PayableFormPage`, `BankAccountsPage` usando `businessDate()` (`payment-date-timezone.test.ts`: falha com o código antigo, passa com o novo).
- **Aberto (P2):** `MaintenanceWizardPage.vue` (`performedAt`), `RequestInspectionModal.vue` (`scheduledAt`), `BankStatementPage.vue` (último dia do mês) e `MessagesPage.vue` seguem o padrão antigo.

## B-08 · P1 · Arquivar um veículo com despesa paga fazia o custo sumir do relatório por veículo — **CONFIRMADO, CORRIGIDO**
- **Código:** `modules/reports/routes.ts` (`/reports/by-vehicle` e os rankings filtravam `archivedAt: null`). `DELETE /vehicles/:id` apenas arquiva.
- **Reproduzir (AUD-14):** pagar R$ 222,22 no veículo → arquivar → soma por veículo cai de 211.667 para 189.445, enquanto o total geral mantém a despesa. No painel o ranking mostrava "—" no lugar da placa.
- **Correção:** arquivados entram se tiveram movimento no período (rótulo "(arquivado)") e o ranking passa a resolver o nome.

---
## Riscos e lacunas (não são defeitos de código confirmados)
| Id | Tipo | Gravidade | Descrição | Status |
|---|---|---|---|---|
| R-01 | **Segurança (confirmado por execução)** | P1 | Com `NODE_ENV=production` e sem `SESSION_SECRET`, a API **sobe com o segredo padrão público** `dev-only-session-secret-change-me` (`config/env.ts` l. 31). Também `SEED_OWNER_PASSWORD` tem padrão conhecido (só relevante se o seed rodar em produção) | Aberto — PEND-03 (rollout) |
| R-02 | Regra de produto | P1 | Despesa de financiamento/IPVA/licenciamento/seguro aceita **sem veículo** (AUD-11c documenta) | PEND-01 |
| R-03 | Não implementado | P1 | Sem "responsável financeiro" (empresa/proprietário/motorista) na despesa | PEND-04 |
| R-04 | Não implementado | P2 | Dashboard sem receita **prevista** nem despesas **lançadas** (só realizado) | PEND-05 |
| R-05 | Hipótese | P2 | Adiantamento do 1º período na criação da locação grava `paidAt = startDate` direto no banco, sem passar pela regra de data futura | Aberto, sem teste |
| R-06 | Limitação conhecida | P2 | Status da **conta** (e "vencidas" do dashboard) usa o vencimento da 1ª semana; o cronograma por semana é o correto | Aberto |
| R-07 | Documentação/ambiente | P2 | `docs/openapi.json` não lista os endpoints novos; `npm run openapi` falha (esbuild 0.23.1 × 0.24.2) | Aberto |
| R-08 | **Não auditado** | — | LGPD, backup/restauração, pipeline de deploy, monitoramento, performance, acessibilidade, responsividade | NV |
