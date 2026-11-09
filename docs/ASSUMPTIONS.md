# ASSUMPTIONS — decisões, inferências e pendências

Este documento registra **tudo o que não está provado pelas referências**.
Nada aqui deve ser lido como comportamento confirmado do produto original.

Classificação usada em todo o repositório:

| Marca | Significado |
|---|---|
| **[O]** | Observado diretamente nas capturas ou no PDF de manutenções |
| **[I]** | Inferido a partir do conjunto das telas, sem prova direta |
| **[R]** | Recomendação de engenharia necessária para o sistema funcionar |
| **[P]** | Pendente de validação de negócio ou de integração externa |

---

## 1. Interface

### A-UI-01 — Telas de acesso não existem nas referências **[R]**
Login, aceite de convite e recuperação de acesso **não aparecem em nenhuma das
93 páginas**. Foram construídas com os mesmos tokens visuais (sidebar azul,
tipografia, botões), mas **não têm equivalente para comparação**. Arquivos:
`apps/web/src/features/auth/LoginPage.vue`, `AcceptInvitePage.vue`.

### A-UI-02 — Formulário público de vistoria **[I/R]**
A referência mostra que um link é enviado ao responsável (pág. 59), mas **não
mostra a tela que o motorista abre**. Implementamos um formulário mobile-first
protegido por token de uso único com validade de 7 dias
(`PublicInspectionPage.vue`). O visual é derivado do design system — não é uma
reprodução.

### A-UI-03 — Diálogo de quitação **[P]**
A referência exibe apenas o item de menu `Pagar` (pág. 93). O modal de
recebimento/pagamento (`RegisterPaymentModal.vue`) é proposta: valor (padrão =
saldo pendente), data, método, conta bancária e confirmação. Aceita pagamento
parcial e envia `Idempotency-Key`.

### A-UI-04 — Detalhe e edição de OS **[P]**
Não há captura do detalhe completo nem do fluxo de edição/cancelamento de uma
ordem de serviço. Implementamos um modal de detalhe e as ações
`Cancelar OS` / `Excluir`, com estorno do lançamento bancário.

### A-UI-05 — Responsividade **[R]**
Não existe captura mobile ou tablet. O desktop (~1917 px) é a referência
primária. Abaixo de 1024 px a sidebar vira drawer, grids colapsam para uma
coluna e tabelas ganham rolagem horizontal — **sem remover colunas ou ações**.

### A-UI-06 — Tipografia **[P]**
A família tipográfica original **não é recuperável** de um PDF rasterizado.
A interface usa **Inter** (auto-hospedada) com fallback Roboto. O PDF usa
**Roboto**, isso sim confirmado: o golden master embute
`BZZZZZ+Roboto-Medium` e `CZZZZZ+Roboto-Regular`.

### A-UI-07 — Cores **[P]**
Os valores em `apps/web/src/styles/tokens.css` são **amostras visuais**, não o
CSS original. Estão centralizados como variáveis para permitir recalibração.

### A-UI-08 — "Vistorias" como aba de notificações **[I]**
A referência mostra as abas `Todas / Manutenção / CNH / Locações` (pág. 24).
Como o sistema também gera alertas de vistoria, a aba `Vistorias` foi
acrescentada. É um acréscimo, não uma observação.

### A-UI-09 — Valores da rosca de despesas **[R]**
A referência exibe valores compactos na legenda (`R$ 1,7k`). Exibimos o valor
completo (`R$ 1.720,45`) por ser mais preciso; nenhuma informação foi removida.

---

## 2. Domínio e nomenclatura

### A-ENUM-01 — `RENTED` × `Locado` **[O/R]**
O detalhe do veículo (pág. 37) mostra `RENTED` enquanto a listagem (pág. 34) e
o PDF mostram `Locado`. Tratamos como **o mesmo estado**: o código persistido é
`RENTED` e a interface exibe sempre `Locado`
(`packages/contracts/src/enums.ts`). Não criamos três estados distintos.

### A-ENUM-02 — "Cliente" × "Motorista" **[P]**
A tela `Nova Locação` traz o atalho `+ Novo Cliente` (pág. 72) e existe um
`Relatório por Cliente` (pág. 8), mas **não há CRUD de cliente autônomo** em
nenhuma captura. Tratamos cliente = motorista/locatário: o botão leva ao
cadastro de motorista. Nenhum módulo novo foi inventado.

### A-ENUM-03 — Opções dos selects **[O]**
`Tipo de Locação` expõe apenas `Mensal` e `Semanal`; `Período de Vistoria`,
apenas `Semanal (a cada 7 dias)` e `Mensal (a cada 30 dias)` — exatamente as
opções visíveis. O texto de ajuda menciona "diária", mas como a opção não
aparece no select, ela **não** foi criada.

### A-OS-01 — Cronologia inconsistente no golden master **[O/P]**
No PDF de referência a OS `WO-2026-0013` tem **abertura (13/10/2026) posterior
à execução (12/10/2026)**. O dado histórico é **preservado como está** (fixture
e seed). Para **novas** OS, a abertura é a data de cadastro e a execução é
informada pelo usuário; não há bloqueio retroativo. Uma validação de
cronologia para registros novos permanece pendente de decisão de negócio.

---

## 3. Regras financeiras

### A-FIN-01 — Metodologia (gerencial) **[O]**
A nota de rodapé da DRE é explícita: *"DRE gerencial com base em pagamentos
recebidos e contas a pagar quitadas no mês"*. Adotamos essa metodologia em
todos os relatórios:

```
receita  = pagamentos de contas a receber liquidados no período
despesa  = contas a pagar quitadas + manutenções concluídas no período
lucro    = receita − despesa
margem   = lucro / receita     (null quando receita = 0)
```

O **caução não é receita** (entra no caixa como `RENTAL_DEPOSIT`).

### A-FIN-02 — Uma conta a receber por contrato **[R]**
A tela `Contas a Receber` mostra **uma linha por contrato**, com `Valor Total` e
`Valor Pendente` — não uma linha por parcela. Modelamos um recebível por
contrato (`expectedPeriod: 'CONTRACT'`), cujo valor esperado é
`valor do período × número de períodos` e cujo vencimento é o fim do primeiro
período. O gatilho exato usado no produto original **não é observável**.

### A-FIN-03 — Manutenção como despesa **[I]**
A referência não prova se o custo de manutenção entra no total de despesas do
período (em novembro/2026 não houve OS concluída). Como o débito bancário
ocorre na conclusão — texto confirmado na pág. 52 — contabilizamos a OS
concluída como despesa do período, sob a categoria `Manutenção`.

### A-FIN-04 — Classificação das linhas da DRE **[R]**
Todas as categorias de despesa caem em **Custos da frota**. As linhas
`Despesas com pessoal / administrativas / comerciais / outras operacionais /
financeiras` e `Provisão para IRPJ e CSLL` ficam em zero, exatamente como na
referência. Nenhum imposto fictício é introduzido.

### A-FIN-05 — Exclusão nunca apaga extrato **[R]**
Excluir uma conta já paga, uma OS lançada ou uma conta bancária com
movimentação gera **estorno/arquivamento**, nunca remoção de lançamentos.

---

## 4. Dados de demonstração (seed)

### A-SEED-01 — Saldo de abertura da conta **[R]**
A referência mostra `Saldo inicial 0` com data `03/09/2026` (pág. 84) e, ao
mesmo tempo, saldo inicial do período de novembro de `R$ 7.802,58` (pág. 85).
Os dois só fecham com movimentações anteriores que **não estão nas capturas**.
O seed usa `saldo inicial = R$ 3.938,56` em `03/09/2026` para que o extrato de
novembro inicie **exatamente** em `R$ 7.802,58`. É o único número do seed que
diverge de uma tela da referência, e é deliberado.

### A-SEED-02 — Dados pessoais fictícios **[R/LGPD]**
Nomes, CPF, RG, telefones e e-mails das capturas **não foram reutilizados**.
O seed cria seis motoristas fictícios com CPF válido. Placas, valores e os
números das OS são mantidos porque são dados de **veículo/financeiros**, usados
como caso de aceitação (`docs/VISUAL-VERIFICATION.md`).

### A-SEED-03 — Fotos **[P]**
As fotos de veículos e de vistorias das capturas são imagens rasterizadas de
veículos reais (com placas visíveis). **Não foram extraídas nem incorporadas.**
A interface exibe um placeholder quando não há foto.

### A-SEED-04 — Logotipo **[O]**
O logotipo FrotaOne usado na interface e nos PDFs foi extraído do **próprio PDF
de relatório fornecido pelo proprietário** (objeto de imagem embutido). Não é
uma marca de terceiros nem uma recriação.

---

## 5. Integrações externas

Nenhuma integração é simulada. Sem credenciais, cada adapter devolve
`available: false` com mensagem explícita, e a interface informa isso ao
usuário.

| Integração | Situação | Comportamento sem credencial |
|---|---|---|
| **WhatsApp** (disparo, vistoria) **[P]** | Provedor não identificado na referência | `UNAVAILABLE` + link `wa.me` por destinatário para envio manual |
| **E-mail** (convites, fallback) **[P]** | Não identificado | Convite criado; link exibido para entrega manual |
| **CEP** **[P]** | Não identificado | Botão `Buscar` informa indisponibilidade; endereço editável |
| **Multas / DETRAN** **[P]** | Não há prova de consulta real | Modal informa indisponibilidade; **nunca** exibe multa inventada |
| **Cobrança (Asaas)** **[P]** | A tela cita "link oficial do Asaas" | Botão desabilitado; `GET /subscription/invoices/:id/link` responde 409 explicando |
| **Push do navegador** **[R]** | Observado só o botão `Desativar` | Usa a Notification API real; sem permissão, informa e não ativa |

---

## 6. Infraestrutura e segurança

### A-INFRA-01 — MongoDB em memória em dev **[R]**
Sem `MONGODB_URI`, a API sobe um `mongodb-memory-server` com replica set
(transações habilitadas). Em produção a URI é obrigatória. O diretório de dados
é configurável (`MONGO_MEMORY_DB_PATH`) para não depender do temp do sistema.

### A-SEC-01 — Hash de senha **[R]**
O prompt pede Argon2id. O binding nativo nem sempre está disponível no ambiente
alvo, então usamos **scrypt** (RFC 7914, nativo do Node, memory-hard) com
N=32768, r=8, p=2 e formato versionado (`scrypt$N$r$p$salt$hash`), que permite
migrar para argon2id sem invalidar hashes existentes.

### A-SEC-02 — PII em repouso **[R]**
CPF e RG são cifrados com AES-256-GCM. A duplicidade de CPF é detectada por um
hash determinístico (`cpfLookupHash`), que também serve à busca exata. Logs
redigem cookies, senhas e documentos.

### A-SEC-03 — Arquivos **[R]**
Nenhum arquivo é servido por URL pública adivinhável: o acesso usa URL assinada
(HMAC) de curta duração, emitida apenas após checagem de sessão + organização.
O `Content-Type` do browser nunca é confiado — há verificação por assinatura
de bytes (magic number).

---

## 7. O que permanece bloqueado para produção

1. Envio real de WhatsApp e e-mail (credenciais de provedor).
2. Consulta real de multas (contrato com provedor/DETRAN).
3. Cobrança e segunda via de fatura (conta no provedor de pagamentos).
4. Push do navegador em produção (requer HTTPS e chaves VAPID se for usar
   Web Push via service worker — hoje usamos apenas a Notification API local).
5. Preços, cotas e regras de plano: os valores das capturas são um **snapshot**
   e estão configuráveis por organização, não embutidos como tarifa universal.

---

## 7. Achados de medição das referências

### A-REF-01 — Escala das capturas **[O]**
As 93 páginas de referência têm 1917 px de largura, mas o conteúdo aparece
~1,2× maior do que em um viewport de 1917 px CSS: foram feitas em um navegador
de ~1598 px CSS com zoom de 120%, incluindo 48 px de moldura do navegador.
Toda a calibração de layout (`docs/VISUAL-VERIFICATION.md` §4) usa essa
conversão. Sem ela, qualquer comparação de tamanho leva a conclusões erradas.

### A-REF-02 — Veículo arquivado na referência **[O/R]**
A lista de veículos da referência traz 7 linhas, mas o painel conta **6**. A
sétima tem a placa gravada como `FQT3I57__ARQ__<hash>` — ou seja, o produto
original renomeia a placa ao arquivar, para liberar o índice único.

Aqui o arquivamento usa `archivedAt` + índice único **parcial**
(`partialFilterExpression: { archivedAt: null }`), o que mantém a placa legível
e dispensa mutilar o dado. Consequência visível: o veículo arquivado **não**
aparece na consulta (a referência o exibe com a placa mutilada), e o painel
conta 6 nos dois casos. O seed reproduz esse estado arquivando o VOYAGE
`FQT3I57`.

### A-REF-03 — Alinhamento das colunas **[O]**
Todas as colunas das tabelas da interface são alinhadas à **esquerda**,
inclusive as monetárias e a de ações (medido nas págs. 001, 008 e 091). No PDF
de manutenções, ao contrário, `KM` e `Total` são alinhados à direita. São
artefatos distintos e cada um segue a sua própria referência.

### A-REF-04 — Variação percentual: dois formatos **[O]**
Os cards do painel escrevem a variação como inteiro, em cinza `#6B7280`, sem
ícone (`+0%`, `-64%` — pág. 014). Os cards do dashboard financeiro usam pílula
colorida com uma casa decimal (`−64,3%`, `+26,9 pp` — pág. 080). Variação nula
aparece como `+0%`, e não `0%`.

### A-REF-05 — Faixa de filtros e tabela no mesmo cartão **[O]**
Nas listagens, busca, filtros e tabela ficam em **um único cartão**, com a
tabela dentro do respiro de 24 px (as divisórias de linha começam em
x ≈ 160 px contra um cartão que vai de 131 px a 1878 px). Não há divisória
horizontal entre a faixa de título e o cartão.
