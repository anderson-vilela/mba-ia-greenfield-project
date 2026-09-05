---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.6
target_file: test/videos.e2e-spec.ts
---

# POST /videos Test Plan

## Application Overview

Endpoint que inicia o upload de um vídeo: cria o registro em `draft` no canal do usuário autenticado, abre o multipart upload no storage e retorna as URLs assinadas por parte para o cliente enviar os bytes diretamente ao object storage.

## Test Scenarios

### 1. POST /videos (iniciar upload)

**Setup:** `beforeEach` trunca as tabelas via `cleanAllTables(dataSource)`; bootstrap via `Test.createTestingModule({ imports: [AppModule] }).compile()` reproduzindo manualmente `ValidationPipe` e os filtros globais (`DomainExceptionFilter`, `ValidationExceptionFilter`) de `main.ts`; helper `registerConfirmAndLogin(email)` (registra, confirma e-mail e loga) para obter `access_token` — o registro já cria o canal do usuário automaticamente.

#### 1.1. retorna-201-com-upload-multipart-response

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-09-05T22:30:18Z

**Steps:**
  1. POST /videos com `access_token` válido e body `{ filename, content_type, file_size }` dentro dos limites configurados
    - expect: status `201`
    - expect: body contém `id` (uuid), `public_id`, `upload_id` e `parts` (array de `{ part_number, url }`, uma entrada por parte)

#### 1.2. rejeita-arquivo-acima-do-limite

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-09-05T22:30:18Z

**Steps:**
  1. POST /videos com `access_token` válido e `file_size` acima do máximo configurado
    - expect: status `413`
    - expect: body `{ error: "UPLOAD_FILE_TOO_LARGE" }`

#### 1.3. rejeita-content-type-nao-suportado

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-09-05T22:30:18Z

**Steps:**
  1. POST /videos com `access_token` válido e `content_type` fora da lista de MIME types aceitos
    - expect: status `415`
    - expect: body `{ error: "UNSUPPORTED_MEDIA_TYPE" }`

#### 1.4. exige-autenticacao

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-09-05T22:30:18Z

**Steps:**
  1. POST /videos sem header `Authorization`, com body válido
    - expect: status `401`
