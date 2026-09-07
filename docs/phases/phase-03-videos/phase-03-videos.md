---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-09-05T19:01:34-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-09-05T19:01:53-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-05T18:59:28-03:00"
---

# Fase 03 — Upload e Processamento de Vídeos

## Objective

Entregar o backend de upload e processamento de vídeos da StreamTube: upload multipart de até 10GB direto para o object storage sem passar pela API, pré-cadastro automático do vídeo como rascunho, processamento assíncrono em fila (extração de metadados e geração de thumbnail), URL pública única por vídeo, e entrega via streaming (com suporte a range requests) e download — sem impacto de performance na API e com um serviço de worker de vídeo isolado.

---

## Step Implementations

### SI-03.1 — Infra: serviços de storage e fila no Compose + configuração namespaced

**Description:** Adiciona ao Compose a infraestrutura de fila (Valkey) e storage (MinIO pinado) e o serviço do video-worker, e cria a configuração namespaced + validação de ambiente que os demais SIs vão consumir.

**Technical actions:**

1. Adicionar o serviço `valkey` (imagem `valkey/valkey`, porta `6379`) ao `compose.yaml` — backend da fila BullMQ (`phase-03-videos/TD-01`)
2. Adicionar o serviço `storage` (imagem MinIO com tag pinada) ao `compose.yaml`, com healthcheck e criação automática dos buckets de vídeos e de thumbnails (`phase-03-videos/TD-04`, `TD-05`)
3. Adicionar o serviço `video-worker` ao `compose.yaml`, construído a partir de um novo target dedicado no `Dockerfile` (`phase-03-videos/TD-06`)
4. Criar `src/config/queue.config.ts` e `src/config/storage.config.ts` (namespaced `registerAs`, seguindo o padrão de `database.config.ts`) e registrá-los em `ConfigModule.forRoot({ load: [...] })` (`phase-03-videos/TD-01`, `TD-02`, `TD-04`, `TD-05`)
5. Adicionar ao schema Joi em `env.validation.ts` as novas variáveis: host/porta da fila, endpoint/credenciais/nomes dos buckets do storage, TTL de presigned URL, TTL de upload abandonado, tamanho máximo de upload, MIME types aceitos, tamanho de parte do multipart (`phase-03-videos/TD-01`, `TD-02`, `TD-04`, `TD-05`, `TD-12`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `queue.config.ts` / `storage.config.ts` | Unit: compilation test — config carrega os valores esperados | `queue.config.spec.ts`, `storage.config.spec.ts` |
| `env.validation.ts` (novas vars) | Integration: aceita/rejeita valores per schema | `env.validation.integration-spec.ts` (extensão) |

**Dependencies:** none

**Acceptance criteria:**

- `docker compose ps` mostra `valkey`, `storage` e `video-worker` com status `running` após `docker compose up -d`
- Subir a API sem uma das novas variáveis de ambiente obrigatórias falha a validação do Joi na inicialização
- `queue.config.ts` e `storage.config.ts` expõem os valores via `ConfigType`, sem hardcode de `localhost` como host

---

### SI-03.2 — Infra: isolamento de testes para storage e fila

**Description:** Helper de setup/teardown para fila e storage de teste, seguindo o padrão já usado para banco e Mailpit, para que a suíte de testes nunca consuma a fila ou os buckets de desenvolvimento.

**Technical actions:**

1. Criar `test/support/queue-test.helper.ts` com setup/teardown que esvazia a fila `video-processing` (`Queue#obliterate`) entre execuções (`phase-03-videos/TD-13`)
2. Criar `test/support/storage-test.helper.ts` com setup/teardown que remove os objetos criados sob um prefixo de teste nos buckets de vídeos e thumbnails (`phase-03-videos/TD-13`)
3. Adicionar as variáveis de ambiente de teste (fila e buckets dedicados) ao arquivo de ambiente de teste já usado pelo projeto (`phase-03-videos/TD-13`)

**Tests:** _(empty — Infra; validado indiretamente pelos testes de integração que consomem os helpers)_

**Dependencies:** SI-03.1

**Acceptance criteria:**

- Rodar a suíte de integração duas vezes seguidas não deixa jobs residuais na fila `video-processing` nem objetos residuais nos buckets de teste
- Os testes de integração/e2e de vídeo rodam contra a fila e os buckets dedicados a teste, nunca contra os de desenvolvimento

---

### SI-03.3 — Entidade `Video` e migration

**Description:** Entidade `Video` e migration correspondente, cobrindo pré-cadastro, ciclo de status e as chaves de storage do Data Model.

**Technical actions:**

1. Criar `src/videos/entities/video.entity.ts` com as colunas do Data Model (`public_id`, `channel_id`, `title`, `status`, `failure_reason`, `original_key`, `thumbnail_key`, `duration_seconds`, `upload_id`, `upload_expires_at`) per `## Technical Specifications → Data Model`
2. Gerar a migration TypeORM para a tabela `videos`, incluindo os índices únicos/simples do Data Model (`public_id`, `channel_id`, `status`)
3. Criar `src/videos/public-id.util.ts` — `generateVideoPublicId()` usando `node:crypto` (`phase-03-videos/TD-08`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` (entity) | Integration: constraints, defaults, índice único em `public_id` | `video.entity.integration-spec.ts` |
| `generateVideoPublicId` | Unit: formato e unicidade estatística | `public-id.util.spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- Inserir dois vídeos com o mesmo `public_id` viola a constraint única no banco
- `status` assume o default `'draft'` quando não informado na criação
- `generateVideoPublicId()` não produz colisões em 10 mil execuções amostradas

---

### SI-03.4 — `QueueModule`: fila `video-processing`

**Description:** Módulo de fila registrando `video-processing` no BullMQ com os defaults de retry decididos para o processamento de vídeo.

**Technical actions:**

1. Criar `src/queue/queue.module.ts` com `BullModule.forRootAsync` (lendo `queue.config.ts`) e `BullModule.registerQueue({ name: 'video-processing', defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay } } })` (`phase-03-videos/TD-01`, `TD-11`)
2. Exportar o módulo para ser importado por `VideosModule` (API) e pelo bootstrap do video-worker (`phase-03-videos/TD-06`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `QueueModule` | Unit: compilation test | `queue.module.spec.ts` |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- `QueueModule` compila e injeta a fila `video-processing` sem erros com as variáveis de `queue.config.ts`
- Jobs enfileirados sem `attempts`/`backoff` explícitos herdam os defaults de 3 tentativas com backoff exponencial

---

### SI-03.5 — `StorageService`: cliente S3 (multipart + presigned URLs)

**Description:** Serviço de storage encapsulando o handshake multipart e a geração de URLs assinadas, reusado pelo upload, pelo streaming e pelo download.

**Technical actions:**

1. Criar `src/storage/storage.service.ts` com `S3Client` configurado a partir de `storage.config.ts` (endpoint do serviço `storage`, `forcePathStyle: true`) (`phase-03-videos/TD-02`, `TD-04`)
2. Implementar `createMultipartUpload`, `presignUploadParts`, `completeMultipartUpload` e `abortMultipartUpload` (`phase-03-videos/TD-02`, `TD-03`)
3. Implementar `presignGetObject(bucket, key, options)`, reusado por streaming e download (`phase-03-videos/TD-09`, `TD-10`)
4. Resolver o bucket por tipo de conteúdo (vídeos vs. thumbnails) a partir de `storage.config.ts` (`phase-03-videos/TD-05`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageService` | Unit: real lib com config de teste | `storage.service.spec.ts` |
| `StorageService` | Integration: contra o serviço `storage` real do Compose | `storage.service.integration-spec.ts` |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- `createMultipartUpload` retorna um `UploadId` válido contra o storage do Compose
- `presignUploadParts` retorna uma URL por parte, todas apontando para o endpoint do serviço `storage`
- `presignGetObject` gera URLs com TTL igual ao configurado em `storage.config.ts`

---

### SI-03.6 — Endpoint POST /videos (iniciar upload)

**Description:** Endpoint que inicia o upload — cria o vídeo em `draft`, abre o multipart upload e retorna as URLs assinadas por parte.

**Route:** POST /videos
**Test Specs:** see `nestjs-project/specs/videos.plan.md`
**Authorization:** Authenticated

**Technical actions:**

1. Adicionar `ChannelsService.findByUserId(userId)` para resolver o canal do usuário autenticado (`phase-03-videos/TD-03`)
2. Criar `CreateVideoDto` com `filename`, `content_type`, `file_size` e as regras de `#### Validation Rules — POST /videos` (per `## Technical Specifications → API Contracts`)
3. Implementar `VideosService.initiateUpload(channelId, dto)`: valida limites (`UPLOAD_FILE_TOO_LARGE`, `UNSUPPORTED_MEDIA_TYPE`), cria o `Video` em `draft` com `public_id`, `title` (a partir de `filename`) e `original_key`, e chama `StorageService.createMultipartUpload` + `presignUploadParts` (`phase-03-videos/TD-02`, `TD-03`, `TD-08`, `TD-12`)
4. Criar `VideosController` com `POST /videos` per `#### POST /videos` de `## Technical Specifications → API Contracts`, incluindo os decorators OpenAPI (`@ApiOperation`, `@ApiResponse`, `@ApiBody`) per convenção herdada de `openapi-docs-nestjs`
5. Registrar `VideosModule` (com `VideosController`, `VideosService`) em `AppModule`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.initiateUpload` | Unit: branch logic (limites, mapeamento de erros) com repo mockado | `videos.service.spec.ts` |
| `VideosService.initiateUpload` | Integration: persiste o `Video` em `draft` | `videos.service.integration-spec.ts` |

**Dependencies:** SI-03.3 + SI-03.5

**Acceptance criteria:**

- `POST /videos` com corpo válido retorna `201` com `id`, `public_id`, `upload_id` e `parts`
- `POST /videos` com `file_size` acima do limite retorna `413` com `error: "UPLOAD_FILE_TOO_LARGE"`
- `POST /videos` com `content_type` fora da lista aceita retorna `415` com `error: "UNSUPPORTED_MEDIA_TYPE"`
- `POST /videos` sem token de acesso retorna `401`
- O vídeo criado persiste com `status = 'draft'` e `channel_id` igual ao canal do usuário autenticado

---

### SI-03.7 — Endpoint POST /videos/:id/complete-upload

**Description:** Endpoint que conclui o multipart upload e dispara o processamento assíncrono do vídeo.

**Route:** POST /videos/:id/complete-upload
**Test Specs:** see `nestjs-project/specs/videos-complete-upload.plan.md`
**Authorization:** Authenticated (owner)

**Technical actions:**

1. Implementar `VideosService.completeUpload(videoId, userId, parts)`: verifica posse (`VIDEO_ACCESS_DENIED`) e `status = 'draft'` (`VIDEO_UPLOAD_ALREADY_COMPLETED`), chama `StorageService.completeMultipartUpload`, atualiza `status → 'processing'` via update guardado e idempotente, e enfileira o job `video-processing` (`phase-03-videos/TD-03`, `TD-11`)
2. Criar `CompleteUploadDto` com `parts: { part_number, etag }[]`
3. Adicionar `POST /videos/:id/complete-upload` ao `VideosController` per `## Technical Specifications → API Contracts`, com os decorators OpenAPI

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.completeUpload` | Unit: branch logic (posse, status) com repo mockado | `videos.service.spec.ts` |
| `VideosService.completeUpload` | Integration: transição de status guardada e idempotente | `videos.service.integration-spec.ts` |

**Dependencies:** SI-03.6 + SI-03.4

**Acceptance criteria:**

- `POST /videos/:id/complete-upload` de um vídeo do próprio usuário retorna `202` com `status: "processing"` e enfileira exatamente um job `video-processing`
- `POST /videos/:id/complete-upload` de um vídeo de outro canal retorna `403` com `error: "VIDEO_ACCESS_DENIED"`
- Chamar o endpoint duas vezes para o mesmo vídeo retorna `409` com `error: "VIDEO_UPLOAD_ALREADY_COMPLETED"` na segunda chamada
- `id` inexistente retorna `404` com `error: "VIDEO_NOT_FOUND"`

---

### SI-03.8 — Sweep de uploads abandonados

**Description:** Job repetível que varre uploads abandonados e os marca como falhos, fechando a lacuna deixada pelo handshake explícito de conclusão.

**Technical actions:**

1. Implementar `AbandonedUploadSweepProcessor` que busca vídeos `status = 'draft'` com `upload_expires_at` no passado (`phase-03-videos/TD-03`, `TD-12`)
2. Para cada vídeo encontrado, chamar `StorageService.abortMultipartUpload` e atualizar `status → 'failed'` com `failure_reason` via update guardado e idempotente (`phase-03-videos/TD-11`)
3. Registrar o job repetível `sweep-abandoned-uploads` no bootstrap do `QueueModule`/`VideosModule`, com intervalo configurável (`phase-03-videos/TD-03`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `AbandonedUploadSweepProcessor` | Unit: branch logic (seleção de vídeos elegíveis) com repo mockado | `abandoned-upload-sweep.processor.spec.ts` |
| `AbandonedUploadSweepProcessor` | Integration: marca `failed` e aborta o multipart no storage | `abandoned-upload-sweep.processor.integration-spec.ts` |

**Dependencies:** SI-03.4 + SI-03.5 + SI-03.3

**Acceptance criteria:**

- Um vídeo `draft` com `upload_expires_at` no passado é marcado `failed` após a execução do sweep
- Um vídeo `draft` ainda dentro do TTL não é alterado pelo sweep
- Rodar o sweep duas vezes sobre o mesmo vídeo já `failed` não produz erro nem uma nova tentativa de abortar o multipart

---

### SI-03.9 — Video worker: bootstrap standalone

**Description:** Bootstrap standalone do video-worker, isolado da API HTTP conforme a arquitetura decidida, compartilhando entidades e configs via imports simples.

**Technical actions:**

1. Criar `src/worker/worker.module.ts` e `src/worker/main.ts` — contexto Nest standalone (`NestFactory.createApplicationContext`) que importa `QueueModule` (`phase-03-videos/TD-06`)
2. Adicionar o target `worker` ao `Dockerfile` (multi-stage, compartilhando `src/` via imports simples) (`phase-03-videos/TD-06`)
3. Adicionar o script `start:worker` ao `package.json` e apontar o serviço `video-worker` do Compose para ele (`phase-03-videos/TD-06`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `WorkerModule` | Unit: compilation test | `worker.module.spec.ts` |

**Dependencies:** SI-03.1 + SI-03.4

**Acceptance criteria:**

- `docker compose up -d video-worker` inicia o processo standalone sem subir a API HTTP
- `WorkerModule` compila reutilizando as mesmas entidades e configs da API, sem duplicação de código
- Uma falha de conexão com `valkey` no boot do worker é reportada nos logs do container, não silenciada

---

### SI-03.10 — `VideoProcessor`: metadados e thumbnail via ffmpeg/ffprobe

**Description:** Processor que extrai metadados e gera a thumbnail para vídeos em processamento, fechando o ciclo de status até `ready` ou `failed`.

**Technical actions:**

1. Implementar `VideoProcessor` (`@Processor('video-processing')`) que acessa o vídeo original no storage e roda `ffprobe` (JSON output) para obter `duration_seconds` (`phase-03-videos/TD-07`)
2. Gerar a thumbnail com `ffmpeg` a partir de um frame a ~10% da duração, escalado para 1280×720 JPEG, e enviar para o bucket de thumbnails (`phase-03-videos/TD-07`, `TD-05`)
3. Ao concluir, atualizar o `Video` com `duration_seconds`, `thumbnail_key` e `status → 'ready'` via update guardado e idempotente (`phase-03-videos/TD-11`)
4. Em caso de falha definitiva (após as tentativas do BullMQ), atualizar `status → 'failed'` com `failure_reason` (`phase-03-videos/TD-11`)
5. Instalar o pacote de SO do FFmpeg na imagem do video-worker (`phase-03-videos/TD-07`, `TD-06`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessor` | Unit: branch logic (parsing do `ffprobe`, cálculo do timestamp do frame) com storage/ffmpeg mockados | `video.processor.spec.ts` |
| `VideoProcessor` | Integration: contra um vídeo real de teste, valida `duration_seconds`, `thumbnail_key` e `status = 'ready'` | `video.processor.integration-spec.ts` |

**Dependencies:** SI-03.9 + SI-03.5 + SI-03.3

**Acceptance criteria:**

- Processar um vídeo válido resulta em `status = 'ready'`, `duration_seconds` preenchido e `thumbnail_key` apontando para um objeto existente no bucket de thumbnails
- Um vídeo cujo processamento falha nas 3 tentativas termina em `status = 'failed'` com `failure_reason` preenchido
- Reprocessar um job redelivered (at-least-once) não regride um vídeo já `ready`

---

### SI-03.11 — Endpoint GET /videos/:id/stream

**Description:** Endpoint de streaming que redireciona para uma URL assinada de leitura no bucket de vídeos.

**Route:** GET /videos/:id/stream
**Test Specs:** see `nestjs-project/specs/videos-stream.plan.md`
**Authorization:** Public (anonymous)

**Technical actions:**

1. Implementar `VideosService.getStreamUrl(videoId)`: valida `status = 'ready'` e chama `StorageService.presignGetObject` no bucket de vídeos (`phase-03-videos/TD-09`)
2. Adicionar `GET /videos/:id/stream` ao `VideosController`, respondendo `302` com `Location` per `## Technical Specifications → API Contracts`, com os decorators OpenAPI e marcado `@Public()`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.getStreamUrl` | Unit: branch logic (status) com repo mockado | `videos.service.spec.ts` |

**Dependencies:** SI-03.3 + SI-03.5

**Acceptance criteria:**

- `GET /videos/:id/stream` de um vídeo `ready` retorna `302` com `Location` apontando para o bucket de vídeos
- `GET /videos/:id/stream` de um vídeo não `ready` retorna `409` com `error: "VIDEO_NOT_READY"`
- `GET /videos/:id/stream` de um `id` inexistente retorna `404` com `error: "VIDEO_NOT_FOUND"`
- O endpoint é acessível sem token de acesso (anônimo)

---

### SI-03.12 — Endpoint GET /videos/:id/download

**Description:** Endpoint de download com URL assinada própria e nome de arquivo derivado do título do vídeo.

**Route:** GET /videos/:id/download
**Test Specs:** see `nestjs-project/specs/videos-download.plan.md`
**Authorization:** Public (anonymous)

**Technical actions:**

1. Implementar `VideosService.getDownloadUrl(videoId)`: valida `status = 'ready'` e chama `StorageService.presignGetObject` com `response-content-disposition=attachment; filename="{title}"` e TTL próprio (`phase-03-videos/TD-10`)
2. Adicionar `GET /videos/:id/download` ao `VideosController`, respondendo `302` com `Location` per `## Technical Specifications → API Contracts`, com os decorators OpenAPI e marcado `@Public()`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.getDownloadUrl` | Unit: branch logic (status, nome do arquivo) com repo mockado | `videos.service.spec.ts` |

**Dependencies:** SI-03.3 + SI-03.5

**Acceptance criteria:**

- `GET /videos/:id/download` de um vídeo `ready` retorna `302` com `Location` cujo TTL é independente do TTL do endpoint de streaming
- `GET /videos/:id/download` de um vídeo não `ready` retorna `409` com `error: "VIDEO_NOT_READY"`
- `GET /videos/:id/download` de um `id` inexistente retorna `404` com `error: "VIDEO_NOT_FOUND"`

---

## Technical Specifications

### Data Model

#### Video

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | uuid | PK, generated | |
| public_id | varchar | unique, not null | URL pública imutável do vídeo, gerada com `node:crypto` (phase-03-videos/TD-08) |
| channel_id | uuid | FK → channels.id, not null | Dono do vídeo |
| title | varchar(255) | not null | Preenchido a partir do nome original do arquivo no pré-cadastro; base do filename de download (phase-03-videos/TD-10) |
| status | varchar | not null, default `'draft'` | Um de `draft` \| `processing` \| `ready` \| `failed` — campo único de leitura para o painel de gerenciamento e os endpoints de entrega (phase-03-videos/TD-11) |
| failure_reason | text | nullable | Preenchido apenas quando `status = 'failed'` (phase-03-videos/TD-11) |
| original_key | varchar | not null | Chave do objeto no bucket de vídeos, padrão `{id}/…` (phase-03-videos/TD-05) |
| thumbnail_key | varchar | nullable | Chave do objeto no bucket de thumbnails, preenchida após o processamento (phase-03-videos/TD-05, TD-07) |
| duration_seconds | integer | nullable | Extraído via `ffprobe` durante o processamento (phase-03-videos/TD-07) |
| upload_id | varchar | nullable | `UploadId` do multipart upload no storage; limpo após a conclusão (phase-03-videos/TD-02, TD-03) |
| upload_expires_at | timestamp | nullable | Prazo da varredura de uploads abandonados (phase-03-videos/TD-03, TD-12) |
| created_at | timestamp | not null, auto-generated | |
| updated_at | timestamp | not null, auto-generated | |

**Relations:** Video → Channel (many-to-one via `channel_id`)
**Indexes:** `(public_id)` — unique, `(channel_id)` — FK, `(status)` — usado pela varredura de uploads abandonados

---

### API Contracts

#### POST /videos (SI-03.6)

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer {access_token}

**Request body:**
- filename: string, required — nome original do arquivo
- content_type: string, required — MIME type declarado pelo cliente
- file_size: number, required — tamanho total em bytes

**Response 201:**
- id: string (uuid)
- public_id: string
- upload_id: string — `UploadId` do multipart upload (phase-03-videos/TD-02)
- parts: array of `{ part_number: number, url: string }` — uma presigned PUT URL por parte (phase-03-videos/TD-02)

**Error responses:**
- 413 UPLOAD_FILE_TOO_LARGE: quando `file_size` excede o limite configurado
- 415 UNSUPPORTED_MEDIA_TYPE: quando `content_type` não está na lista aceita
- 400 validation error: quando o corpo falha na validação de schema

---

#### POST /videos/:id/complete-upload (SI-03.7)

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer {access_token}

**Request body:**
- parts: array of `{ part_number: number, etag: string }`, required — retornado pelo storage para cada parte enviada (phase-03-videos/TD-02)

**Response 202:**
- id: string (uuid)
- status: string — `"processing"`

**Error responses:**
- 403 VIDEO_ACCESS_DENIED: quando o vídeo não pertence ao canal do usuário autenticado
- 404 VIDEO_NOT_FOUND: quando o `id` não existe
- 409 VIDEO_UPLOAD_ALREADY_COMPLETED: quando o upload já foi concluído, ou o vídeo já não está mais em `draft`
- 400 validation error: quando o corpo falha na validação de schema

---

#### GET /videos/:id/stream (SI-03.11)

**Response 302:** redirect (`Location`) para uma presigned GET URL do bucket de vídeos, TTL curto configurável (phase-03-videos/TD-09, TD-12); o player consome a URL diretamente do storage, que responde `206 Partial Content` a requisições com `Range` — a API fica fora do caminho dos bytes.

**Error responses:**
- 404 VIDEO_NOT_FOUND: quando o `id` não existe
- 409 VIDEO_NOT_READY: quando `status` não é `ready`

---

#### GET /videos/:id/download (SI-03.12)

**Response 302:** redirect (`Location`) para uma presigned GET URL do bucket de vídeos com `response-content-disposition=attachment; filename="{title}"`, TTL próprio e independente do TTL de streaming (phase-03-videos/TD-10, TD-12).

**Error responses:**
- 404 VIDEO_NOT_FOUND: quando o `id` não existe
- 409 VIDEO_NOT_READY: quando `status` não é `ready`

---

#### Validation Rules — POST /videos

- `filename`: obrigatório, string não vazia
- `content_type`: obrigatório, deve estar na lista de MIME types aceitos (env var, phase-03-videos/TD-12)
- `file_size`: obrigatório, inteiro positivo, não pode exceder o tamanho máximo configurado (env var, phase-03-videos/TD-12)

---

### Authorization Matrix

| Endpoint | Public | Authenticated | Owner | Notes |
|----------|--------|----------------|-------|-------|
| POST /videos | | ✓ | | Cria vídeo no canal do próprio usuário autenticado |
| POST /videos/:id/complete-upload | | | ✓ | Só o dono do canal do vídeo pode concluir o upload (phase-03-videos/TD-03) |
| GET /videos/:id/stream | ✓ | ✓ | | Anônimos podem assistir livremente (visão geral do projeto); regras de vídeo não-listado/privado chegam na Fase 05 (phase-03-videos/TD-09) |
| GET /videos/:id/download | ✓ | ✓ | | Mesmo modelo de acesso do streaming (phase-03-videos/TD-10) |

---

### Error Catalog

**Error response format:** herdado de `phase-02-auth` — `{ statusCode: number, error: string, message: string }` (phase-02-auth/TD-07).

| Code | HTTP | Message | Trigger |
|------|------|---------|---------|
| VIDEO_NOT_FOUND | 404 | Video not found | `:id` inexistente em qualquer endpoint de vídeo |
| VIDEO_ACCESS_DENIED | 403 | You do not own this video | POST /videos/:id/complete-upload para um vídeo cujo `channel_id` não é o do usuário autenticado (phase-03-videos/TD-03) |
| VIDEO_UPLOAD_ALREADY_COMPLETED | 409 | Upload has already been completed for this video | POST /videos/:id/complete-upload chamado mais de uma vez, ou após a varredura de uploads abandonados já ter marcado o vídeo como `failed` (phase-03-videos/TD-03, TD-11) |
| VIDEO_NOT_READY | 409 | Video is not ready for playback | GET /videos/:id/stream ou /videos/:id/download enquanto `status` é `draft`, `processing` ou `failed` (phase-03-videos/TD-09, TD-10, TD-11) |
| UPLOAD_FILE_TOO_LARGE | 413 | File exceeds the maximum upload size | POST /videos com `file_size` acima do máximo configurado (phase-03-videos/TD-12) |
| UNSUPPORTED_MEDIA_TYPE | 415 | Unsupported video format | POST /videos com `content_type` fora da lista de MIME types aceitos (phase-03-videos/TD-12) |

---

### Events/Messages

#### video-processing

**Payload:**

```json
{ "videoId": "uuid" }
```

**Producer:** `VideosService` — POST /videos/:id/complete-upload (phase-03-videos/TD-03)
**Consumer:** `VideoProcessor` no video-worker (phase-03-videos/TD-06)
**Trigger:** multipart upload concluído com sucesso — o vídeo sai de `draft` para `processing` e o job é enfileirado na fila `video-processing` sobre Redis/Valkey (phase-03-videos/TD-01).
**Delivery semantics:** at-least-once — até 3 tentativas com backoff exponencial (phase-03-videos/TD-01, TD-11); as transições de `status` são updates guardados e idempotentes para tolerar redelivery.

---

#### sweep-abandoned-uploads

**Payload:**

```json
{}
```

**Producer:** job repetível (`repeat`) registrado no bootstrap do módulo de vídeos, sobre a mesma infraestrutura BullMQ/Valkey (phase-03-videos/TD-01, TD-03)
**Consumer:** processor no video-worker (phase-03-videos/TD-06)
**Trigger:** varredura periódica — busca vídeos em `draft` cujo `upload_expires_at` já passou (TTL de upload abandonado, phase-03-videos/TD-12), aborta o multipart upload no storage e marca o vídeo como `failed` (phase-03-videos/TD-03, TD-11).
**Delivery semantics:** best-effort — execução periódica e idempotente (reprocessar um vídeo já `failed` é no-op).

---

<!-- phase-a-complete -->

## Dependency Map

```
SI-03.1 (root)
├── SI-03.2 — depende de SI-03.1 (helpers de teste precisam da fila/storage configurados)
├── SI-03.4 — depende de SI-03.1 (fila precisa de queue.config)
│   └── SI-03.9 — depende de SI-03.1 + SI-03.4 (worker importa o QueueModule)
│       └── SI-03.10 — depende de SI-03.9 + SI-03.5 + SI-03.3 (processor roda no worker)
└── SI-03.5 — depende de SI-03.1 (storage precisa de storage.config)

SI-03.3 (root)
└── SI-03.6 — depende de SI-03.3 + SI-03.5 (endpoint precisa da entidade e do storage)
    └── SI-03.7 — depende de SI-03.6 + SI-03.4 (conclusão do upload precisa da fila)
        └── SI-03.8 — depende de SI-03.4 + SI-03.5 + SI-03.3 (sweep reusa fila, storage e entidade)

SI-03.3 + SI-03.5
├── SI-03.11 — streaming precisa da entidade e do storage
└── SI-03.12 — download precisa da entidade e do storage
```

Ordem linearizada: SI-03.1 → SI-03.2, SI-03.3, SI-03.4, SI-03.5 (paralelo) → SI-03.6, SI-03.9, SI-03.11, SI-03.12 (paralelo, cada um só depende do que já está pronto) → SI-03.7 → SI-03.8, SI-03.10 (paralelo)

---

## Deliverables

- [x] SI-03.1 — Infra: serviços de storage e fila no Compose + configuração namespaced
- [x] SI-03.2 — Infra: isolamento de testes para storage e fila
- [x] SI-03.3 — Entidade `Video` e migration
- [x] SI-03.4 — `QueueModule`: fila `video-processing`
- [x] SI-03.5 — `StorageService`: cliente S3 (multipart + presigned URLs)
- [x] SI-03.6 — Endpoint POST /videos (iniciar upload)
- [x] SI-03.7 — Endpoint POST /videos/:id/complete-upload
- [x] SI-03.8 — Sweep de uploads abandonados
- [x] SI-03.9 — Video worker: bootstrap standalone
- [x] SI-03.10 — `VideoProcessor`: metadados e thumbnail via ffmpeg/ffprobe
- [x] SI-03.11 — Endpoint GET /videos/:id/stream
- [x] SI-03.12 — Endpoint GET /videos/:id/download

**Full test suites:**

- [x] Testes unitários e de integração passam (`docker compose exec nestjs-api npm test -- --runInBand`)
- [x] Testes E2E passam (`docker compose exec nestjs-api npm run test:e2e`)
- [x] Type-check passa (`docker compose exec nestjs-api npx tsc --noEmit`)
- [x] Lint passa (`docker compose exec nestjs-api npm run lint`)
