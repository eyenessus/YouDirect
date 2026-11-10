# 03 — Auditoria financeira: regras, fórmulas e inconsistências

## Modelo de dados financeiro (como o código funciona)
- Valores em **centavos inteiros** em todo o caminho (contrato Zod `amountCentsSchema`: inteiro, ≥ 0, `Number.MAX_SAFE_INTEGER`); a máscara do front é só apresentação. Não há ponto flutuante em dinheiro. ✔
- `receivables`: **uma conta por contrato** (`expectedPeriod: 'CONTRACT'`), `grossAmountCents = valor do período × períodos`, `paidAmountCents`, `dueDate` = fim do 1º período, `version` (lock otimista).
- `payables`: uma conta por despesa; parcelamento gera N contas ligadas por `installment.seriesId`.
- `payments`: um documento por baixa (`sourceType` RECEIVABLE/PAYABLE, `paidAt`, `idempotencyKey` único por organização). **Novo:** `reversedAt/reversedReason/reversalTransactionId` para estorno (o pagamento original é preservado).
- `bankTransactions`: razão da conta bancária; estorno = lançamento inverso, nunca exclusão.
- Cada baixa roda numa **transação MongoDB** (pagamento + lançamento no extrato + status da conta + auditoria).

## Status derivados (`services/finance.ts`)
`restante = max(total − pago, 0)` · `PAID` se restante = 0 · `OVERDUE` se restante > 0 e vencimento < hoje · `PARTIAL` se 0 < pago e no prazo · `OPEN/PENDING` caso contrário · `CANCELED` é terminal.

## Fórmulas dos indicadores (documentadas a partir do código, `services/analytics.ts`)
Base temporal: **data de liquidação** (`payments.paidAt`), não competência.

| Indicador | Fórmula | Exclui | Observação |
|---|---|---|---|
| Receita recebida (`revenueCents`, `monthlyRevenueCents`) | Σ `payments` RECEIVABLE com `paidAt` ∈ período **e não estornados** | caução, lançamentos manuais, estornados | Recebimento de locação **nunca** soma em despesa |
| Despesas (`expensesCents`) | Σ `payments` PAYABLE no período (não estornados) + Σ OS de manutenção `COMPLETED` com lançamento, por `completedAt` | contas só *lançadas* (não pagas), estornadas | Despesa "prevista" **não** entra |
| Lucro / margem | receita − despesas; lucro ÷ receita | — | |
| Despesas por categoria | Σ `payments` PAYABLE por categoria da conta + "Manutenção" | estornados | |
| Receita/Despesa por veículo | receita: `payment → receivable → rental.vehicleId`; despesa: `payment → payable.vehicleId` + manutenção por `vehicleId` | estornados | Despesa **sem veículo** conta no total geral mas em nenhum veículo (esperado) |
| Ranking "mais despesas" / "mais lucrativos" | top 3 por despesa / lucro por veículo no mês, delta vs. mês anterior | estornados | Reage só a despesas pagas; recebimento não move o ranking de despesas (AUD-06 ✔) |
| Evolução (6 meses) | mesma regra de receita/despesa por mês de `paidAt` | estornados | |
| A receber / A pagar (30 dias) | contas com vencimento nos próximos 30 dias (lista de 5) | pagas | informativo, não é competência |
| Vencidas | Σ (total − pago) das contas a receber com vencimento < hoje | pagas | usa o vencimento da conta (1ª semana) — R-06 |
| Caixa | saldo atual das contas bancárias (saldo inicial + lançamentos) | — | conciliado em AUD-14c |

**Lacuna de produto:** não existem indicadores de **receita prevista** nem de **despesas lançadas (competência)**; só realizado. Por isso "não misturar previsto com pago" está atendido por construção, mas o gestor não vê o previsto como número no dashboard (R13).

## Inconsistências encontradas
Ver `04-bugs-priorizados.md`. Resumo: estorno de despesa não saía do dashboard (B-01), datas de calendário inválidas eram aceitas (B-02), encerrar locação não ajusta cobrança (B-03), recebimento não podia ser estornado (B-04), data futura aceita (B-05), chave de idempotência com outro valor retornava sucesso (B-06), data padrão em UTC (B-07), custo sumia ao arquivar veículo (B-08).

## Verificado sem defeito
- **Concorrência:** 10 cliques simultâneos com a mesma chave → 1 pagamento; 2 baixas simultâneas de R$ 600 em saldo de R$ 800 → só 1 vence e a soma dos pagamentos = saldo (AUD-02b, 03c, 12).
- **Excedente:** pagamento acima do saldo → 422, sem crédito silencioso (AUD-03b).
- **Parcial:** R$ 300 de R$ 800 → R$ 500 pendentes, não quitada (AUD-03).
- **Atraso:** vencimento 09/11/2026 e pagamento 10/11/2026 preservam as duas datas; trilha de auditoria `receivable.payment` (AUD-04).
- **Conciliação:** receita do dashboard = Σ pagamentos no banco; saldo bancário = saldo inicial + Σ lançamentos (AUD-14b/c).
- **Isolamento:** empresa B não lê nem altera nada da A (receitas, despesas, locações, veículos, motoristas, categorias) (AUD-10).
- **Permissões:** sem `finance.pay` não baixa; sem `finance.read` não vê dashboard; sem `finance.delete` não estorna (AUD-15).

## Riscos sem prova por teste (marcados como hipótese)
- A baixa antecipada do 1º período, feita na criação da locação, insere o pagamento com `paidAt = startDate` direto no banco e **não passa** pela regra de data futura (inferido do código `rentals/routes.ts`; não testado).
- Consequência provável de B-02 (antes da correção): um `paidAt` como `2026-02-30` não cai em nenhuma faixa mensal (comparação lexicográfica de strings) e o pagamento ficaria fora de todos os meses. **Inferido; a aceitação da data inválida foi comprovada, o sumiço nos relatórios não foi executado.**
