# Evidence Model — LookaBerry S1/S2

## Objetivo

A S1 adiciona um grafo relacional de entidades e evidências sobre PostgreSQL. O sistema continua usando PostgreSQL/pgvector; não há um graph database separado.

O modelo separa:

- **entidades**: `Company`, `Person`, `Identity`;
- **proveniência**: `Source`;
- **evidência versionável**: `CompanyEvidence`, `PersonEvidence`;
- **eventos observados**: `Observation`, `Interaction`;
- **vínculos**: `Relationship`.

## Proveniência

Toda evidência aponta para um `Source`, que registra:

- `name` e `sourceType`;
- `sourceUrl`, quando aplicável;
- `externalId`, quando o provedor oferece um identificador estável;
- `metadata` sanitizado.

`Source` é compartilhável entre evidências, identidades, observações, relacionamentos e interações.

## Classificação

`EvidenceClassification` possui cinco estados explícitos:

| Classificação | Semântica |
| :--- | :--- |
| `FACT` | Dado observado diretamente na fonte. |
| `INFERENCE` | Inferência determinística derivada de dados observados. |
| `LLM_INFERENCE` | Inferência produzida por um modelo. |
| `USER_PROVIDED` | Informação fornecida diretamente pelo operador/usuário. |
| `UNVERIFIED` | Dado recebido, mas ainda não confirmado. |

O código não promove automaticamente uma inferência a fato.

## Evidência

`CompanyEvidence` e `PersonEvidence` possuem o mesmo contrato:

- `evidenceType` extensível, sem enum fechado;
- `classification` obrigatório;
- `sourceUrl` opcional;
- `observedAt` obrigatório;
- `expiresAt` opcional para TTL;
- `confidence` normalizado entre `0` e `1`;
- `normalizedData` para consumo programático;
- `rawData` opcional, sanitizado antes da persistência;
- `contentHash` SHA-256 para identificar o conteúdo normalizado.

Payloads brutos não devem conter credenciais ou tokens. O serviço redige chaves que contenham `password`, `secret`, `token`, `api_key`, `authorization`, `cookie`, `session_key` ou `credential`, além de limitar profundidade e tamanho de strings.

## Identidades

`Identity` representa identificadores de uma pessoa ou empresa sem acoplar o core a um canal específico. Exemplos de `identityType`:

- `EMAIL`;
- `PHONE`;
- `LINKEDIN_URL`;
- `DOMAIN`;
- `EXTERNAL_PROVIDER_ID`.

`normalizedValue` é usado para deduplicação por tipo. A normalização padrão atual faz trim e lowercase; regras específicas de telefone/domínio podem ser adicionadas nos providers futuros.

## Relações e legado

`Lead` continua compatível com dados existentes e agora pode apontar para `Person` via `personId`. Os campos legados de contato permanecem nesta sprint para evitar migração destrutiva.

`Relationship` registra vínculos como `EMPLOYEE_OF`, com confiança e período opcional. `Observation` permite registrar uma observação de empresa ou pessoa sem confundi-la com evidência consolidada. `Interaction` é o ponto de conexão para eventos de canal e histórico operacional futuros.

## Migration e score legado

A migration `4_sprint1_entity_evidence_graph` converte `leads.total_priority_score` de coluna gerada para coluna comum, alinhando a migration ao `schema.prisma` e ao seed atual. O ranking continua calculado explicitamente em SQL pelo Intent Engine; esta S1 não muda a fórmula de scoring.

A migration ainda não foi aplicada nesta execução porque PostgreSQL não estava disponível no ambiente local. `prisma validate`, `prisma generate`, typecheck e build foram executados com sucesso.

## S2 — Intent signals e providers

`IntentSignal` continua aceitando o contrato legado e agora registra `providerId`, `sourceId`, `companyEvidenceId`, `sourceUrl`, `observedAt`, `expiresAt`, `ttlDays`, `confidence`, `sourceQuality`, `intentWeight`, `cost`, `evidenceClassification`, `normalizedData`, `rawPayload`, `metadata`, `contentHash` e `deduplicationKey`. A relação opcional com `CompanyEvidence` conecta sinais à evidência compartilhada da S1 sem criar uma nova base de dados.

O pipeline `SignalProvider` separa coleta e normalização. Os providers públicos iniciais são mudanças de website, hiring e anúncios públicos; eles trabalham com snapshots, HTML, itens normalizados ou URLs públicas. O provider de funding API retorna `REQUIRES_CREDENTIALS` e não é uma integração real conectada.

A classificação é preservada: observação direta pode ser `FACT`, inferência determinística é `INFERENCE`, resultado de modelo seria `LLM_INFERENCE`, input de operador é `USER_PROVIDED` e dados não confirmados são `UNVERIFIED`. Nenhum provider local promove `LLM_INFERENCE` a `FACT`.

O scoring considera recência/TTL, confiança, qualidade da fonte, tipo, classificação, peso e deduplicação. Sinais expirados/inativos não contribuem. O fallback de embedding determinístico segue documentado como não semântico sem OpenAI.

Consulte [INTENT_PROVIDERS.md](INTENT_PROVIDERS.md) para o contrato, estados operacionais e limitações reais.
