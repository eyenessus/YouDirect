# 05 — Testes executados

Ambiente: Windows 11, Node 24, MongoDB **em memória** (replica set, `mongodb-memory-server`), dados fictícios do seed. O harness (`testing/harness.ts`) e o `dev-demo.ts` forçam `MONGODB_URI=''`, ou seja, **nenhum teste usa banco real**.
Datas: os testes usam `businessDate()` (fuso America/Sao_Paulo) e deltas (antes/depois), nunca valores absolutos que dependam do relógio.

## Comandos e resultado final (código após as correções **e após mesclar a `main`**)
| Comando | Resultado |
|---|---|
| `npm run build` | OK (contracts, api, web) |
| `npm run typecheck` | 0 erros |
| `npm run lint` | **0 erros**, 13 avisos (todos anteriores à auditoria) |
| `npm run test -w @yudirect/contracts` | **29 passaram** (eram 17; +12 de datas de calendário) |
| `npm run test -w @yudirect/api` | **218 passaram, 9 pulados**, 10 arquivos (+1 arquivo pulado). Os 28 a mais vêm dos testes da frente de endurecimento (`finance-integrity`, `security-hardening`) |
| `npm run test -w @yudirect/web` | **54 passaram**, 8 arquivos |
| Playwright (`e2e/`), Chrome real, API+web em portas isoladas | **34 passaram** (inclui 7 desta frente: 6 em `zz-auditoria-baixa.spec.ts` e 1 em `zz-baixa-pelo-motorista.spec.ts`, mais `security-headers` da `main`) |

Os 9 testes pulados são `e2e-whaply-cross.test.ts` (exigem o Whaply real; **não verificável** aqui).
Nota operacional: na primeira tentativa o E2E falhou no login com "Origem não permitida" porque **outro processo (`dev-demo` de outra pasta, `frotaone-hardening`) ocupava a porta 3333** e o Playwright o reutilizou. Não é defeito do produto; o E2E final foi executado em portas próprias (3334/4174) e o processo alheio não foi tocado.

## Bateria de auditoria — `apps/api/src/__tests__/audit-financeiro.test.ts`
Primeira execução (antes de qualquer correção): **28 testes, 21 passaram, 7 falharam**. Os 7 falharam por defeitos reais (colunas "Antes"). Depois das correções e da mesclagem com a `main`: **28/28**.

| Id | Cenário | Antes | Depois |
|---|---|---|---|
| AUD-01 | Recebimento completo R$ 800: persiste, quita, receita +80000 exatos no mês, despesas intactas, receita do veículo +80000 | ✔ | ✔ |
| AUD-02 | Pagamento duplicado (mesma chave): 1 recebimento | ✔ | ✔ |
| AUD-02b | 10 cliques simultâneos, mesma chave → 1 recebimento | ✔ | ✔ |
| AUD-02c | Mesma chave, **valor diferente** → não pode dar sucesso | ✘ (200) | ✔ (409) |
| AUD-02d | Duas requisições iguais **sem chave**, em sequência → dois pagamentos legítimos (a `main` passou a incluir a versão da conta no hash; cliques simultâneos ainda se fundem) | ✔ (regra antiga: 200) | ✔ (regra nova: 201) |
| AUD-03 | Parcial R$ 300 de R$ 800 → 500 pendentes, não quitada | ✔ | ✔ |
| AUD-03b | Parciais não passam do saldo (422), sem crédito silencioso | ✔ | ✔ |
| AUD-03c | 2 baixas simultâneas que somadas excedem o saldo: só 1 vence; Σ pagamentos = saldo | ✔ | ✔ |
| AUD-04 | Vencimento 09/11/2026, pagamento 10/11/2026: datas preservadas + trilha de auditoria | ✔ | ✔ |
| AUD-05 | Financiamento R$ 1.500 no veículo A: previsto ≠ pago; receita intacta; só entra no veículo A ao pagar | ✔ | ✔ |
| AUD-06 | Despesa no veículo B move o ranking; um recebimento depois **não** o altera | ✔ | ✔ |
| AUD-07a | Estorno de despesa paga: extrato estornado **e** dashboard/ranking corrigidos | ✘ (`1382654 ≠ 1327099`) | ✔ |
| AUD-07b | Estorno de recebimento: histórico preservado, receita −R$ 800, repetir não duplica | ✘ (404) | ✔ |
| AUD-08 | Receita e despesa respeitam a data de liquidação, em meses diferentes | ✔ | ✔ |
| AUD-08b | Pagamento com data futura recusado | ✘ (201) | ✔ (422) |
| AUD-09 | Encerrar locação não deixa cobrança de períodos posteriores | ✘ (320000 permanece) | ✔ **corrigido na `main`** (`syncContractReceivable`); deixou de ser `it.fails` |
| AUD-09b | Locação sem término, encerrada, não ganha semanas novas | ✔ | ✔ |
| AUD-10 | Isolamento: empresa B não lê/altera receitas, despesas, locações, veículos, motoristas, categorias; dashboards da B zerados | ✔ | ✔ |
| AUD-11 | 11 entradas inválidas na baixa (valor negativo/zero/decimal/texto, data inválida, método, banco) → 4xx, nunca 500 | ✘ (`2026-02-30` → 201) | ✔ |
| AUD-11b | Conta a pagar inválida (valor, data, categoria/veículo inexistentes) → 4xx | ✘ (`2026-02-30` → 201) | ✔ |
| AUD-11c | Despesa de veículo **sem veículo** | documenta: aceita (PEND-01) | idem |
| AUD-12 | Baixas simultâneas e repetidas de despesa não pagam além do valor | ✔ | ✔ |
| AUD-13 | Recorrência gerada 2× no mês seguinte → 1 conta | ✔ | ✔ |
| AUD-13b | Histórico de alterações (criação + edição) na auditoria | ✔ | ✔ |
| AUD-14 | Arquivar veículo com despesa paga não faz o custo sumir do relatório por veículo | passava "no vazio"; **após reforçar o teste: ✘ (211667 → 189445)** | ✔ |
| AUD-14b | Receita do dashboard = Σ pagamentos no banco (conciliação) | ✔ | ✔ |
| AUD-14c | Saldo bancário = saldo inicial + Σ lançamentos | ✔ | ✔ |
| AUD-15 | Sem `finance.pay` não baixa (receber/pagar/excluir); sem `finance.read` não vê dashboard | ✔ | ✔ |

> Honestidade metodológica: o AUD-14 original era fraco (o ramo de veículo arquivado passava por um valor de reserva). Foi reescrito como comparação estrita antes/depois e só então revelou o B-08.

## Outras suítes novas desta frente
| Arquivo | Testes | O que cobre |
|---|---|---|
| `api/payment-schedule.test.ts` | 17 | cronograma semanal: FIFO, última semana, atraso, 1ª semana adiantada, caução fora, contrato sem término, dashboards |
| `api/payable-installments.test.ts` | 10 | datas mensal/trimestral/semestral/anual, 29/02, 12 parcelas, baixa por parcela, "já paga" só na 1ª, validações |
| `api/payment-settlement.test.ts` | 9 | baixa → conta, extrato e os dois dashboards, filtros por motorista/locação, categorias |
| `web/payment-schedule-dialog.test.ts` | 8 | tabela de semanas, "Dar baixa" com valor acumulado, valor livre |
| `web/launch-payment.test.ts` | 7 | diálogo e chave de idempotência por abertura do modal |
| `web/payable-form-installments.test.ts` | 3 | formulário parcelado, exclusão recorrência × parcelamento |
| `web/payment-date-timezone.test.ts` | 2 | 23h30 em São Paulo continua sendo "hoje" (falha com o código antigo, comprovado) |
| `e2e/zz-auditoria-baixa.spec.ts` | 6 | baixa pela UI, clique duplo, valor acima do saldo, categorias, financiamento parcelado |
| `e2e/zz-baixa-pelo-motorista.spec.ts` | 1 | lista de locações → nome do motorista → Lançar pagamento (só as contas dele) → baixa persistida |

## Validações de sanidade (os testes pegam o defeito?)
- Reintroduzido o FIFO invertido → 9 falhas; extensão de contratos sem término desligada → 1 falha; chave de idempotência constante no modal → 1 falha; data UTC no modal → 1 falha. Em todos os casos o código foi restaurado.

## Não executado (e por quê)
- Falha de rede real, concorrência entre processos distintos da API, carga/performance, responsividade/acessibilidade com ferramenta dedicada, LGPD, backup/restauração, pipeline de deploy, integração real com Whaply/provedor de assinatura: **não verificável** neste ambiente.
