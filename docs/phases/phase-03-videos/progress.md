# phase-03-videos — Progress

**Status:** completed
**SIs:** 12/12 completed

### SI-03.1 — Infra: serviços de storage e fila no Compose + configuração namespaced
- **Status:** completed
- **Tests:** 16 passing
- **Observations:**
  - Nenhuma TD fixou nomes exatos de env vars nem valores de TTL/limite — escolhidos: `QUEUE_HOST`/`QUEUE_PORT`; `STORAGE_ENDPOINT`, `STORAGE_REGION`, `STORAGE_ACCESS_KEY_ID`/`STORAGE_SECRET_ACCESS_KEY` (obrigatórios, sem default, espelhando `DB_USERNAME`/`DB_PASSWORD`), `STORAGE_VIDEOS_BUCKET`/`STORAGE_THUMBNAILS_BUCKET`, três TTLs de presigned URL separados (upload/stream/download — necessário porque SI-03.12 exige TTL de download independente do de streaming), `STORAGE_UPLOAD_ABANDONED_TTL_SECONDS`, `UPLOAD_MAX_FILE_SIZE_BYTES`, `UPLOAD_ACCEPTED_MIME_TYPES`, `STORAGE_MULTIPART_PART_SIZE_BYTES`.
  - Tag do `minio/mc` para o serviço `storage-init` não estava nas TDs (só a tag do `minio/minio` foi pinada); verificado via Docker Hub API e pinada em `RELEASE.2025-08-13T08-35-41Z` (última publicada antes do arquivamento do repositório).
  - `nestjs-project/Dockerfile` é um arquivo novo (só existia `Dockerfile.dev`); criado com um único estágio `worker` por enquanto — a API continua usando `Dockerfile.dev`.
  - `video-worker` sobe apenas ocioso (`tail -f /dev/null`), igual ao padrão atual do `nestjs-api`; o `command`/script real (`start:worker`) é responsabilidade da SI-03.9 por definição do próprio plano.

### SI-03.2 — Infra: isolamento de testes para storage e fila
- **Status:** completed
- **Tests:** no tests (infra; validado manualmente contra a fila e o storage reais do Compose — ver observações)
- **Observations:**
  - O projeto não tem `test/support/`; o padrão real de helpers de infra vive em `src/test/` sem sufixo `.helper.ts` (`mailpit.ts`, `create-test-data-source.ts`). Como a própria Description da SI pede para "seguir o padrão já usado para banco e Mailpit", criei `src/test/queue.ts` e `src/test/storage.ts` (em vez de `test/support/queue-test.helper.ts`/`storage-test.helper.ts` como escrito literalmente nas Technical actions) para manter fidelidade ao padrão existente.
  - TD-13 (Opção A) fala em "bucket names dedicados" e "test queue prefix", mas o projeto usa um único `.env` compartilhado por dev e teste (sem `.env.test`, sem branch por `NODE_ENV`) e o nome da fila `video-processing` já sai fixo no código da SI-03.4 — não há como a app-sob-teste realmente publicar em uma fila/bucket com nome diferente do de dev sem tocar o `QueueModule`/`StorageService` (fora do escopo desta SI). Interpretação adotada, alinhada à própria Action 1/2 (que já citam a fila `video-processing` e um "prefixo de teste" dentro dos buckets existentes): mesma fila e mesmos buckets de dev, isolamento via (a) `Queue#obliterate({ force: true })` na fila inteira e (b) um prefixo de chave dedicado (`STORAGE_TEST_KEY_PREFIX`, default `test/`) dentro dos buckets de vídeos/thumbnails, limpo via list+delete. Sinalizando para o usuário revisar se a intenção original de TD-13 era mais forte (bucket/queue realmente separados).
  - `bullmq` precisa de `ioredis` (peer dependency, não instalada em nenhuma TD/library-refs.md) para conectar ao Valkey — instalada sem pin de versão (`npm install ioredis`, satisfaz `>=5.0.0` exigido pelo bullmq) por não ser uma decisão técnica documentada, apenas uma dependência transitiva obrigatória.
  - Validação manual (fora de arquivo de teste, por a SI não ter Tests section): enfileirei um job fake e escrevi um objeto fake sob o prefixo de teste, chamei os dois helpers e confirmei zero jobs/objetos residuais depois — reproduz as Acceptance criteria da SI contra a infra real do Compose.

### SI-03.3 — Entidade `Video` e migration
- **Status:** completed
- **Tests:** 31 passing
- **Observations:**
  - `status` foi tipado como union `'draft' | 'processing' | 'ready' | 'failed'` na entity (não `enum` do Postgres) porque o Data Model declara o tipo de coluna como `varchar`, não `enum`.
  - `generateVideoPublicId()` usa `randomBytes(8).toString('base64url')` — 8 bytes produzem exatamente 11 caracteres base64url (padding removido), batendo com "11-char base64url" da TD-08 (a TD fala em "66 bits"; 8 bytes são 64 bits, a diferença é arredondamento da própria TD, não ajustada aqui).
  - `.claude/rules/nestjs-entities.md` exige relações sempre bidirecionais; adicionei `@OneToMany(() => Video, ...) videos: Video[]` em `channel.entity.ts` (fora das Technical actions literais desta SI, mas decorrente direto da regra do projeto para a relação `Video → Channel` que a própria SI introduz).
  - `cleanAllTables()` (`src/test/create-test-data-source.ts`) ganhou `DELETE FROM "videos"` antes de `"channels"` (FK). Como o padrão do projeto repete o mesmo `ALL_ENTITIES` completo em todo integration-spec, também adicionei `Video` ao `ALL_ENTITIES` dos 4 specs existentes (`user`, `channel`, `refresh-token`, `verification-token`) para que cada um sincronize a tabela `videos` e o `DELETE` compartilhado não quebre por tabela inexistente. Sem isso, o helper compartilhado ficaria inconsistente com a nova FK.
  - Migration gerada via `docker compose exec nestjs-api npm run migration:generate -- src/database/migrations/CreateVideos` (CLI, conforme regra do projeto) e formatada com `prettier --write` para bater com o estilo (2 espaços, aspas simples) das migrations existentes, que estavam em estilo diferente por padrão do gerador.

### SI-03.4 — `QueueModule`: fila `video-processing`
- **Status:** completed
- **Tests:** 2 passing
- **Observations:**
  - Nem a TD-01 nem a TD-11 fixam o valor de `delay` do backoff exponencial (só o tipo e o número de tentativas); usado `1000` (ms), o mesmo valor do exemplo em `library-refs.md`.
  - `@nestjs/bullmq` estava listado em `library-refs.md` mas ausente do `package.json` (só `bullmq` já tinha sido instalado na SI-03.2); instalado agora na versão pinada `^12.0.0`.
  - `@nestjs/bullmq` e sua dependência `@nestjs/bull-shared` são publicados como ESM puro (`"type": "module"`), o que o Jest não transforma por padrão (`transformIgnorePatterns` exclui `node_modules` inteiro). Corrigido adicionando `transformIgnorePatterns` tanto no jest config do `package.json` quanto em `test/jest-e2e.json` (mesma causa raiz afetaria os testes e2e de SIs futuras que dependem da fila) para permitir a transformação desses dois pacotes.
  - Criado `src/queue/queue.constants.ts` com `VIDEO_PROCESSING_QUEUE` (fora das Technical actions literais, mas decorrente da convenção do projeto de não duplicar string literals — `src/test/queue.ts`, criado na SI-03.2, mantém sua própria constante local inline; não foi alterado por estar fora do escopo desta SI).

### SI-03.5 — `StorageService`: cliente S3 (multipart + presigned URLs)
- **Status:** completed
- **Tests:** 9 passing
- **Observations:**
  - Instalado `@aws-sdk/s3-request-presigner@^3.1127.0` (fixado em `library-refs.md`, ausente do `package.json`; só `@aws-sdk/client-s3` já estava instalado).
  - `presignUploadParts`/`presignGetObject` usam `getSignedUrl`, que assina localmente (SigV4) sem round-trip de rede — por isso o teste unitário (`storage.service.spec.ts`) exercita a lib real (S3Client + getSignedUrl) sem depender do storage do Compose, enquanto `createMultipartUpload`/`completeMultipartUpload`/`abortMultipartUpload` (que fazem `s3.send`, round-trip real) só têm cobertura no integration-spec.
  - `src/test/storage.ts` tinha `createTestS3Client` como função privada; exportada (sem mudar seu comportamento) para reuso pelo integration-spec, que precisa de um client S3 independente do `StorageService` sob teste para verificar via `HeadObjectCommand` que o objeto foi realmente gravado. Fora das Technical actions literais desta SI, mas evita duplicar a construção do client em vez de reaproveitar o helper já criado na SI-03.2.
  - `StorageModule` não importa `ConfigModule.forFeature` porque `storageConfig` já é carregado globalmente em `app.module.ts` (`ConfigModule.forRoot({ isGlobal: true, load: [...] })` da SI-03.1); `@Inject(storageConfig.KEY)` funciona diretamente. `StorageModule` não foi registrado em `app.module.ts` — segue o mesmo padrão do `QueueModule` (SI-03.4), que também ainda não está registrado lá; a Description desta SI diz que o serviço é "reusado pelo upload, streaming e download", ou seja, quem vai importar `StorageModule` são os módulos das SIs futuras (03.6, 03.9, 03.11, 03.12), não esta SI.

### SI-03.6 — Endpoint POST /videos (iniciar upload)
- **Status:** completed
- **Tests:** 4 passing
- **Observations:**
  - `ChannelsService.findByUserId(userId)` foi adicionado sem teste próprio (dedicado): a Tests table desta SI só lista `VideosService.initiateUpload`; a cobertura real do lookup vem do integration-spec de `VideosService`, que exercita o caminho completo via canal real no banco.
  - `original_key` segue o padrão `{id}/{filename}` (Data Model TD-05), com `id` gerado via `randomUUID()` antes do `save` (TypeORM aceita PK explícita em `PrimaryGeneratedColumn('uuid')` em vez de gerar uma nova).
  - `integration-spec` usa um `StorageService` fake (mock com `resolveBucket`/`createMultipartUpload`/`presignUploadParts`) em vez do storage real do Compose — o contrato de storage já tem cobertura própria na SI-03.5; este teste isola o contrato de persistência (`Video` em `draft`, `channel_id` correto), evitando side effects reais no MinIO sem precisar de prefixo de chave de teste (que não se aplicaria à chave `{id}/{filename}` de qualquer forma).
  - Ausência de canal para o usuário autenticado (`channelsService.findByUserId` retornando `null`) lança um `Error` genérico (não mapeado no Error Catalog) — é um invariante quebrado (todo usuário ganha canal automático no registro), não um fluxo de erro documentado da API.

### SI-03.7 — Endpoint POST /videos/:id/complete-upload
- **Status:** completed
- **Tests:** 15 passing (8 unit + 3 integration + 4 e2e)
- **Observations:**
  - Fila injetada em `VideosService` via `@InjectQueue(VIDEO_PROCESSING_QUEUE)` do `@nestjs/bullmq`; `VideosModule` passou a importar `QueueModule` (antes só `ChannelsModule` + `StorageModule`). Isso muda a assinatura posicional do construtor de `VideosService` (agora `repo, channelsService, storageService, queue, config`), exigindo atualizar as duas instanciações manuais (`new VideosService(...)`) em `videos.service.spec.ts` e `videos.service.integration-spec.ts` (SI-03.6) para inserir o mock/instância da fila na 4ª posição.
  - A transição de status é uma dupla guarda: (1) checagem explícita `status !== 'draft'` antes de tocar o storage (cobre a chamada duplicada sequencial do AC #3 sem re-chamar `completeMultipartUpload` numa multipart upload já fechada) e (2) `update({id, status: 'draft'}, {...})` com `affected === 0` como guarda real contra corrida concorrente — nenhuma TD detalhava esse desenho de duas camadas, only "update guardado e idempotente".
  - `upload_id` é zerado (`null`) na conclusão, conforme a nota do Data Model ("limpo após a conclusão") — não estava explícito nas Technical actions da SI, mas é a única leitura consistente da coluna.
  - Spec-derived E2E (`nestjs-project/specs/videos-complete-upload.plan.md`, PLAN_MODE=modern): criei `test/videos.e2e-spec.ts` do zero. Esse arquivo também é o `target_file:` do spec da SI-03.6 (`videos.plan.md`, cenário "1. POST /videos"), mas a SI-03.6 rodou antes de os Test Specs existirem (mtimes dos 4 specs são ~19–51s mais novos que o plano, ou seja, `/plan-test-specs` só rodou depois que SI-03.1–03.6 já estavam implementadas) e não criou esse arquivo. Não fiz backfill do cenário 1 (fora do escopo desta SI) — ao fim da SI-03.7 o arquivo continha só o `describe`/testes do cenário 2 (complete-upload). SI-03.6 ficou sem cobertura E2E. **Lacuna fechada no fechamento da fase** (ver "Fechamento da fase" ao final deste documento).
  - E2E exercita storage e fila reais do Compose (sem mocks): `POST /videos` abre um multipart upload real no MinIO, o teste faz um `PUT` real na URL pré-assinada pra obter um ETag real, e a fila é inspecionada via `Queue.getJobCounts()` obtido do próprio `AppModule` (`moduleFixture.get(getQueueToken(VIDEO_PROCESSING_QUEUE))`) — sem precisar instanciar uma conexão `Queue` paralela. Isso deixa objetos residuais pequenos no bucket de vídeos do MinIO (as chaves não usam o prefixo de teste `STORAGE_TEST_KEY_PREFIX` da SI-03.2, que só cobre os helpers `src/test/storage.ts`); inofensivo mas fora do mecanismo de limpeza existente.

### SI-03.8 — Sweep de uploads abandonados
- **Status:** completed
- **Tests:** 7 passing (4 unit + 3 integration)
- **Observations:**
  - `library-refs.md` (`@nestjs/bullmq`) é explícito: "usar no módulo da API para registrar a fila, e no worker (contexto Nest standalone) para o processor". Como SI-03.8 não depende de SI-03.9 (bootstrap do worker ainda não existe) e `VideosModule` é importado pelo `AppModule` da API, registrar `AbandonedUploadSweepProcessor` (que estende `WorkerHost`) como provider de `VideosModule` ativaria um consumer BullMQ dentro do próprio processo da API — contrariando o objetivo da fase de isolar o processamento no video-worker. Por isso o processor foi criado como classe solta (não registrada em nenhum `@Module` ainda) e só a Action 3 (registro do job repetível, que é só produtor) foi implementada como provider real (`AbandonedUploadSweepScheduler`) em `VideosModule`. A ligação do processor ao processo do worker ficou pendente ao fim da SI-03.8 — nem SI-03.9 nem SI-03.10 mencionam esse wiring explicitamente nas Technical actions. **Lacuna fechada no fechamento da fase** (ver "Fechamento da fase" ao final deste documento).
  - Fila dedicada `sweep-abandoned-uploads` (mesmo nome do evento) criada em `QueueModule` via `BullModule.registerQueue`, sem `defaultJobOptions` (semântica "best-effort": uma falha não teria retry automático, a próxima execução periódica reprocessa o vídeo).
  - Intervalo do sweep não estava fixado por nenhuma TD; adicionado `QUEUE_SWEEP_ABANDONED_UPLOADS_INTERVAL_MS` (default `3600000` = 1h) em `queue.config.ts`/`env.validation.ts`/`.env.example`, seguindo o padrão de defaults sem TD já usado na SI-03.1.
  - `AbandonedUploadSweepScheduler.onModuleInit` usa `jobId` fixo no `queue.add(..., { repeat, jobId })`: BullMQ deduplica repeatable jobs pelo par nome+padrão de repetição, então reiniciar a API não cria jobs repetidos — não há teste automatizado para essa idempotência de registro (fora da Tests table desta SI, que só cobre o `AbandonedUploadSweepProcessor`); validado por leitura da documentação do BullMQ, não por execução real.
  - AC #3 (rodar o sweep duas vezes não repete o abort) é satisfeita pela própria query de seleção (`status = 'draft'`): um vídeo já `failed` não é mais retornado pelo `find`, então a segunda chamada de `process()` nunca tenta abortar de novo — não foi necessário um guard extra de estado dentro do loop.

### SI-03.9 — Video worker: bootstrap standalone
- **Status:** completed
- **Tests:** 1 passing
- **Observations:**
  - `WorkerModule` importa apenas `ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] })` + `QueueModule` — sem `TypeOrmModule`/entidades. A Technical action 1 desta SI só cita "importa QueueModule", e a Tests table rotula `worker.module.spec.ts` como "Unit: compilation test"; conectar TypeORM real ao `WorkerModule` agora violaria a regra do projeto de que `*.spec.ts` (Unit) proíbe I/O de banco (`nestjs-project/CLAUDE.md` → "Test Type Selection"). A entidade `Video`/`TypeOrmModule` fica para a SI-03.10 (que a Dependency Map já amarra a SI-03.3 + SI-03.5), quando o `VideoProcessor` de fato precisar do repositório.
  - AC #2 ("reutilizando as mesmas entidades e configs da API, sem duplicação de código") é satisfeita nesta SI pelo reuso literal de `queueConfig` (mesmo arquivo `src/config/queue.config.ts` importado pela API) e da própria classe `QueueModule` — nenhuma config ou entidade foi redefinida.
  - `Dockerfile`/estágio `worker` já existia (criado na SI-03.1); nenhuma alteração necessária nele para esta SI.
  - Adicionado script `start:worker` (`ts-node src/worker/main.ts`) ao `package.json`, no mesmo estilo dos scripts standalone já existentes (`seed`, `openapi:export`) — sem `tsconfig-paths/register`, pois o projeto não usa path aliases.
  - `compose.yaml`: adicionado `command: npm run start:worker` ao serviço `video-worker`, substituindo o idle padrão (`tail -f /dev/null` do `Dockerfile`). Diferente de `nestjs-api` (que fica ocioso por convenção — dev roda `start:dev` manualmente via `docker compose exec`), o worker é um processo de background contínuo em todos os ambientes, então a Action 3 da própria SI ("apontar o serviço video-worker do Compose para ele") pede esse `command:` explícito.
  - `main.ts` usa `bootstrap().catch(...)` com `console.error` + `process.exit(1)` em vez do padrão `void bootstrap()` do `src/main.ts` da API — garante que uma falha de bootstrap (AC #3) seja reportada nos logs e o processo termine, em vez de deixar uma promise rejeitada silenciosa. Falhas de conexão do BullMQ/ioredis com o Valkey (pós-bootstrap, não síncronas) continuam sendo logadas pelo próprio ioredis/BullMQ, sem supressão adicionada por este código.

### SI-03.10 — `VideoProcessor`: metadados e thumbnail via ffmpeg/ffprobe
- **Status:** completed
- **Tests:** 8 passing (6 unit + 1 integration real com ffmpeg/ffprobe + 1 integration de compilação do `WorkerModule`)
- **Observations:**
  - Nenhuma TD/library-refs.md fixa um wrapper npm para ffmpeg/ffprobe; usado `node:child_process` (`execFile`) puro contra os binários já instalados na imagem (Action 5). `FfmpegService` só faz o shell-out (`probe` retorna o JSON cru do ffprobe, `extractThumbnail` retorna o Buffer JPEG); parsing do JSON e cálculo do timestamp (10% da duração) ficam em `VideoProcessor`, para bater com a redação da própria Tests table ("parsing do ffprobe, cálculo do timestamp do frame... com storage/ffmpeg mockados").
  - `VideoProcessor`/`FfmpegService` são registrados como providers direto em `WorkerModule` (não em `VideosModule`), pela mesma razão já registrada nas observações da SI-03.8/03.9: se entrassem em `VideosModule`, o processo da API (que importa `VideosModule`) também viraria consumer BullMQ da fila `video-processing`, contrariando o isolamento do worker.
  - `worker.module.spec.ts` (SI-03.9) foi renomeado para `worker.module.integration-spec.ts`: `WorkerModule` agora abre conexão real ao Postgres no `compile()` (para o `VideoProcessor` acessar o repositório de `Video`), o que a própria SI-03.9 já havia antecipado como responsabilidade desta SI ("a entidade Video/TypeORM fica para a SI-03.10").
  - Bug pego pelo fix loop (1ª tentativa): `WorkerModule` registrava só `Video` em `TypeOrmModule.forFeature`; como `Video → Channel` é uma relação `@ManyToOne` e `Channel → User` é `@OneToOne`, o TypeORM não conseguia montar a metadata (`Entity metadata for Video#channel was not found`) e ficava em retry-loop até estourar o timeout do teste. Corrigido adicionando `Channel` e `User` ao mesmo `forFeature` — nenhum dos dois é usado por código do worker, é só para resolver a metadata da relação.
  - Adicionado `StorageService.putObject` (`PutObjectCommand`) — método que não existia, necessário para o processor gravar a thumbnail gerada.
  - Nenhuma TD fixa o TTL da URL pré-assinada que o worker usa para ler o vídeo original do storage (ffprobe/ffmpeg leem via HTTP, não fazem download local); reaproveitado `presignedDownloadUrlTtlSeconds` (15 min, o maior dos três TTLs já existentes) por ser o mais seguro para vídeos grandes. Sinalizando para o usuário revisar se merece um TTL dedicado.
  - O integration-spec do `VideoProcessor` roda ffmpeg/ffprobe de verdade (sem mocks) contra um vídeo sintético gerado no próprio teste via `ffmpeg -f lavfi -i testsrc=...` (evita commitar um fixture binário). Isso exigiu instalar `ffmpeg` também em `Dockerfile.dev` (imagem do `nestjs-api`, onde os testes rodam) — até então só a imagem do `video-worker` tinha o pacote (Action 5 falava só da imagem do worker); sem isso o teste não roda onde a suíte de fato executa. Rebuild da imagem `nestjs-api` feito (`docker compose up -d --build nestjs-api`).
  - Mesma situação já registrada na SI-03.7: a chave da thumbnail é sempre `{id}/thumbnail.jpg` (não usa o prefixo de teste `STORAGE_TEST_KEY_PREFIX`), então o integration-spec limpa esse objeto manualmente no `afterEach` (`DeleteObjectCommand` direto), fora do mecanismo padrão `clearTestStorageObjects()` (que só cobre chaves prefixadas).

### SI-03.11 — Endpoint GET /videos/:id/stream
- **Status:** completed
- **Tests:** 23 passing (13 unit + 10 e2e)
- **Observations:**
  - Nenhum controller do projeto usava `@Redirect`/`res.redirect` antes desta SI (confirmado via Explore); implementado com o decorator `@Redirect()` sem argumentos e o handler retornando `{ url, statusCode: HttpStatus.FOUND }` — é o padrão idiomático do NestJS para redirects com URL dinâmica (a assinatura da URL muda por request).
  - Criada `VideoNotReadyException` (409, `VIDEO_NOT_READY`) em `videos.exceptions.ts`, seguindo o mesmo padrão das exceptions já existentes no módulo (subclasse de `DomainException`, sem parâmetros no construtor).
  - `VideosService.getStreamUrl` reusa `presignedStreamUrlTtlSeconds` de `storage.config.ts`, que já existia desde a SI-03.1 mas não tinha nenhum consumidor até agora.
  - Spec-derived E2E (`nestjs-project/specs/videos-stream.plan.md`): os 4 cenários foram adicionados como um novo bloco `describe('GET /videos/:id/stream', ...)` no arquivo já existente `test/videos.e2e-spec.ts` (mesmo `target_file:` de SI-03.6/03.7/03.12), seguindo o padrão observado de acumular describes por endpoint no mesmo arquivo. Criado o helper `createVideoWithStatus` (registra+confirma+loga um usuário novo, localiza o canal automático via `ChannelsService.findByUserId`, e insere o `Video` diretamente via repositório com o `status` desejado) para bypassar o pipeline de upload/processamento real.
  - Os testes e2e usam `.redirects(0)` no supertest para inspecionar o `302` e o header `Location` sem seguir o redirect real até o MinIO (o objeto do vídeo não existe de fato, já que o `Video` é inserido diretamente no banco).

### SI-03.12 — Endpoint GET /videos/:id/download
- **Status:** completed
- **Tests:** 34 passing (18 unit + 16 e2e — arquivos inteiros `videos.service.spec.ts` e `videos.e2e-spec.ts`, incluindo describes de SIs anteriores)
- **Observations:**
  - `StorageService.presignGetObject` já suportava `responseContentDisposition` desde a SI-03.5 e `storage.config.ts` já tinha `presignedDownloadUrlTtlSeconds` desde a SI-03.1 — nenhuma mudança de config/storage foi necessária, só o consumo em `VideosService.getDownloadUrl`.
  - Reusada `VideoNotReadyException` (409, `VIDEO_NOT_READY`) já criada na SI-03.11 — o Error Catalog trata o mesmo código para stream e download.
  - Spec-derived E2E (`nestjs-project/specs/videos-download.plan.md`): os 4 cenários (na verdade 4 `it`s cobrindo os 3 grupos do spec — o grupo 4.1 gerou 1 teste, mas adicionei também "sem token de acesso" espelhando o padrão do describe de stream, cobrindo a Authorization Matrix "Public/Authenticated") foram adicionados como novo `describe('GET /videos/:id/download', ...)` no arquivo acumulado `test/videos.e2e-spec.ts`, seguindo o padrão da SI-03.11.
  - **Bug pré-existente descoberto e corrigido (fora do escopo estrito desta SI, mas bloqueava os próprios testes dela):** `test/videos.e2e-spec.ts` nunca limpava o `ThrottlerStorage` entre testes (diferente de `test/auth.e2e-spec.ts`, que já fazia isso desde a fase 02). Como o arquivo acumula describes entre SIs (03.7, 03.11, 03.12) e cada um registra novos usuários via `/auth/register`, o volume total de chamadas ao longo do arquivo estourava o rate limit do `ThrottlerGuard` global só a partir do describe de download (último do arquivo) — os registros retornavam 429 silenciosamente, o token de confirmação capturado ficava vazio e o `findOneByOrFail` subsequente por email falhava com `EntityNotFoundError`. Corrigido adicionando `throttlerStorage.storage.clear()` no `beforeEach` compartilhado, replicando o padrão já existente em `test/auth.e2e-spec.ts`. Sinalizando para o usuário: é uma correção em infraestrutura de teste compartilhada (não em lógica de negócio de SIs anteriores), necessária para os testes desta própria SI passarem de forma confiável.

---

## Fechamento da fase

Revisão final contra os Critérios de Aceite da fase, fechando as lacunas que as SIs haviam sinalizado ao usuário em vez de resolver.

### 1. Wiring do `AbandonedUploadSweepProcessor` (lacuna da SI-03.8)

O processor era a única peça da fase decorada com `@Processor` que não estava em `providers` de nenhum `@Module` — a doc do `@nestjs/bullmq` é explícita ("Consumers must be registered as `providers` so the `@nestjs/bullmq` package can pick them up"), então o `AbandonedUploadSweepScheduler` enfileirava jobs repetíveis que nada consumia. Registrado em `WorkerModule` (não em `VideosModule`, pelo mesmo motivo de isolamento já argumentado na SI-03.8 e SI-03.10: o processo da API não pode virar consumer BullMQ). Nenhuma dependência nova foi necessária — `WorkerModule` já importava `StorageModule` e já registrava `Video` em `TypeOrmModule.forFeature`.

Validado em runtime contra a stack real do Compose, não só por DI: com um vídeo `draft` de `upload_expires_at` no passado e um job publicado na fila `sweep-abandoned-uploads`, o container `video-worker` consumiu o job e o vídeo transicionou para `failed` com `failure_reason = "Upload expired before completion"`.

Regressão coberta por `src/worker/worker.module.integration-spec.ts`, que agora resolve cada consumer pelo container de DI — um consumer novo que fique sem registro quebra o teste em vez de falhar silenciosamente em produção. A mesma regra foi documentada em `nestjs-project/CLAUDE.md`.

### 2. Cobertura E2E do `POST /videos` (lacuna da SI-03.6/03.7)

Os 4 cenários de `specs/videos.plan.md` (que a SI-03.7 registrou como não implementados, por o spec ter sido gerado depois da SI-03.6) foram adicionados como `describe('POST /videos', ...)` em `test/videos.e2e-spec.ts`: resposta 201 com `public_id` de 11 caracteres base64url e uma URL pré-assinada por parte (exercitando o cálculo de partes com um arquivo de 150 MB, ou seja, 2 partes), 413 `UPLOAD_FILE_TOO_LARGE` acima de 10 GB, 415 `UNSUPPORTED_MEDIA_TYPE` e 401 sem token.

### 3. Deadlock intermitente em `migrations.integration-spec.ts`

O `beforeAll` dropava as tabelas com `Promise.all`; `DROP TABLE ... CASCADE` concorrentes sobre tabelas ligadas por FK adquirem locks em ordens diferentes e deadlockam no Postgres. A fase 03 agravou a corrida ao somar a FK `videos → channels` ao conjunto. Serializado o loop de drops.

### 4. Placeholders no plano

Os cabeçalhos de API Contracts em `phase-03-videos.md` traziam o literal `(SI-NN.X)` do template do `/plan-build`; substituídos pelas SIs reais (03.6, 03.7, 03.11, 03.12).

### Definition of Done (verificada na stack completa do Compose)

| Verificação | Resultado |
|---|---|
| `npm test -- --runInBand` (unit + integração) | 37 suites, 210 testes passando |
| `npm run test:e2e` | 4 suites, 72 testes passando |
| `npx tsc --noEmit` | exit 0 |
| `npm run lint` | exit 0 (0 errors, 26 warnings `no-unsafe-argument` pré-existentes) |
