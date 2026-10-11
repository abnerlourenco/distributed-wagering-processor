# Arquitetura

## Objetivo

O projeto é uma aplicação distribuida para processar operações financeiras de apostas.

## Estado atual

A fundação HTTP está baseada em NestJS e TypeScript estrito. O `AppModule` registra o `MikroOrmModule` com uma configuração PostgreSQL centralizada e o módulo `wallets`. A primeira migration ainda está pendente de aplicação; schema não é sincronizado automaticamente.

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

- `Wallet` é o aggregate root. Ele abre com saldo `0.00`, moeda definida e versão `1`; estado e transições permanecem encapsulados.
- `Wallet.open()` cria um aggregate novo; `Wallet.rehydrate()` reconstrói o estado persistido sem reexecutar regras de transição.
- `OpenWalletUseCase` cria uma carteira por jogador/moeda e depende apenas de `WalletsRepository`.
- `MikroOrmWalletsRepository` adapta esse contrato ao PostgreSQL e converte violações da constraint de unicidade em erro de domínio.
- `POST /wallets` valida `playerId` UUID e moeda ISO de três letras com Zod. A resposta expõe valores monetários como strings.
- O aggregate já protege moeda e saldo insuficiente em memória. Endpoints de crédito e débito só serão expostos junto ao ledger e à transação PostgreSQL que confirme alteração de saldo e lançamento de forma atômica.

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
- `Money` é um value object de domínio imutável, implementado com `decimal.js`; não possui tabela própria. Valores entram e saem da aplicação como strings decimais com duas casas e são persistidos em colunas `NUMERIC(20,2)`.
- A primeira migration cria a tabela `wallets`. Ela armazena UUIDs de carteira e jogador, a moeda como código ISO 4217 de três letras, o saldo materializado como `NUMERIC(20,2)`, `version` para controle otimista e timestamps de criação e atualização. O banco impede saldo negativo, versão inválida e duplicidade de carteira por par `(player_id, currency)`.
- `wallets.player_id` ainda não possui chave estrangeira porque o módulo/tabela de jogadores não existe. A migration que introduzir jogadores deverá criar a FK sem invalidar dados existentes.

### Ambiente local

- O Docker Compose sobe somente o PostgreSQL nesta fase.
- O serviço usa a imagem `postgres:18-alpine`, volume nomeado persistente e health check com `pg_isready`.
- A porta é publicada apenas em `127.0.0.1`, evitando exposição de rede desnecessária durante o desenvolvimento local.
- `.env.example` documenta `PORT`, `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_PORT` e `POSTGRES_HOST`. Credenciais de exemplo destinam-se exclusivamente ao ambiente local.

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

SQS/LocalStack, inbox/outbox, Keycloak e OpenTelemetry permanecem adiados até a consolidação de carteiras, transações, ledger, idempotência, concorrência e respectivos testes de integração com PostgreSQL real.
