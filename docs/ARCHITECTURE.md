# Arquitetura

## Objetivo

O projeto é uma aplicação distribuida para processar operações financeiras de apostas.

## Estado atual

A fundação HTTP está baseada em NestJS e TypeScript estrito. O `AppModule` registra o `MikroOrmModule` com uma configuração PostgreSQL centralizada e os módulos `wallets`, `wagering` e `health`. O schema é mantido por migrations versionadas e não é sincronizado automaticamente.

A aplicação segue a organização: `src/core` contém conceitos compartilhados, `src/domain` é dividido por contexto, `src/infra` concentra os adaptadores e a composição NestJS, e `./test` contém os testes end-to-end. Testes unitários ficam junto do código testado. Regras financeiras não dependem de NestJS, controllers ou MikroORM.

## Estilo de implementação

O projeto segue os princípios da Clean Architecture e organiza os arquivos pelas seguintes fronteiras:

```text
src/
├── main.ts
├── core/                         # conceitos compartilhados e genéricos
│   └── domain/                   # Money e DomainError
├── domain/                       # contextos de negócio
│   └── wallets/
│       ├── application/          # casos de uso, portas e erros
│       └── enterprise/
│           └── entities/         # aggregate Wallet
└── infra/
    ├── app.module.ts             # composição dos módulos NestJS
    ├── http/
    │   ├── controllers/
    │   └── wallets/
    └── database/
        ├── mikro-orm/            # entidades e repositórios MikroORM
        └── migrations/

test/
└── app.e2e-spec.ts               # testes end-to-end
```

Value objects e abstrações genéricas ficam em `core`; regras específicas, como `Wallet`, ficam em `domain/wallets/enterprise`, enquanto casos de uso e contratos ficam em `domain/wallets/application`. Controllers, módulos NestJS, adaptadores do MikroORM e migrations pertencem a `infra`. Testes unitários ficam co-localizados como `*.spec.ts`; testes e2e ficam em `test/`.

## Health checks

- `GET /health/live` indica que o processo HTTP está ativo e não consulta dependências externas.
- `GET /health/ready` verifica PostgreSQL, a fila de comandos e sua DLQ; retorna `200` com `status: ready` somente quando as três dependências estão disponíveis, ou `503` com `status: not_ready`. A resposta não expõe detalhes internos da falha.
- As rotas de health check não exigem autenticação.

## Módulo Wallets

- `Wallet` é o aggregate root. Ele abre com saldo inicial não negativo, moeda definida e versão `1`; estado e transições permanecem encapsulados.
- `Wallet.open()` cria um aggregate novo; `Wallet.rehydrate()` reconstrói o estado persistido sem reexecutar regras de transição.
- `OpenWalletUseCase` cria uma carteira por jogador/moeda e depende apenas de `WalletsRepository`. Para saldo inicial positivo, também cria uma `WagerTransaction` interna `OPENING` processada e uma entrada `CREDIT` no ledger; saldo zero não gera esses registros.
- `MikroOrmWalletsRepository` grava carteira, operação `OPENING` e lançamento de ledger em uma única transação PostgreSQL, e converte conflitos da carteira por jogador/moeda em erro de domínio.
- `POST /wallets` recebe `playerId` UUID e `initialBalance` como objeto com `amount` decimal string e moeda ISO de três letras. A resposta expõe valores monetários como strings.
- `GET /wallets/:walletId` valida o UUID e retorna os dados atuais da carteira; retorna `404` quando o identificador válido não existe.
- `GET /wallets/:walletId/ledger` retorna os lançamentos em ordem decrescente de criação e UUID, com paginação keyset. `limit` aceita de 1 a 100 (padrão 50); `cursor` é opaco, estável mesmo com timestamps PostgreSQL em microssegundos e vinculado à carteira. A resposta contém `entries` e `nextCursor` (`null` quando não há outra página); carteira inexistente retorna `404` e cursor ou parâmetros inválidos retornam `400`.
- `POST /wallets/:walletId/reconciliation` compara o saldo materializado com a soma de créditos menos débitos no ledger, contando os lançamentos verificados. A comparação é feita em uma única consulta PostgreSQL; divergências são retornadas e registradas em log, nunca corrigidas pela reconciliação. `difference` é `calculatedBalance - storedBalance`; carteira ausente retorna `404`.
- O aggregate protege moeda e saldo insuficiente. O débito externo está exposto somente para `BET` e é confirmado junto da transação e do ledger na mesma transação PostgreSQL.

## Persistência de operações de aposta

- `wager_transactions` armazena uma linha por operação do provedor (`BET`, `WIN`, `LOSS`, `REFUND` ou `ROLLBACK`); `OPENING` é reservado para operações internas.
- A chave de idempotência é única no escopo `(provider_id, idempotency_key)`. A identidade externa da operação também é única por `(provider_id, external_transaction_id)`.
- Cada transação referencia uma carteira existente. Referências a operações são opcionais até resolução, salvo a exigência de `reference_external_transaction_id` para `REFUND` e `ROLLBACK`; a referência interna usa FK para `wager_transactions`.
- Tipo, status, moeda, valor positivo e timestamp de processamento são protegidos por constraints. Valor é `NUMERIC(20,2)` e moeda permanece explícita.
- `SubmitWagerTransactionUseCase` persiste novas operações como `PENDING`; replay da mesma chave e hash retorna o registro original, enquanto conflito de hash ou duplicidade do identificador externo é rejeitado.
- `POST /wagering/transactions` aceita `BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK`, exige `Idempotency-Key` e responde `202 Accepted` após persistir a operação como `PENDING` junto ao comando no Outbox. O corpo contém `transactionId` e status; não há saldo final até o processamento. Conflito de idempotência ou ID externo retorna `409`, carteira ausente/incompatível `404`, e payload inválido `400`.
- `QueueWagerTransactionUseCase` calcula o hash do conteúdo de negócio e, em uma única transação PostgreSQL, valida carteira/jogador/moeda, persiste a operação pendente e grava `WagerTransactionRequested` no Outbox. Uma repetição idêntica retorna a operação original sem criar outro comando.
- `GET /wagering/transactions/:transactionId` consulta por UUID interno; `GET /providers/:providerId/wagering/transactions/:externalTransactionId` consulta pela identidade externa composta por provedor e identificador. Use esses endpoints para acompanhar `PENDING` até o estado final; ambos retornam `400` para UUID interno inválido e `404` quando a transação não existe.
- O publisher envia `WagerTransactionRequested` à fila FIFO `LOCALSTACK_COMMAND_QUEUE_NAME`, agrupada por carteira, no envelope `{ messageId, type, occurredAt, data }`. `data` contém os campos do contrato do desafio e `money: { amount, currency }`; `transactionId` e `createdAt` são metadados internos opcionais para retomar a transação já criada pela entrada HTTP. O consumidor registra primeiro a mensagem no Inbox persistente, executa `ProcessWagerTransactionUseCase` e só remove a mensagem SQS depois do commit PostgreSQL. Uma redelivery com Inbox duplicado ainda executa o caso de uso idempotente; isso permite recuperar queda após gravar Inbox ou após commit financeiro, antes do ack.
- `MikroOrmProcessWagerTransactionsRepository` adquire `SELECT ... FOR UPDATE` na carteira e valida jogador/moeda. `BET` debita e grava `DEBIT`; `WIN` e `REFUND` creditam e gravam `CREDIT`; `ROLLBACK` grava o movimento oposto ao lançamento da referência (`BET` resulta em `CREDIT`; `WIN` e `REFUND`, em `DEBIT`). As operações que movem saldo persistem saldo, versão, transação e ledger atomicamente. `LOSS` é processada sem mudar saldo/versão e sem ledger.
- `WIN` pode referenciar uma operação externa. A referência só é aceita se resolver para uma `BET` processada do mesmo provedor, jogador, carteira, moeda e rodada. Referência ausente ou ainda pendente deixa a operação em `PENDING_REFERENCE`, sem crédito; referência terminal inválida é registrada como `REJECTED` com `INVALID_REFERENCE`.
- `REFUND` exige referência a uma `BET` processada do mesmo provedor, jogador, carteira, moeda e rodada, e o valor deve ser idêntico ao da aposta. Cada aposta pode ser reembolsada uma única vez, protegida por lock da carteira e índice único parcial em `reference_transaction_id`. Referência ausente/pendente resulta em `PENDING_REFERENCE`; referência incompatível, valor diferente ou aposta já reembolsada ficam auditáveis como `REJECTED` com códigos específicos.
- `ROLLBACK` exige referência a uma operação `BET`, `WIN` ou `REFUND` processada do mesmo provedor, jogador, carteira, moeda e rodada, com valor integral igual. Cada referência pode ter um único rollback processado, protegido por lock e índice único parcial. Referência ausente/pendente fica em `PENDING_REFERENCE`; referência inválida, valor divergente, rollback duplicado ou débito inverso que excederia o saldo disponível ficam auditáveis como `REJECTED` com `INVALID_REFERENCE`, `ROLLBACK_AMOUNT_MISMATCH`, `REFERENCE_ALREADY_ROLLED_BACK` ou `ROLLBACK_INSUFFICIENT_FUNDS`, respectivamente. Rejeições não alteram saldo nem ledger.
- O worker agendado busca referências pendentes a cada segundo, com claims PostgreSQL usando `FOR UPDATE SKIP LOCKED`. O limite é de 10 tentativas totais e TTL de 24 horas; entre tentativas o backoff dobra de 1 segundo até o teto de 5 minutos. Esses limites permitem a chegada tardia comum sem manter referências órfãs indefinidamente. Se a referência ainda não existir após o limite/TTL, a transação vira `REJECTED` com `REFERENCE_TRANSACTION_NOT_FOUND` e um evento `WagerTransactionRejected` é gravado no Outbox atomicamente. O worker usa lease de 5 minutos para recuperar claims interrompidos.
- Saldo insuficiente em `BET` é persistido como `REJECTED` com `failureCode: INSUFFICIENT_FUNDS`, preserva saldo/versão e não cria ledger. A API informa a aceitação assíncrona (`202`); o estado final, eventual saldo e `failureCode` são consultados pela rota GET.
- `resulting_balance` guarda o saldo observado ao concluir, rejeitar ou deixar pendente a transação para que replays idempotentes devolvam o resultado original mesmo após operações posteriores na carteira.

## Ledger de carteira

- `WalletLedgerEntry` é um registro imutável associado a uma carteira e a uma `WagerTransaction`; cada operação gera no máximo um lançamento por carteira.
- `DEBIT` e `CREDIT` armazenam valor e saldos anterior/posterior como `NUMERIC(20,2)`. A factory valida moeda, valor positivo, saldo não negativo e igualdade aritmética entre direção, valor e saldos.
- A tabela `wallet_ledger_entries` tem FKs compostas para garantir que carteira, transação e moeda correspondam, além de constraints SQL para direção, saldo e aritmética do lançamento.
- Correções devem ocorrer por novos lançamentos compensatórios, nunca por alteração ou exclusão dos existentes.
- No processamento de `BET`, `WIN`, `REFUND` e `ROLLBACK`, inserir lançamento, atualizar carteira e marcar a transação como processada ocorre na mesma transação PostgreSQL. `LOSS` não altera saldo nem gera lançamento.

## Inbox e Outbox

- `inbox_messages` registra mensagens recebidas e deduplica sua entrada no escopo `(consumer_name, source, message_id)`. `payload_hash` permite ao consumidor identificar uma mesma chave recebida com conteúdo diferente.
- `outbox_messages` registra eventos de saída junto aos dados de negócio na mesma transação PostgreSQL. `deduplication_key`, quando informado, evita inserir novamente o mesmo evento lógico.
- Cada operação de aposta que termina como `PROCESSED` grava um evento `WagerTransactionProcessed` na mesma transação que salva a operação, o saldo e o ledger. O esgotamento do retry de referência grava `WagerTransactionRejected` junto da transição para `REJECTED`; ambos seguem para a fila de eventos pelo Outbox. A deduplicação usa a identidade estável da transação; replays idempotentes retornam sem criar outro evento.
- Ambas as tabelas guardam payload JSONB, estado, tentativas, data de disponibilidade e código de erro técnico; não devem armazenar stack traces, tokens ou segredos em `last_error_code`.
- Índices parciais facilitam localizar mensagens disponíveis para processamento. Estados e timestamps de conclusão são protegidos por constraints.
- O publisher reserva mensagens disponíveis com `FOR UPDATE SKIP LOCKED`, publica envelopes contendo o ID estável da mensagem e marca como `PUBLISHED` somente após confirmação do SQS. Falhas são persistidas como `FAILED` com retry exponencial (até cinco minutos entre tentativas); `OUTBOX_MAX_ATTEMPTS` (padrão 5) limita tentativas. Ao esgotar o limite, a mensagem vai para estado terminal `DEAD`. Se o comando é comprovadamente não enviado, a aposta é marcada `FAILED` com `COMMAND_PUBLISH_ATTEMPTS_EXCEEDED`; se o resultado do envio ao SQS é incerto, a aposta permanece `PENDING`, pois a mensagem pode ter sido aceita. Claims `PROCESSING` abandonados podem ser retomados após cinco minutos. Uma falha após o SQS aceitar a mensagem, mas antes de persistir `PUBLISHED`, pode causar duplicação; consumidores devem deduplicar pelo ID do evento.
- O worker consulta o Outbox a cada segundo, usa `LOCALSTACK_COMMAND_QUEUE_NAME` para comandos e `LOCALSTACK_QUEUE_NAME` para eventos, e registra falhas técnicas sem incluir mensagens de erro potencialmente sensíveis. Mensagens de comando por carteira mantêm ordenação no Outbox. Comando `DEAD` com envio incerto bloqueia os próximos comandos da carteira até reconciliação manual; não há ferramenta automática de replay/reconciliação ainda. Inserção de outbox só garante publicação futura quando realizada na mesma transação dos dados de negócio.
- As filas de entrada devem usar `VisibilityTimeout=60` e política SQS redrive com `maxReceiveCount=5`. Comandos permanentemente inválidos não são confirmados e voltam imediatamente para que o SQS conte as tentativas; erros transitórios recebem backoff exponencial de 1 segundo até 5 minutos. Ambos são encaminhados pelo SQS a `wager-transactions-dlq.fifo` após o limite. Erros de negócio terminais são confirmados, pois não serão resolvidos por retry. Eventos inválidos ou falhas ao gravar no Inbox são encaminhados a `wagering-events-dlq`. A redelivery é pelo menos uma vez, com operação idempotente no PostgreSQL.
- O consumidor ativa hooks para `SIGINT` e `SIGTERM`: interrompe o long-poll e aguarda o ciclo já recebido terminar, incluindo commit e ack. Se a instância cair abruptamente antes disso, o visibility timeout permite redelivery.
- O consumidor da fila `wagering-events` valida o envelope `WagerTransactionProcessed`, grava a mensagem no Inbox com estado `RECEIVED` e só então remove a mensagem SQS. A chave é `(consumer_name, source, message_id)`; payload igual é tratado como entrega duplicada e payload diferente sob o mesmo ID gera conflito sem confirmar a mensagem. Para comandos, o `source` é fixo (`wager-transactions.fifo`), então a unicidade efetiva corresponde a `(consumer_name, message_id)`. O Inbox mantém as mensagens recebidas mesmo quando o processamento falha; redelivery repete o caso de uso, em vez de descartar uma mensagem por já existir no Inbox.

## Observabilidade

- O NestJS usa `StructuredLogger`, que escreve uma linha JSON por log e sempre inclui `correlationId`, `messageId`, `transactionId`, `walletId` e `providerId` (nulos quando não aplicáveis). O middleware aceita um `x-correlation-id` seguro ou cria um UUID, devolve-o no response header e registra método, status e duração sem logar URL, headers ou body. O correlation ID é carregado no comando Outbox/SQS; mensagens sem esse campo usam o ID da mensagem.
- Logs de processamento incluem somente identificadores, etapa e nome da classe de erro. Não registrar payload de aposta, valores monetários, tokens ou detalhes/cause SQL.
- `GET /metrics` expõe Prometheus. `wager_transactions{status}` é um gauge calculado do PostgreSQL; `wagering_duplicates_total`, `wagering_retries_total` e `wagering_lock_conflicts_total` são counters; `wagering_dlq_messages` mede mensagens visíveis, em voo ou atrasadas na DLQ; `wagering_outbox_lag_seconds` mede a idade do comando mais antigo aguardando publicação; `wagering_transaction_processing_duration_seconds` é o histograma de latência. Métricas do processo Node.js também são coletadas. IDs não são usados como labels para evitar alta cardinalidade.
- `/health/live` verifica somente que o processo HTTP responde. `/health/ready` verifica PostgreSQL, fila principal de comandos e DLQ; retorna `503` se alguma dependência obrigatória estiver indisponível.
- Em produção, restringir `/metrics` à rede de monitoramento e exportar logs JSON para o agregador operacional.

## Decisões tomadas

1- Foi realizada a decisão de utilizar o MikroORM para mapeamento do banco de dados postgres.
2- Foi tomada a decisão de utilizar a biblioteca zod para validações de variaveis na aplicação.

### Runtime e aplicação

- Bun 1.x é o runtime e gerenciador de pacotes.
- NestJS é o framework HTTP.
- TypeScript permanece em modo estrito.

### Banco de dados

- PostgreSQL é o banco relacional
- MikroORM é a camada de persistência; os pacotes instalados incluem o driver PostgreSQL, integração NestJS, CLI e suporte a migrations.
- A URL de conexão é construída a partir das variáveis `POSTGRES_*` e entregue ao MikroORM por `clientUrl`.
- A configuração de migrations está centralizada em `src/infra/database/mikro-orm.config.ts`, com saídas compiladas em `dist/infra/database/migrations`.
- Não há sincronização automática de schema. Toda mudança futura de banco deverá ser entregue como migration versionada e reversível quando tecnicamente possível.
- Constraints e índices definidos nas migrations não estão todos espelhados nos metadados das entidades; não executar `schema:update`, pois ele pode propor remover essas proteções. Alterações de schema devem usar migrations revisadas.
- `bun run migration:create -- --name=descricao_curta` compila a aplicação e cria uma migration em branco em `src/infra/database/migrations`; preencher manualmente `up()` e `down()` antes de aplicar. `bun run migration:up` aplica pendências e `bun run migration:down` reverte a última migration, sempre após compilar o projeto.
- `Money` é um value object de domínio imutável, implementado com `decimal.js`; não possui tabela própria. Valores entram e saem da aplicação como strings decimais com duas casas e são persistidos em colunas `NUMERIC(20,2)`.
- A primeira migration cria a tabela `wallets`. Ela armazena UUIDs de carteira e jogador, a moeda como código ISO 4217 de três letras, o saldo materializado como `NUMERIC(20,2)`, `version` para controle otimista e timestamps de criação e atualização. O banco impede saldo negativo, versão inválida e duplicidade de carteira por par `(player_id, currency)`.
- `wallets.player_id` ainda não possui chave estrangeira porque o módulo/tabela de jogadores não existe. A migration que introduzir jogadores deverá criar a FK sem invalidar dados existentes.

### Ambiente local

- O Docker Compose sobe PostgreSQL e LocalStack com somente o serviço SQS habilitado.
- PostgreSQL usa a imagem `postgres:18-alpine`, volume nomeado persistente e health check com `pg_isready`. As filas `wagering-events`, `wagering-events-dlq`, `wager-transactions.fifo` e `wager-transactions-dlq.fifo` devem ser criadas/configuradas manualmente no LocalStack após o serviço ficar pronto.
- As portas dos serviços são publicadas apenas em `127.0.0.1`. LocalStack usa `4566` por padrão, configurável com `LOCALSTACK_PORT`, e exige `LOCALSTACK_AUTH_TOKEN` local obtido no portal LocalStack. O token não deve ser versionado.
- Para subir apenas o SQS: configurar `LOCALSTACK_AUTH_TOKEN` no `.env` local e executar `docker compose up -d localstack`. Conferir readiness com `docker compose ps localstack`. Crie os DLQs antes das filas de origem e configure o redrive; exemplo em PowerShell:

  ```powershell
  $eventDlq = docker compose exec -T localstack awslocal sqs create-queue --queue-name wagering-events-dlq --attributes '{"MessageRetentionPeriod":"1209600"}' | ConvertFrom-Json
  $eventDlqArn = (docker compose exec -T localstack awslocal sqs get-queue-attributes --queue-url $eventDlq.QueueUrl --attribute-names QueueArn | ConvertFrom-Json).Attributes.QueueArn
  $commandDlq = docker compose exec -T localstack awslocal sqs create-queue --queue-name wager-transactions-dlq.fifo --attributes '{"FifoQueue":"true","MessageRetentionPeriod":"1209600"}' | ConvertFrom-Json
  $commandDlqArn = (docker compose exec -T localstack awslocal sqs get-queue-attributes --queue-url $commandDlq.QueueUrl --attribute-names QueueArn | ConvertFrom-Json).Attributes.QueueArn
  $eventQueue = docker compose exec -T localstack awslocal sqs create-queue --queue-name wagering-events | ConvertFrom-Json
  $commandQueue = docker compose exec -T localstack awslocal sqs create-queue --queue-name wager-transactions.fifo --attributes '{"FifoQueue":"true"}' | ConvertFrom-Json
  $eventAttributes = @{ VisibilityTimeout = "60"; RedrivePolicy = (@{ deadLetterTargetArn = $eventDlqArn; maxReceiveCount = "5" } | ConvertTo-Json -Compress) } | ConvertTo-Json -Compress
  $commandAttributes = @{ VisibilityTimeout = "60"; RedrivePolicy = (@{ deadLetterTargetArn = $commandDlqArn; maxReceiveCount = "5" } | ConvertTo-Json -Compress) } | ConvertTo-Json -Compress
  docker compose exec -T localstack awslocal sqs set-queue-attributes --queue-url $eventQueue.QueueUrl --attributes $eventAttributes
  docker compose exec -T localstack awslocal sqs set-queue-attributes --queue-url $commandQueue.QueueUrl --attributes $commandAttributes
  docker compose exec -T localstack awslocal sqs get-queue-attributes --queue-url $eventQueue.QueueUrl --attribute-names RedrivePolicy VisibilityTimeout
  docker compose exec -T localstack awslocal sqs get-queue-attributes --queue-url $commandQueue.QueueUrl --attribute-names RedrivePolicy VisibilityTimeout
  ```

  `create-queue` é idempotente se os atributos imutáveis da fila existente forem os mesmos; `set-queue-attributes` aplica ou atualiza visibility timeout e redrive. Repita o provisionamento se as filas forem removidas. Para parar: `docker compose stop localstack`.

- `.env.example` documenta `PORT`, variáveis `POSTGRES_*`, `LOCALSTACK_AUTH_TOKEN`, `LOCALSTACK_PORT`, `LOCALSTACK_ENDPOINT`, nomes das filas de comando e DLQ, `OUTBOX_MAX_ATTEMPTS` (padrão 5) e a URL opcional do banco dedicado de testes de integração. Credenciais de exemplo destinam-se exclusivamente ao ambiente local.
- Os testes SQS existentes usam LocalStack real. Os testes PostgreSQL/SQS existentes requerem PostgreSQL e LocalStack ativos, além de `POSTGRES_TEST_DATABASE_URL` dedicado terminado em `_test` ou `-test`; não aponte essa variável para o banco de desenvolvimento.
- Os testes de integração PostgreSQL usam `POSTGRES_TEST_DATABASE_URL`, exigem um nome de banco terminado em `_test` ou `-test`, aplicam as migrations e limpam as tabelas desse banco. Nunca apontar essa variável para o banco de desenvolvimento.
- Para executar localmente, criar o banco `wagering_finances_test` para o usuário configurado no PostgreSQL, definir `POSTGRES_TEST_DATABASE_URL` apontando para ele e executar `bun run test:integration`. O comando compila a aplicação, aplica migrations, testa constraints e rollback transacional, e valida down/up de todas as migrations atuais.

## Configuração de ambiente

Foi realizada a validação de variaveis em `src/infra/env.ts` e criação da url de conexão do banco de dados.
A aplicação deve falhar no boot quando as configurações obrigatórias forem ausentes ou inválidas, sem imprimir credenciais.

## Fronteiras futuras

- `src/domain/wallets`: carteira por jogador e moeda, saldo materializado e proteção contra saldo negativo.
- `src/domain/wagering`: operações `BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK`, incluindo transições válidas e referências entre operações.
- `src/core/domain`: objetos de valor compartilhados, especialmente dinheiro decimal exato, e erros de domínio.
- `src/infra/database`: entidades de persistência, migrations e implementações de repositórios.
- `src/infra/http`: DTOs, controllers e tradução de erros de domínio em respostas HTTP.

## Regras que guiarão a persistência financeira

- Valores monetários serão decimais exatos e serão expostos como strings decimais; `number` não será usado para cálculos de dinheiro.
- Uma operação financeira confirmará, em uma única transação PostgreSQL, estado da operação, saldo da carteira, lançamentos do ledger e idempotência.
- Saldo, ledger e idempotência serão protegidos tanto no domínio quanto por constraints e índices do PostgreSQL.
- Operações concorrentes que alterem a mesma carteira usarão transações curtas e locking apropriado.
- Correções financeiras ocorrerão por lançamentos compensatórios; lançamentos confirmados não serão editados nem excluídos.

## Fora de escopo por enquanto

LocalStack, filas de comandos/eventos e seus DLQs, tentativas limitadas no publisher, redrive SQS e reprocessamento agendado de referências estão disponíveis. O consumidor Inbox registra recebimentos duráveis, mas processamento downstream do Inbox continua pendente. Keycloak e OpenTelemetry também permanecem adiados.
