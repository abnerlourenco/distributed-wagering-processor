# Arquitetura

## Objetivo

O projeto é uma aplicação distribuida para processar operações financeiras de apostas.

## Estado atual

A fundação HTTP está baseada em NestJS e TypeScript estrito. O `AppModule` registra o `MikroOrmModule` com uma configuração PostgreSQL centralizada e o módulo `wallets`. O schema é mantido por migrations versionadas e não é sincronizado automaticamente.

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

## Módulo Wallets

- `Wallet` é o aggregate root. Ele abre com saldo inicial não negativo, moeda definida e versão `1`; estado e transições permanecem encapsulados.
- `Wallet.open()` cria um aggregate novo; `Wallet.rehydrate()` reconstrói o estado persistido sem reexecutar regras de transição.
- `OpenWalletUseCase` cria uma carteira por jogador/moeda e depende apenas de `WalletsRepository`. Para saldo inicial positivo, também cria uma `WagerTransaction` interna `OPENING` processada e uma entrada `CREDIT` no ledger; saldo zero não gera esses registros.
- `MikroOrmWalletsRepository` grava carteira, operação `OPENING` e lançamento de ledger em uma única transação PostgreSQL, e converte conflitos da carteira por jogador/moeda em erro de domínio.
- `POST /wallets` recebe `playerId` UUID e `initialBalance` como objeto com `amount` decimal string e moeda ISO de três letras. A resposta expõe valores monetários como strings.
- `GET /wallets/:walletId` valida o UUID e retorna os dados atuais da carteira; retorna `404` quando o identificador válido não existe.
- `GET /wallets/:walletId/ledger` retorna os lançamentos em ordem decrescente de criação e UUID, com paginação keyset. `limit` aceita de 1 a 100 (padrão 50); `cursor` é opaco, estável mesmo com timestamps PostgreSQL em microssegundos e vinculado à carteira. A resposta contém `entries` e `nextCursor` (`null` quando não há outra página); carteira inexistente retorna `404` e cursor ou parâmetros inválidos retornam `400`.
- O aggregate já protege moeda e saldo insuficiente em memória. Endpoints de crédito e débito só serão expostos junto ao ledger e à transação PostgreSQL que confirme alteração de saldo e lançamento de forma atômica.

## Persistência de operações de aposta

- `wager_transactions` armazena uma linha por operação do provedor (`BET`, `WIN`, `LOSS`, `REFUND` ou `ROLLBACK`); `OPENING` é reservado para operações internas.
- A chave de idempotência é única no escopo `(provider_id, idempotency_key)`. A identidade externa da operação também é única por `(provider_id, external_transaction_id)`.
- Cada transação referencia uma carteira existente. Referências a operações são opcionais até resolução, salvo a exigência de `reference_external_transaction_id` para `REFUND` e `ROLLBACK`; a referência interna usa FK para `wager_transactions`.
- Tipo, status, moeda, valor positivo e timestamp de processamento são protegidos por constraints. Valor é `NUMERIC(20,2)` e moeda permanece explícita.
- `SubmitWagerTransactionUseCase` persiste novas operações como `PENDING`; replay da mesma chave e hash retorna o registro original, enquanto conflito de hash ou duplicidade do identificador externo é rejeitado. A constraint única do banco arbitra corridas entre instâncias; o repositório retorna o registro vencedor para que o caso de uso aplique a mesma regra de replay/conflito.
- Nesta etapa, receber/submeter a transação não altera saldo nem grava ledger. Isso será responsabilidade do caso de uso de processamento, com transação PostgreSQL atômica.

## Ledger de carteira

- `WalletLedgerEntry` é um registro imutável associado a uma carteira e a uma `WagerTransaction`; cada operação gera no máximo um lançamento por carteira.
- `DEBIT` e `CREDIT` armazenam valor e saldos anterior/posterior como `NUMERIC(20,2)`. A factory valida moeda, valor positivo, saldo não negativo e igualdade aritmética entre direção, valor e saldos.
- A tabela `wallet_ledger_entries` tem FKs compostas para garantir que carteira, transação e moeda correspondam, além de constraints SQL para direção, saldo e aritmética do lançamento.
- Correções devem ocorrer por novos lançamentos compensatórios, nunca por alteração ou exclusão dos existentes.
- A persistência do ledger ainda não foi conectada ao processamento financeiro. Quando implementado, inserir lançamento, atualizar carteira e marcar a transação como processada deverá ocorrer na mesma transação PostgreSQL.

## Inbox e Outbox

- `inbox_messages` registra mensagens recebidas e deduplica sua entrada no escopo `(consumer_name, source, message_id)`. `payload_hash` permite ao consumidor identificar uma mesma chave recebida com conteúdo diferente.
- `outbox_messages` registra eventos de saída junto aos dados de negócio na mesma transação PostgreSQL. `deduplication_key`, quando informado, evita inserir novamente o mesmo evento lógico.
- Ambas as tabelas guardam payload JSONB, estado, tentativas, data de disponibilidade e código de erro técnico; não devem armazenar stack traces, tokens ou segredos em `last_error_code`.
- Índices parciais facilitam localizar mensagens disponíveis para processamento. Estados e timestamps de conclusão são protegidos por constraints.
- Esta etapa cria somente o modelo persistente. Consumidores, publisher, política/backoff de retries e integração com SQS/LocalStack ficam para uma etapa posterior. Inserção de outbox só garante publicação futura quando realizada na mesma transação dos dados de negócio; entrega permanece potencialmente duplicada e consumidores devem ser idempotentes.

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

- O Docker Compose sobe somente o PostgreSQL nesta fase.
- O serviço usa a imagem `postgres:18-alpine`, volume nomeado persistente e health check com `pg_isready`.
- A porta é publicada apenas em `127.0.0.1`, evitando exposição de rede desnecessária durante o desenvolvimento local.
- `.env.example` documenta `PORT`, `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_PORT`, `POSTGRES_HOST` e a URL opcional do banco dedicado de testes de integração. Credenciais de exemplo destinam-se exclusivamente ao ambiente local.
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

As tabelas e entidades de Inbox/Outbox já estão definidas, mas ainda não participam do fluxo financeiro. A integração do processamento com Inbox/Outbox e a entrega por SQS/LocalStack continuam pendentes até a consolidação da atomicidade financeira e dos testes de concorrência com PostgreSQL real. Keycloak e OpenTelemetry também permanecem adiados.
