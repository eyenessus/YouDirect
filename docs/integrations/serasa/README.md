# Serasa Experian — análise de crédito do motorista

O YuDirect usa a Serasa para uma única finalidade: **analisar o motorista antes de entregar o carro** (e na renovação ou em revisão por atraso). A consulta é paga, e o resultado só apoia a decisão: quem decide é sempre uma pessoa, e a decisão fica registrada com justificativa.

Fontes oficiais usadas (lidas em 10/11/2026):
- Catálogo: `https://developer.serasaexperian.com.br/data/apis.json`
- Manual do Relatório Básico PF: `https://developer.serasaexperian.com.br/data/relatorio-basico-pf/index.md`
- OpenAPI: `https://developer.serasaexperian.com.br/data/relatorio-basico-pf/swagger.yaml`. Cópia neste diretório, `relatorio-basico-pf.swagger.yaml`, que é a referência dos campos usados e do servidor falso dos testes.

## 1. Produtos

| Produto (catálogo) | Para o YuDirect | Situação |
|---|---|---|
| **Relatório Básico PF** (`person-information-report/v1/creditreport`, família Crednet) | Score, PEFIN/REFIN, protestos, cheques sem fundo, cobranças, situação na Receita, documentos roubados | **Implementado, aguardando credenciais.** Testado só com servidor falso no formato do OpenAPI. |
| Relatório Intermediário/Avançado PF | Mais detalhes, mesma família | Basta trocar `SERASA_REPORT_NAME` se o contrato tiver. A normalização usa os mesmos blocos. Não validado. |
| Relatórios PJ, Serasa Recomenda, Monitora/Gerencie, antifraude, biometria | Locação para motorista de app é PF. A biometria já é feita na assinatura do contrato (ZapSign). | **Não implementado** de propósito: não há caso de uso no YuDirect hoje. |

Nenhum produto é considerado contratado só por estar no catálogo. O sistema só descobre se o relatório está liberado na primeira consulta: o código oficial `401/10` vira "Este relatório não está liberado no contrato" e a consulta **não** é contada como cobrada.

## 2. Configuração

Variáveis do servidor (nunca vão para o navegador):

| Variável | Uso |
|---|---|
| `SERASA_ENVIRONMENT` | `homologacao` (padrão; `https://uat-api.serasaexperian.com.br`) ou `producao` (`https://api.serasaexperian.com.br`). |
| `SERASA_CLIENT_ID`, `SERASA_CLIENT_SECRET` | Credencial IAM entregue pela Serasa. O token é pedido com `Authorization: Basic base64(id:secret)`. |
| `SERASA_REPORT_NAME` | Padrão `RELATORIO_BASICO_PF_PME`. Use o nome do relatório do seu contrato. |
| `SERASA_OPTIONAL_FEATURES` | Features contratadas, separadas por vírgula (ex.: `ANOTACOES_COMPLETAS_PME`). |
| `SERASA_SCORE_MODEL` | Modelo enviado em `reportParameters` (ex.: `HRLN`; distribuidor: `HRLD`). Vazio usa o padrão do relatório. |
| `SERASA_RETAILER_DOCUMENT` | Só para cliente distribuidor: CNPJ do consultante (`X-Retailer-Document-Id`). |
| `SERASA_COST_CENTER` | Opcional (`X-Cost-Center`). |
| `SERASA_TIMEOUT_MS` | Padrão 20000. |
| `SERASA_RATE_LIMIT_PER_MINUTE` | Consultas por minuto por cliente na rota (padrão 20). |
| `SERASA_API_URL` | Só para teste ou proxy. Em produção precisa ser HTTPS em `*.serasaexperian.com.br`; senão a integração fica indisponível. |

**Separação de ambientes:** com `SERASA_ENVIRONMENT=producao` fora de `NODE_ENV=production`, a integração se declara indisponível. Uma credencial de produção não roda em máquina de desenvolvimento ou de teste. Cada ambiente tem a sua URL e o seu token, e o token fica só em memória, por processo. Uma consulta feita em homologação nunca é reaproveitada em produção.

Na tela (**Perfil > Análise de crédito**, só para dono ou administrador):
- ligar ou desligar a consulta (vem desligada);
- informar o valor por consulta (usado só nas estimativas) e o limite mensal;
- definir quantos dias uma consulta é reaproveitada (padrão 30) e por quantos dias o conteúdo do relatório fica guardado (padrão 90);
- testar a credencial: só pede o token, não consulta nenhum CPF e não gera cobrança.

**Permissões** (módulo `credit` em Colaboradores, negadas por padrão para colaboradores):
- `read`: vê relatórios, histórico e consumo;
- `request`: faz consulta paga;
- `review`: registra a decisão.

## 3. Como funciona

```
Tela do motorista ─▶ POST /drivers/:id/credit-checks
  1. mesma idempotencyKey? devolve a mesma consulta (clique repetido)
  2. ligada? credencial? CPF cadastrado e válido?
  3. consulta COMPLETED do mesmo CPF, no mesmo ambiente, dentro de reuseDays? reaproveita (sem custo, auditado)
  4. limite mensal (consultas cobráveis ou incertas)
  5. grava PENDING (índice único: uma em andamento por motorista) + auditoria
  6. chama a Serasa (cliente com token em cache e um único login em voo)
  7. grava o desfecho; o relatório normalizado é cifrado (AES-GCM da PII) e ganha prazo de guarda
```

Desfechos:
- **Concluída** (`COMPLETED`): relatório recebido. Cobrada.
- **Sem informação disponível** (`NOT_AVAILABLE`, `403/30`): a tela avisa que isso **não indica ausência de risco**. Cobrança desconhecida.
- **Não realizada** (`FAILED`): a Serasa recusou antes de processar, então **não houve cobrança**. Inclui produto não liberado (`401/10`), credencial recusada, relatório ou feature inexistente (`404/40`), BusinessId (`412/50`), relatório inativo (`412/60`), CPF incorreto (`412/70`), `429`, rede inalcançável e disjuntor aberto.
- **Resultado incerto** (`UNCERTAIN`): tempo esgotado, conexão caída, `5xx` ou resposta fora do formato. **Pode ter sido cobrada, e o sistema nunca repete sozinho.** Antes de uma nova consulta, o operador confere o extrato da Serasa.

**Token:**
- recusado (`401` sem o código 10) → renova uma vez, porque um token recusado não gera cobrança;
- vence em 1 h → renovado 2 min antes.

**Disjuntor:** 3 falhas seguidas pausam as consultas por 2 min.

**Normalização (minimização):** do relatório, guarda-se só o necessário para a locação:
- nome, situação na Receita;
- score (valor, modelo, faixa, probabilidade de inadimplência, mensagem);
- para cada categoria de anotação: quantidade, total, datas e até 50 itens (data, credor, valor, cidade/UF, sub judice);
- alertas de documento roubado e consultas no mês.

Filiação, endereços, telefones e e-mails do relatório **não são guardados**. O score é mostrado com o modelo e a faixa que a Serasa devolveu, sem conversão nem nota inventada.

## 4. LGPD e segurança

- **Base legal registrada:** proteção do crédito (LGPD art. 7º, X). Cada consulta exige finalidade (lista fechada), justificativa escrita, confirmação de que o motorista foi informado e confirmação do custo.
- **CPF:**
  - vai só no cabeçalho `X-Document-Id`, nunca na URL nem nos logs;
  - na consulta fica só o hash com pepper (`documentHash`).
- **Relatório:**
  - guardado cifrado;
  - apagado automaticamente depois de `retentionDays` (rotina periódica), ficando só o registro (quem, quando, finalidade, desfecho, decisão);
  - também apagado ao anonimizar o motorista.
- **Exportação de dados do motorista** (portabilidade): inclui as consultas, as finalidades, o conteúdo ainda guardado e as decisões.
- **Auditoria:**
  - registra `credit.check_requested`, `credit.check_completed`, `credit.check_reused`, `credit.report_viewed`, `credit.check_reviewed`, `credit.settings` e `credit.auth_tested`;
  - nunca registra o CPF.
- **Isolamento:** toda leitura filtra por organização. A Área do Motorista, o site público e as automações de WhatsApp **não têm acesso** a nada disto. Não existe ferramenta para agente de IA consultar a Serasa.
- **Decisão:** sempre humana (aprovado / aprovado com caução maior / pendente de documentos / recusado), com justificativa obrigatória e trilha de alteração. Não há reprovação automática.
- **Credenciais:** só em variáveis de ambiente; nunca em banco, resposta da API ou log.

## 5. Operação

- **Ativar em homologação:**
  1. receba da Serasa o client id e o secret de homologação;
  2. configure as variáveis com `SERASA_ENVIRONMENT=homologacao`;
  3. em Perfil, clique em "Testar credencial";
  4. ligue a consulta;
  5. consulte um CPF da massa de testes autorizada pela Serasa.
- **Ir para produção:** troque para as credenciais de produção, `SERASA_ENVIRONMENT=producao` e `SERASA_REPORT_NAME` do contrato. Confira o valor por consulta e o limite mensal.
- **Produto não contratado:** a consulta aparece como "Não realizada" com a mensagem "não está liberado no contrato".
- **Custos:** a página **Análise de crédito** (menu lateral) mostra, por mês:
  - consultas, cobráveis, não cobradas, incertas, reaproveitadas e custo estimado;
  - totais por usuário.
- **Consultas incertas:** filtre o histórico por "Resultado incerto" e confira cada uma no extrato da Serasa antes de repetir.
- **Duplicidade:** o índice `uniq_driver_pending` garante uma consulta em andamento por motorista, e `uniq_idempotency` cobre o clique repetido.
- **Desativar:** desligue em Perfil (efeito imediato) ou remova `SERASA_CLIENT_ID` e `SERASA_CLIENT_SECRET`.
- **Rotacionar credenciais:** troque as variáveis e reinicie. O token antigo morre com o processo.
- **Rotacionar a chave de PII:** `rotate-pii` também recifra os relatórios guardados. Se o pepper mudar, o hash do CPF muda, e o único efeito é a próxima consulta não ser reaproveitada.
- **Diagnóstico:** os logs da API mostram o desfecho (`credit.check_completed` na auditoria, com HTTP e código oficial), sem CPF.

## 6. Testes

- `apps/api/src/__tests__/serasa-client.test.ts` (27): token (cache, concorrência, expiração, renovação após 401), mapeamento dos códigos oficiais, tempo esgotado, resposta malformada, disjuntor, rede, separação de ambientes, normalização e minimização.
- `apps/api/src/__tests__/credit.test.ts` (20): fluxo completo com Mongo real e Serasa falsa, cobrindo idempotência, reaproveitamento, concorrência, limite mensal, permissões, isolamento entre organizações, Área do Motorista sem acesso, retenção, consulta interrompida, exportação e anonimização LGPD, auditoria sem CPF.
- `packages/contracts/src/__tests__/credit.test.ts` (6) e `apps/web/src/__tests__/credit-ui.test.ts` (5).

## 7. Limitações e pendências

- **Não validado com a Serasa real:** não há credencial de homologação. Os nomes de campo seguem o OpenAPI oficial. O manual descreve o retorno do token como `AccessToken/TokenType/ExpiresIn`, e o cliente aceita qualquer capitalização. Na primeira homologação, confirme:
  - o formato do token;
  - o bloco `score` (o manual mostra `scoreResponse.score`, o OpenAPI mostra `score.score`; os dois são aceitos);
  - o nome exato do relatório do contrato.
- **Cobrança da resposta 403/30:** se a Serasa cobra ou não "informação não disponível" depende do contrato; o sistema marca como "Verificar".
- **Limite mensal:** é contado no banco e pode ser ultrapassado em 1 ou 2 consultas sob concorrência extrema entre motoristas diferentes.
- **Fora do escopo:** CNPJ, monitoramento contínuo e consultas em massa (exigiriam produtos e contratos próprios e não servem à locação para motorista de app).
