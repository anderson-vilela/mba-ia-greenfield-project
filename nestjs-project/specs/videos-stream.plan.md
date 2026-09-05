---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.11
target_file: test/videos.e2e-spec.ts
---

# GET /videos/:id/stream Test Plan

## Application Overview

Endpoint público de streaming: redireciona (`302`) para uma presigned GET URL de curto TTL no bucket de vídeos, deixando a entrega dos bytes (incluindo `Range` requests) inteiramente a cargo do object storage.

## Test Scenarios

### 3. GET /videos/:id/stream

**Setup:** `beforeEach` trunca as tabelas via `cleanAllTables(dataSource)`; bootstrap via `Test.createTestingModule({ imports: [AppModule] }).compile()` reproduzindo `ValidationPipe` + filtros globais de `main.ts`; vídeos de teste inseridos diretamente via `Repository<Video>` (bypass do pipeline de processamento) com `status` controlado (`ready`, `draft`, `processing` ou `failed`).

#### 3.1. redireciona-para-url-assinada-quando-ready

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-09-05T22:30:18Z

**Steps:**
  1. GET /videos/:id/stream para um vídeo com `status = 'ready'`, sem `Authorization`
    - expect: status `302`
    - expect: header `Location` presente e apontando para o bucket de vídeos configurado

#### 3.2. rejeita-video-nao-ready

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-09-05T22:30:18Z

**Steps:**
  1. GET /videos/:id/stream para um vídeo com `status` em `draft`, `processing` ou `failed`
    - expect: status `409`
    - expect: body `{ error: "VIDEO_NOT_READY" }`

#### 3.3. retorna-404-para-video-inexistente

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-09-05T22:30:18Z

**Steps:**
  1. GET /videos/:id/stream com um `id` (uuid) que não existe
    - expect: status `404`
    - expect: body `{ error: "VIDEO_NOT_FOUND" }`

#### 3.4. acessivel-sem-autenticacao

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-09-05T22:30:18Z

**Steps:**
  1. GET /videos/:id/stream para um vídeo `ready`, sem header `Authorization`
    - expect: status `302` (não `401`)
