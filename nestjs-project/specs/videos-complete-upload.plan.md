---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.7
target_file: test/videos.e2e-spec.ts
---

# POST /videos/:id/complete-upload Test Plan

## Application Overview

Endpoint que conclui o multipart upload de um vídeo: valida posse e status `draft`, fecha o multipart upload no storage, transiciona o vídeo para `processing` e enfileira o job `video-processing` para o video-worker.

## Test Scenarios

### 2. POST /videos/:id/complete-upload

**Setup:** `beforeEach` trunca as tabelas via `cleanAllTables(dataSource)`; bootstrap via `Test.createTestingModule({ imports: [AppModule] }).compile()` reproduzindo `ValidationPipe` + filtros globais de `main.ts`; helper `registerConfirmAndLogin(email)` para obter `access_token` de dois usuários distintos (dono e um segundo canal); vídeo em `draft` pré-criado via `POST /videos` do dono para obter `id` e `upload_id` reais.

#### 2.1. conclui-upload-e-enfileira-processamento

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-09-05T22:30:18Z

**Steps:**
  1. POST /videos/:id/complete-upload com `access_token` do dono do vídeo e body `{ parts: [{ part_number, etag }] }`
    - expect: status `202`
    - expect: body `{ id, status: "processing" }`
    - expect: exatamente um job `video-processing` enfileirado na fila (via `Queue.getJobCounts` / `Queue.getJobs`)

#### 2.2. nega-acesso-a-video-de-outro-canal

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-09-05T22:30:18Z

**Steps:**
  1. POST /videos/:id/complete-upload usando o `access_token` de um usuário diferente do dono do vídeo
    - expect: status `403`
    - expect: body `{ error: "VIDEO_ACCESS_DENIED" }`

#### 2.3. rejeita-conclusao-duplicada

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-09-05T22:30:18Z

**Steps:**
  1. POST /videos/:id/complete-upload com `access_token` do dono, chamado uma primeira vez com sucesso
    - expect: status `202` na primeira chamada
  2. Repetir a mesma chamada para o mesmo `id`
    - expect: status `409` na segunda chamada
    - expect: body `{ error: "VIDEO_UPLOAD_ALREADY_COMPLETED" }`

#### 2.4. retorna-404-para-video-inexistente

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-09-05T22:30:18Z

**Steps:**
  1. POST /videos/:id/complete-upload com `access_token` válido e um `id` (uuid) que não existe
    - expect: status `404`
    - expect: body `{ error: "VIDEO_NOT_FOUND" }`
