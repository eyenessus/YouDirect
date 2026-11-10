# 07 — Pendências, bloqueios e decisões de negócio

## Decisões de produto (precisam de resposta antes de alterar comportamento financeiro)
| Id | Dúvida | Opções | Recomendação | Impacto de não decidir |
|---|---|---|---|---|
| PEND-01 | Despesa de **financiamento, IPVA, licenciamento e seguro** deve exigir veículo? Hoje o campo é opcional | (a) obrigatório para essas categorias; (b) obrigatório sempre; (c) manter opcional | (a): categorias "de veículo" exigem veículo; "Outro" continua livre | custo por veículo e ranking subnotificam o que foi lançado sem veículo |
| PEND-02 | **Encerramento da locação**: a `main` já recalcula a conta (períodos **inteiros** até o encerramento, nunca abaixo do pago). Confirmar com o negócio se é a regra desejada | (A) como está (período corrente inteiro); (B) pró-rata; (C) ajuste manual auditado | manter (A) se o contrato cobra por período fechado | só confirmação; sem mudança obrigatória |
| PEND-03 | **Rollout da trava de produção** (R-01 já corrigido na `main`): o app **recusa subir** em produção sem `SESSION_SECRET` (32+), `COOKIE_SECURE=true`, `MONGODB_URI`, `APP_URL`/`API_PUBLIC_URL`/`CORS_ORIGINS` públicos | definir todas as variáveis no deploy **antes** de publicar | confirmar no ambiente de deploy | se faltar alguma, o deploy não sobe (falha segura, mas é indisponibilidade) |
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
