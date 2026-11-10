# 02 — Requisitos do cliente (Erick) e lacunas

Fonte: pedidos da conversa (baixa de pagamento do motorista, dashboard não atualizava, categorias IPVA/licenciamento, parcelas de financiamento, baixa semanal) e a missão de auditoria.

| # | Requisito | Estado após esta auditoria | Evidência | Lacuna / observação |
|---|---|---|---|---|
| R1 | Dar baixa no pagamento do motorista em Locações > Consultar > motorista | **Atendido, refeito conforme o fluxo real do Frota One** | E2E `zz-baixa-pelo-motorista` (10 cenários no Chrome), `rental-payments-ui.test.ts` | Caminho: nome do motorista > Lançar pagamento > página da locação (aba Pagamentos) |
| R2 | Pagamento **semanal** | **Atendido** como lançamentos individuais (cada semana paga é um lançamento com recibo, categoria, data prevista e data do pagamento **informadas pelo dono**) | `rental-payments.test.ts` (26) | Substitui o cronograma calculado, que era proposta minha (o vídeo não o tem) |
| R3 | Dashboard reflete o recebimento (uma vez) | **Atendido** | AUD-01/02/02b, E2E "uma vez" | Só mede **receita realizada** (por data de pagamento) |
| R4 | Categorias IPVA, licenciamento e outros em Contas a Pagar | **Atendido** | AUD-11b, E2E categorias, `payment-settlement` | Upsert por slug para organizações existentes |
| R5 | Financiamento parcelado (1/N), periodicidade mensal/trimestral/semestral/anual | **Atendido** (todas as parcelas na criação) | `payable-installments.test.ts` (10), E2E | Sem editar/cancelar a série inteira de uma vez |
| R6 | Cadastrar despesa de financiamento/IPVA/licenciamento/seguro **por veículo** | **Parcial** | AUD-05, AUD-11c | O veículo é **opcional** (PEND-01) |
| R7 | Informar valor, vencimento **e pagamento** | **Atendido** | AUD-04/05/08 | Conta a pagar tem vencimento + data do pagamento; recebimento guarda vencimento + data efetiva |
| R8 | Registrar baixas sem duplicar | **Atendido** | AUD-02, 02b (10 simultâneos), 03c, 12 | Chave reutilizada com outro valor agora é recusada (B-06) |
| R9 | Acompanhar custos por veículo | **Atendido após B-08** | AUD-05/06/14 | Arquivar veículo fazia o custo sumir (corrigido) |
| R10 | Identificar cobranças pendentes e atrasadas | **Parcial** | cronograma, `OVERDUE` por semana | O status da **conta inteira** segue o vencimento da 1ª semana (R-06) |
| R11 | Estornar/corrigir recebimento (R$ 800 → R$ 700) | **API pronta; UI pendente** | AUD-07b | Falta botão na interface (B-04) |
| R12 | Responsável financeiro da despesa (empresa/proprietário/motorista) | **Não implementado** | — | Não há campo; PEND-04 |
| R13 | Receita **prevista** × realizada; despesa **lançada** × paga | **Não implementado** nos indicadores | `03` | O dashboard só mostra o realizado; "a receber/a pagar 30 dias" é lista, não indicador de competência |
| R14 | Encerrar locação sem novas cobranças indevidas | **Atendido** (corrigido na `main`, validado) | AUD-09 | Confirmar a política (períodos inteiros até o encerramento) — PEND-02 |
