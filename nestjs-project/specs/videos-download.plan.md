---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.12
target_file: test/videos.e2e-spec.ts
---

# GET /videos/:id/download Test Plan

## Application Overview

Endpoint público de download: redireciona (`302`) para uma presigned GET URL própria no bucket de vídeos, com `response-content-disposition=attachment` e filename derivado do título do vídeo, TTL independente do endpoint de streaming.

## Test Scenarios

### 4. GET /videos/:id/download

**Setup:** `beforeEach` trunca as tabelas via `cleanAllTables(dataSource)`; bootstrap via `Test.createTestingModule({ imports: [AppModule] }).compile()` reproduzindo `ValidationPipe` + filtros globais de `main.ts`; vídeos de teste inseridos diretamente via `Repository<Video>` (bypass do pipeline de processamento) com `status` controlado.

#### 4.1. redireciona-para-url-assinada-com-content-disposition

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-09-05T22:30:18Z

**Steps:**
  1. GET /videos/:id/download para um vídeo com `status = 'ready'` e `title` conhecido, sem `Authorization`
    - expect: status `302`
    - expect: header `Location` contém `response-content-disposition=attachment` com filename baseado em `title`
    - expect: TTL da URL de download é independente do TTL usado por GET /videos/:id/stream

#### 4.2. rejeita-video-nao-ready

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-09-05T22:30:18Z

**Steps:**
  1. GET /videos/:id/download para um vídeo com `status` em `draft`, `processing` ou `failed`
    - expect: status `409`
    - expect: body `{ error: "VIDEO_NOT_READY" }`

#### 4.3. retorna-404-para-video-inexistente

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-09-05T22:30:18Z

**Steps:**
  1. GET /videos/:id/download com um `id` (uuid) que não existe
    - expect: status `404`
    - expect: body `{ error: "VIDEO_NOT_FOUND" }`
