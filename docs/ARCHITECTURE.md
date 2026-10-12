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
- `GET /health/ready` verifica a conexão com PostgreSQL; retorna `200` com `status: ready` quando disponível ou `503` com `status: not_ready` quando indisponível. A resposta não expõe detalhes internos da falha.
- As rotas de health check não exigem autenticação. Mesmo com LocalStack disponível no ambiente local, a aplicação ainda não verifica SQS na readiness; isso será ligado ao adaptador na etapa de integração.

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
- `POST /wagering/transactions` aceita `BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK`. Exige `Idempotency-Key`; `ProcessWagerTransactionUseCase` cria um hash SHA-256 do conteúdo de negócio e envia a operação ao repositório transacional.
- `GET /wagering/transactions/:transactionId` consulta por UUID interno; `GET /providers/:providerId/wagering/transactions/:externalTransactionId` consulta pela identidade externa composta por provedor e identificador. Ambos retornam os dados da operação persistida, `400` para UUID interno inválido e `404` quando a transação não existe.
- `MikroOrmProcessWagerTransactionsRepository` adquire `SELECT ... FOR UPDATE` na carteira e valida jogador/moeda. `BET` debita e grava `DEBIT`; `WIN` e `REFUND` creditam e gravam `CREDIT`; `ROLLBACK` grava o movimento oposto ao lançamento da referência (`BET` resulta em `CREDIT`; `WIN` e `REFUND`, em `DEBIT`). As operações que movem saldo persistem saldo, versão, transação e ledger atomicamente. `LOSS` é processada sem mudar saldo/versão e sem ledger.
- `WIN` pode referenciar uma operação externa. A referência só é aceita se resolver para uma `BET` processada do mesmo provedor, jogador, carteira, moeda e rodada. Referência ausente ou ainda pendente deixa a operação em `PENDING_REFERENCE`, sem crédito, e responde `202`; referência terminal inválida é registrada como `REJECTED` com `INVALID_REFERENCE` e responde `422`. A recuperação posterior dessas pendências permanece para etapa futura.
- `REFUND` exige referência a uma `BET` processada do mesmo provedor, jogador, carteira, moeda e rodada, e o valor deve ser idêntico ao da aposta. Cada aposta pode ser reembolsada uma única vez, protegida por lock da carteira e índice único parcial em `reference_transaction_id`. Referência ausente/pendente resulta em `PENDING_REFERENCE`; referência incompatível, valor diferente ou aposta já reembolsada ficam auditáveis como `REJECTED` com códigos específicos e HTTP `422`. A recuperação posterior de pendências permanece para etapa futura.
- `ROLLBACK` exige referência a uma operação `BET`, `WIN` ou `REFUND` processada do mesmo provedor, jogador, carteira, moeda e rodada, com valor integral igual. Cada referência pode ter um único rollback processado, protegido por lock e índice único parcial. Referência ausente/pendente fica em `PENDING_REFERENCE`; referência inválida, valor divergente, rollback duplicado ou débito inverso que excederia o saldo disponível ficam auditáveis como `REJECTED` com `INVALID_REFERENCE`, `ROLLBACK_AMOUNT_MISMATCH`, `REFERENCE_ALREADY_ROLLED_BACK` ou `ROLLBACK_INSUFFICIENT_FUNDS`, respectivamente. Rejeições não alteram saldo nem ledger. A reexecução automática de operações pendentes permanece para etapa futura.
- Saldo insuficiente em `BET` é persistido como `REJECTED` com `failureCode: INSUFFICIENT_FUNDS`, preserva saldo/versão e não cria ledger. Operação processada retorna `200`; conflito de idempotência ou ID externo retorna `409`, carteira ausente/incompatível `404`, e payload inválido `400`.
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
- Ambas as tabelas guardam payload JSONB, estado, tentativas, data de disponibilidade e código de erro técnico; não devem armazenar stack traces, tokens ou segredos em `last_error_code`.
- Índices parciais facilitam localizar mensagens disponíveis para processamento. Estados e timestamps de conclusão são protegidos por constraints.
- Inbox/Outbox ainda é somente modelo persistente. O adaptador SQS envia, recebe e remove mensagens, mas publisher, consumidores e política/backoff de retries serão implementados nas etapas seguintes. Inserção de outbox só garante publicação futura quando realizada na mesma transação dos dados de negócio; entrega permanece potencialmente duplicada e consumidores devem ser idempotentes.

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
- PostgreSQL usa a imagem `postgres:18-alpine`, volume nomeado persistente e health check com `pg_isready`. A fila `wagering-events` deve ser criada manualmente no LocalStack após o serviço ficar pronto.
- As portas dos serviços são publicadas apenas em `127.0.0.1`. LocalStack usa `4566` por padrão, configurável com `LOCALSTACK_PORT`, e exige `LOCALSTACK_AUTH_TOKEN` local obtido no portal LocalStack. O token não deve ser versionado.
- Para subir apenas o SQS: configurar `LOCALSTACK_AUTH_TOKEN` no `.env` local e executar `docker compose up -d localstack`. Conferir readiness com `docker compose ps localstack`, criar a fila com `docker compose exec localstack awslocal sqs create-queue --queue-name wagering-events` e verificar com `docker compose exec localstack awslocal sqs get-queue-url --queue-name wagering-events`. A criação deve ser repetida se a fila deixar de existir. Para parar: `docker compose stop localstack`.
- `.env.example` documenta `PORT`, as variáveis `POSTGRES_*`, `LOCALSTACK_AUTH_TOKEN`, `LOCALSTACK_PORT`, `LOCALSTACK_ENDPOINT` e a URL opcional do banco dedicado de testes de integração. Credenciais de exemplo destinam-se exclusivamente ao ambiente local.
- `bun run test:sqs:integration` executa um teste contra LocalStack real; ele cria e remove uma fila temporária isolada para testar envio, recebimento e exclusão de mensagem, sem alterar a fila manual `wagering-events`.
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

As tabelas e entidades de Inbox/Outbox já estão definidas, mas ainda não participam do fluxo financeiro. LocalStack, a fila SQS padrão `wagering-events` e o adaptador de mensagens estão disponíveis; integração do fluxo financeiro com Outbox/Inbox, publisher/consumer e recuperação continuam pendentes. Keycloak e OpenTelemetry também permanecem adiados.
