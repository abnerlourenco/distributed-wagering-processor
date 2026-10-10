# Arquitetura

## Objetivo

O projeto é uma aplicação distribuida para processar operações financeiras de apostas.

## Estado atual

A fundação HTTP está baseada em NestJS e TypeScript estrito. O `AppModule` registra o `MikroOrmModule` com uma configuração PostgreSQL centralizada. Ainda não existem entidades, migrations ou regras financeiras; portanto, a descoberta vazia de entidades está explicitamente permitida enquanto a camada de persistência não é implementada.

```text
src/
├── app.module.ts                         # composição da aplicação e integração do MikroORM
├── env.ts                                # leitura e validação das variáveis de ambiente
├── main.ts                               # bootstrap HTTP
└── infra/
    └── database/
        └── mikro-orm.config.ts           # configuração central do PostgreSQL e migrations
```

A estrutura evoluirá para separar domínio, aplicação, infraestrutura e apresentação por módulo. Regras financeiras não deverão depender de NestJS, controllers ou MikroORM.

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

### Ambiente local

- O Docker Compose sobe somente o PostgreSQL nesta fase.
- O serviço usa a imagem `postgres:18-alpine`, volume nomeado persistente e health check com `pg_isready`.
- A porta é publicada apenas em `127.0.0.1`, evitando exposição de rede desnecessária durante o desenvolvimento local.
- `.env.example` documenta `PORT`, `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_PORT` e `POSTGRES_HOST`. Credenciais de exemplo destinam-se exclusivamente ao ambiente local.

## Configuração de ambiente

Foi realizada a validação de variaveis em `src/env.ts` e criação da url de conexão do banco de dados.
A aplicação deve falhar no boot quando as configurações obrigatórias forem ausentes ou inválidas, sem imprimir credenciais.

## Fronteiras futuras

- `modules/wallets`: carteira por jogador e moeda, saldo materializado e proteção contra saldo negativo.
- `modules/wagering`: operações `BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK`, incluindo transições válidas e referências entre operações.
- `shared/domain`: objetos de valor, especialmente dinheiro decimal exato, e erros de domínio compartilhados.
- `infra/database`: entidades de persistência, migrations e implementações de repositórios.
- `presentation`: DTOs, controllers e tradução de erros de domínio em respostas HTTP.

## Regras que guiarão a persistência financeira

- Valores monetários serão decimais exatos e serão expostos como strings decimais; `number` não será usado para cálculos de dinheiro.
- Uma operação financeira confirmará, em uma única transação PostgreSQL, estado da operação, saldo da carteira, lançamentos do ledger e idempotência.
- Saldo, ledger e idempotência serão protegidos tanto no domínio quanto por constraints e índices do PostgreSQL.
- Operações concorrentes que alterem a mesma carteira usarão transações curtas e locking apropriado.
- Correções financeiras ocorrerão por lançamentos compensatórios; lançamentos confirmados não serão editados nem excluídos.

## Fora de escopo por enquanto

SQS/LocalStack, inbox/outbox, Keycloak e OpenTelemetry permanecem adiados até a consolidação de carteiras, transações, ledger, idempotência, concorrência e respectivos testes de integração com PostgreSQL real.
