# 07 — Pendências, bloqueios e decisões de negócio

## Decisões de produto (precisam de resposta antes de alterar comportamento financeiro)
| Id | Dúvida | Opções | Recomendação | Impacto de não decidir |
|---|---|---|---|---|
| PEND-01 | Despesa de **financiamento, IPVA, licenciamento e seguro** deve exigir veículo? Hoje o campo é opcional | (a) obrigatório para essas categorias; (b) obrigatório sempre; (c) manter opcional | (a): categorias "de veículo" exigem veículo; "Outro" continua livre | custo por veículo e ranking subnotificam o que foi lançado sem veículo |
| PEND-02 | **Encerramento da locação** (B-03): o que cobrar? | (A) períodos iniciados até a data de encerramento; (B) pró-rata; (C) manter e deixar o operador ajustar | (A) com ajuste manual auditado; fixar também a política para pagamentos já feitos além do devido (crédito/estorno) | contrato encerrado continua "a receber" por semanas inexistentes e infla inadimplência/vencidas |
| PEND-03 | **`SESSION_SECRET` em produção** (R-01): recusar o boot se for o valor padrão? | recusar em `NODE_ENV=production` | sim — **mas só depois de confirmar que o ambiente de deploy já define o segredo**; caso contrário o app deixa de subir | cookies assinados com segredo público |
| PEND-04 | **Responsável financeiro** da despesa (empresa/proprietário/motorista) | novo campo `payer` (+ regras de repasse ao motorista) | levantar com o Erick quais despesas são repassadas | não há como separar o que é do motorista |
| PEND-05 | Indicadores **previsto** e **lançado** no dashboard | adicionar "Receita prevista" e "Despesas lançadas" por competência, sem misturar com o realizado | adicionar como cards separados com fórmula visível | gestor só enxerga caixa realizado |
| PEND-06 | Política de **excedente** (pagou mais que o saldo) | hoje: recusa (422). Alternativa: crédito para a próxima semana | manter recusa até haver regra de crédito | ok enquanto o operador lança o valor correto |
| PEND-07 | Vencimento da conta de locação (R-06): usar o da **próxima semana em aberto** | recalcular `dueDate` conforme as semanas pagas | sim, junto de PEND-02 | "vencidas" do dashboard superestima atraso |

## Trabalho técnico pendente
- **UI do estorno de recebimento** (B-04): botão "Estornar" na lista de pagamentos da conta, com motivo obrigatório e confirmação; exibir "estornado".
- B-07 restante: trocar `toISOString().slice(0,10)` por `businessDate()` em `MaintenanceWizardPage`, `RequestInspectionModal`, `BankStatementPage`, `MessagesPage`.
- R-05: passar o adiantamento do 1º período (criado junto da locação) pela mesma regra de data de pagamento (hoje usa `paidAt = startDate` direto).
- Lançamento manual na conta bancária aceita data futura (não barrado).
- R-07: regenerar `docs/openapi.json` (endpoints de cronograma, estorno, parcelamento, filtros) e corrigir o `esbuild` local (host 0.23.1 × binário 0.24.2).
- Editar/cancelar a **série de parcelas** de uma vez.

## Segurança operacional — ação imediata recomendada
- Durante esta auditoria, um comando de inspeção do `.env` local (que está no `.gitignore` e **não** foi versionado) imprimiu na saída da sessão a **string de conexão de um MongoDB Atlas real, com usuário e senha**. O banco **não** foi acessado: os testes e o `dev:demo` forçam `MONGODB_URI=''` (banco em memória). Mesmo assim, como a credencial apareceu no log desta sessão, **recomenda-se rotacionar a senha desse usuário do Atlas**.
- Também convém restringir o IP de acesso do Atlas e manter produção separada do ambiente de desenvolvimento.

## Bloqueios / não verificável
- Integração real com Whaply e provedor de assinatura (sem credenciais no ambiente de teste); 9 testes `e2e-whaply-cross` pulados.
- Dados reais de produção (não acessados, por regra da auditoria).
- Backup/restauração, pipeline de deploy, monitoramento, LGPD, acessibilidade e performance sob carga: **fora do que foi possível comprovar**.
- Coexistência com outra pasta de trabalho (`frotaone-hardening`) usando a porta 3333: conflito apenas de ambiente local (ver `05`).
