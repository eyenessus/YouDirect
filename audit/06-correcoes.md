# 06 — Correções realizadas e validação

Todas em `audit/auditoria-financeira`, cada uma com teste de regressão. Nenhuma alteração destrutiva de dados; nenhum registro financeiro foi apagado.

| Defeito | Arquivos alterados | Mudança | Regressão | Evidência |
|---|---|---|---|---|
| B-01 estorno de despesa não saía do dashboard | `database/types.ts`, `services/finance.ts` (`reversePaymentsOf`), `services/analytics.ts` (7 agregações) | `payments` ganha `reversedAt/reversedReason/reversalTransactionId`; o estorno marca o pagamento; agregações filtram `reversedAt: null` | AUD-07a | antes `expected 1382654 to be 1327099`; depois passa |
| B-02 datas de calendário inválidas | `contracts/common.ts` | `isoDateSchema` valida por ida e volta | AUD-11, AUD-11b, 12 casos em `domain.test.ts` | antes `{"paidAt":"2026-02-30"}: expected 201 to be ≥ 400` |
| B-04 sem estorno de recebimento | `services/finance.ts` (`reverseReceivablePayment`), `modules/finance/accounts.ts` (`POST /receivables/:id/payments/:paymentId/reverse`, permissão `finance.delete`), `contracts/finance.ts` (`reversePaymentSchema`) | estorno transacional: preserva o pagamento, lança estorno no extrato, devolve o saldo à conta, lock otimista, auditoria; idempotente | AUD-07b | antes `404`; depois receita −R$ 800 e repetição sem efeito |
| B-05 data de pagamento futura | `services/finance.ts` (`assertPaidAtNotFuture`) | 422 para `paidAt` > hoje nas duas baixas | AUD-08b | antes `201` |
| B-06 mesma chave, outro valor | `services/finance.ts` (`assertSameIdempotentRequest`) | 409 se valor/data/conta divergem da chave já usada | AUD-02c | antes `200` |
| B-07 data padrão em UTC | `RegisterPaymentModal.vue`, `PayableFormPage.vue`, `BankAccountsPage.vue` | `businessDate()` no lugar de `toISOString()` | `payment-date-timezone.test.ts` | falha com o código antigo (23h30 BRT) |
| B-08 arquivar veículo escondia o custo | `modules/reports/routes.ts` | arquivados com movimento no período aparecem no relatório por veículo (rótulo "(arquivado)"); rankings resolvem o nome | AUD-14 (reforçado) | antes `expected 189445 to be 211667` |

Ajustes de testes que a correção exigiu (não são mudança de produto): `flows.test.ts` usava datas de pagamento fixas no futuro (agora `businessDate()`); o AUD-14b passou a excluir estornados na conciliação.

## Funcionalidades entregues no mesmo ciclo (pedidos do cliente)
Atalho de baixa no motorista/locação, cronograma semanal com "Dar baixa", parcelamento de contas a pagar (mensal/trimestral/semestral/anual), categorias IPVA/Licenciamento/Outro. Detalhes em `02` e `docs/TRACEABILITY.md`.

## Como reverter
- Tudo é código aplicativo: reverter o merge/commit da branch restaura o comportamento anterior.
- **Dados:** a única mudança de esquema é aditiva e opcional (campos `reversedAt*` em `payments`, `installment` em `payables`). Documentos antigos continuam válidos (`reversedAt` ausente = não estornado; `installment` ausente = conta avulsa). Não há migração obrigatória.
- Reverter o código **depois** de existirem pagamentos estornados faria o dashboard voltar a contá-los (o campo ficaria ignorado). Se precisar voltar atrás em produção, reverter junto com uma checagem manual de `payments.reversedAt`.

## Evidência final
`npm run build` ✔ · `typecheck` 0 erros · `lint` 0 erros · contracts 29 · API 190 (+9 pulados) · web 54 · E2E 32/32. Detalhes em `05-testes-executados.md`.
