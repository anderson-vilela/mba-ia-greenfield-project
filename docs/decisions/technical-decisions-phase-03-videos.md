---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-09-05
scope_description: "Backend foundation for large video uploads and background processing: queue technology, 10GB upload strategy, object storage layout, video worker packaging, FFmpeg toolchain, unique video URL, streaming/download delivery, status lifecycle on processing failure, and test isolation for the new infrastructure."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — owns every TD in this document: the videos module, the new object storage / queue / worker services in `compose.yaml`, the videos migration and entity, and the upload/streaming/download endpoints.
- `next-frontend/` — **no open decision in this document.** Phase 03's capability list in `docs/project-plan.md` contains no screen: the video UI (upload form, management panel, player page) belongs to Phases 04, 05 and 07. The upload contract decided in TD-02/TD-03 is deliberately written as a client-agnostic REST handshake so the future frontend consumes it without reopening these decisions.

---

## TD-01: Background Processing Queue Technology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** `docs/project-plan.md` and `docs/diagrams/software-arch.mermaid` both leave the queue as `TBD` — this is the only genuinely open stack decision of the phase. The queue carries one job type (process an uploaded video), must survive API restarts, must retry a failed FFmpeg run, and must be observable as a real service in `docker compose`. The current stack has PostgreSQL 17 and no Redis. Installed constraints: NestJS 11, Node 25.6 (`Dockerfile.dev`), `pg@^8.20`.

**Options:**

### Option A: BullMQ (Redis backend) via `@nestjs/bullmq`
- `bullmq@6.3.4` with `@nestjs/bullmq@12.0.0` (peer range `@nestjs/common ^10||^11||^12`, `bullmq ^3||^4||^5||^6` — compatible with the installed Nest 11). Adds one Redis-compatible service to Compose (`redis:8.8.2`, AGPLv3 since Redis 8, or `valkey/valkey`, which BullMQ runs its full test suite against).
- **Pros:** Official NestJS integration (`BullModule.registerQueue`, `@Processor` + `WorkerHost`). Retries with exponential backoff, rate limiting, delayed jobs, and failed-job retention are built in. The queue is unmistakably a real service in `docker compose`. Largest ecosystem and documentation surface.
- **Cons:** Adds a second datastore to operate and to back up. Job state lives outside PostgreSQL, so a job and its `videos` row cannot be written in one transaction.

### Option B: BullMQ 6 with the PostgreSQL backend
- BullMQ 6 introduced the `IQueueBackend` abstraction and ships `createPostgresBackend`, running the identical Queue/Worker API on PostgreSQL (tables + SQL functions for atomicity, `LISTEN/NOTIFY` for blocking waits, PG 13+). No new service in Compose.
- **Pros:** Zero new infrastructure — reuses the existing `db` service. Same BullMQ API and features as Option A. Job state is in the same database as the `videos` table.
- **Cons:** BullMQ 6.0.0 shipped 2026‑07‑30 — five weeks old, and the Postgres backend is its newest surface. `@nestjs/bullmq@12` builds `Queue`/`Worker` without forwarding a backend factory, so the backend can only be selected process-wide via `setDefaultBackendFactory(createPostgresBackend)` — a path the Nest wrapper does not document. Makes "queue running in Compose" less legible to a reviewer.

### Option C: pg-boss
- `pg-boss@12.30.0` — a mature PostgreSQL-native queue built on `SKIP LOCKED`, with retry policies, dead-letter queues (since v10) and `deleteAfterSeconds` retention. Requires Node ≥ 22.12 (container has 25.6) and `pg ^8.23` (satisfied by the project's `^8.20` caret range).
- **Pros:** No new infrastructure. Exactly-once semantics with atomic commits against the existing Postgres. Dead-letter queues are first-class. Very stable API, years of production use.
- **Cons:** No official NestJS integration — module, lifecycle wiring and typed job payloads must be hand-rolled. Its schema is managed by pg-boss's own migrator, living alongside (and independent from) the project's TypeORM migrations. Same reviewer-legibility caveat as Option B.

### Option D: RabbitMQ via `@nestjs/microservices`
- A dedicated AMQP broker service in Compose, consumed with Nest's microservice transport or `amqplib`.
- **Pros:** Purpose-built broker, unambiguous as infrastructure, strong routing/DLX model, decouples worker from API deployment.
- **Cons:** Heaviest operational footprint for a single job type. Retry/backoff is not built in — it must be assembled from dead-letter exchanges and TTL queues. No job-state introspection without extra tooling; the worker would re-implement what BullMQ/pg-boss give for free.

**Recommendation:** **Option A (BullMQ + Redis/Valkey via `@nestjs/bullmq`)** — it is the only option that combines a first-party NestJS integration with retry/backoff/DLQ semantics the phase needs (TD-11), and it makes the queue an explicit Compose service, which the phase's deliverables call for. Option B is the same library without the extra container, but a five-week-old backend reached through an undocumented `setDefaultBackendFactory` escape hatch is the wrong place to spend risk in a phase this large; it becomes the natural migration target once BullMQ 6's Postgres backend matures. The lost transactional coupling between job and `videos` row is handled by the idempotent status transitions in TD-11, not by the queue.

**Decision:** A — Redis-compatible backend container is `valkey/valkey` (BSD), not `redis:8` (AGPLv3): BullMQ runs its full test suite against Valkey, and the permissive license avoids re-opening this decision later.
**Libraries:** bullmq, @nestjs/bullmq

---

## TD-02: 10GB Upload Strategy

**Scope:** Backend

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** A 10GB file must reach object storage without occupying an API worker for the duration of the transfer. Two hard constraints frame the options: a single S3 `PutObject` (and therefore a single presigned PUT) is capped at 5GB, so 10GB **requires** multipart; and `docs/diagrams/software-arch.mermaid` already models the browser talking to object storage directly. Whatever is chosen becomes the REST handshake the Phase 04+ frontend implements.

**Options:**

### Option A: S3 Multipart Upload with per-part presigned URLs
- The API creates the video draft, calls `CreateMultipartUpload`, and returns presigned `UploadPart` URLs (`@aws-sdk/s3-request-presigner@3.1127.0`). The client PUTs parts straight to storage and posts back the part/ETag list; the API calls `CompleteMultipartUpload`.
- **Pros:** Bytes never traverse the API — no request timeout, no memory or event-loop pressure. Parts upload in parallel and a failed part is retried individually. Native to S3 and MinIO; identical code path in production S3.
- **Cons:** The client must orchestrate slicing, parallelism and the ETag list. Abandoned multipart uploads accumulate in the bucket and need a lifecycle/cleanup policy. Requires CORS configuration on the storage service.

### Option B: tus resumable upload endpoint
- `@tus/server@2.4.5` + `@tus/s3-store@2.0.6` mounted on the Nest server; the client uses a tus client and the server streams chunks through to S3.
- **Pros:** Resumability across sessions and network loss is protocol-level, not hand-rolled. Server-side validation and progress hooks are natural. Mature client libraries (Uppy).
- **Cons:** Every byte still passes through the API container — the exact load the capability says to avoid, only chunked. Adds a non-Nest HTTP handler with its own routing and auth wiring. Two new dependencies whose upload state must be reconciled with the `videos` table.

### Option C: Streaming proxy through the API
- A `multipart/form-data` endpoint pipes the request stream into `@aws-sdk/lib-storage`'s `Upload` (which does multipart internally), e.g. via busboy.
- **Pros:** Simplest client (one plain HTTP request). All validation and auth in one place, no CORS on storage, no presigning.
- **Cons:** One API worker is tied to a 10GB transfer for its whole duration; concurrent uploads starve the API. Needs proxy/body-size limits raised end-to-end. A dropped connection loses the entire upload with no resume.

**Recommendation:** **Option A (multipart + per-part presigned URLs)** — it is the only option where the API's work is O(1) per upload regardless of file size, which is what "sem impacto na performance" means in practice, and it is the shape the C4 diagram already draws (`frontend → storage`). Option C is disqualified by the phase's own failure criteria (passing the 10GB file through the API); Option B moves the bytes back through the API to buy resumability that per-part retry already approximates. Orphaned multipart uploads are handled by an abort/expiry sweep defined with the status lifecycle in TD-11.

**Decision:** A
**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

---

## TD-03: Upload Completion Contract & Processing Trigger

**Scope:** Backend

**Capability:** Transversal — covers: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** With bytes flowing directly to storage (TD-02), the API does not observe the end of the transfer. Something must tell the system "the object is complete" so the draft moves out of `uploading` and a processing job is enqueued. This is the seam between the upload handshake and the queue, and it determines whether a job can be lost or duplicated. Depends on TD-01 and TD-02.

**Options:**

### Option A: Explicit completion endpoint
- The client posts the collected part ETags to `POST /videos/:id/upload/complete`; the API runs `CompleteMultipartUpload`, verifies the object with `HeadObject`, flips the status, and enqueues the processing job in the same request.
- **Pros:** Single, synchronous, testable transition with the authenticated user still in context. Ownership and limits are re-checked before enqueueing. Failure is reported to the client immediately. No extra infrastructure wiring.
- **Cons:** A client that uploads every part and then disappears leaves a draft stuck in `uploading` — needs the reconciliation sweep. Trusts the client to call it.

### Option B: Storage bucket notifications
- MinIO/S3 emits an `s3:ObjectCreated:CompleteMultipartUpload` event to a webhook on the API (or straight to the queue), which resolves the object key back to a video and enqueues the job.
- **Pros:** Triggered by the storage's own truth, not by client cooperation. Catches uploads completed out-of-band.
- **Cons:** Requires notification targets configured in the storage service and an unauthenticated (or shared-secret) webhook endpoint. Event delivery is at-least-once and unordered, so the handler must be idempotent anyway. In tests, the whole path depends on storage-side configuration — brittle.

### Option C: Periodic reconciliation only
- A scheduled job lists in-flight uploads and promotes those whose object exists and is complete.
- **Pros:** No client cooperation and no storage configuration. One code path handles both normal and abandoned uploads.
- **Cons:** Processing starts seconds-to-minutes late by construction. Wasteful listing as the bucket grows. Poor UX for the "upload → processing" feedback the platform needs.

**Recommendation:** **Option A, with a scheduled sweep borrowed from Option C for abandoned uploads** — the explicit endpoint keeps the transition inside an authenticated request where ownership, limits and the enqueue can be verified and tested end-to-end with supertest, while the sweep (abort multipart uploads older than the upload TTL, mark the draft failed) closes the only hole it leaves. Option B is deferred: it buys robustness that matters when third parties write to the bucket, which is not the case here, at the cost of storage-side configuration that would have to be reproduced in every test environment.

**Decision:** A — endpoint explícito de conclusão do upload, com varredura periódica (sweep) para abortar uploads multipart abandonados e marcar o rascunho como failed.

---

## TD-04: Local S3-Compatible Storage Image

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** The storage *interface* is settled — S3-compatible, MinIO locally, S3 in production — and is not reopened here. What is open is which image the `storage` service in `nestjs-project/compose.yaml` actually runs, because MinIO's repository was archived in April 2026 and its official Docker images stopped being published: the newest `minio/minio` tag on Docker Hub is `RELEASE.2025-09-07T16-13-09Z`, still pullable but frozen. Every TD in this document that touches storage (TD-02, TD-05, TD-09, TD-10) assumes the S3 API, so this decision is about the container, not the protocol.

**Options:**

### Option A: Pin `minio/minio:RELEASE.2025-09-07T16-13-09Z`
- Keep MinIO, pinned to the last published release, with the S3 API surface the project already targets.
- **Pros:** The reference implementation for local S3 in the Node ecosystem — multipart, presigned URLs, bucket notifications, and the `mc` client all work as documented. Pinning makes the dev environment reproducible. Zero migration cost if production uses real S3.
- **Cons:** Frozen image — no security patches or fixes. The `mc` bootstrap client has the same problem. Long-term dead end for anything beyond local development.

### Option B: RustFS
- Apache-2.0 MinIO-shaped replacement (`rustfs/rustfs`, currently `1.0.0-rc.5`, pushed 2026‑09‑02), same S3 API and `mc` compatibility.
- **Pros:** Actively maintained, drop-in deployment model, permissive license, small image.
- **Cons:** Still a release candidate — not a stable baseline for a graded deliverable. Less battle-tested against S3 SDK edge cases (multipart + presigned + CORS is exactly the combination this phase leans on).

### Option C: SeaweedFS or Garage
- Mature self-hosted object stores with S3-compatible gateways.
- **Pros:** Actively maintained, production-grade, permissive licenses.
- **Cons:** Different operational model (filer/gateway topology, layout config) — more Compose surface for no benefit at this scale. S3 compatibility is good but partial; multipart + presigned behaviour needs verification per implementation.

**Recommendation:** **Option A (pinned MinIO)** — the phase's risk budget belongs in the queue and the upload handshake, not in re-validating multipart/presigned/CORS semantics against a release candidate. Pinning the last published tag keeps the environment reproducible today, and because everything above the container is plain S3 API through `@aws-sdk/client-s3`, swapping to RustFS (or to real S3) later is a Compose-level change plus an endpoint env var. Record the frozen-image caveat in the phase's `library-refs.md` so the constraint is not rediscovered later.

**Decision:** A — `minio/minio:RELEASE.2025-09-07T16-13-09Z` pinado; imagem congelada, sem patches — anotado em `library-refs.md`.

---

## TD-05: Bucket & Key Organization

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** Videos and thumbnails have different access profiles: a thumbnail is small, served in grids (Phases 04/07) and harmless to expose; a video source is large and its access must be controlled. The bucket/key layout is written by the API (upload), read and written by the worker (thumbnail), read by the delivery endpoints (TD-09/TD-10), and bootstrapped by Compose — so it is a contract, not an implementation detail. It also determines whether cleanup on delete is a prefix operation or a per-object hunt.

**Options:**

### Option A: Single bucket, type prefixes
- One bucket (e.g. `streamtube`), keys like `videos/{videoId}/source.{ext}` and `thumbnails/{videoId}/default.jpg`.
- **Pros:** One bucket to create and configure. Deleting a video is a prefix delete. Simplest env surface (one bucket name).
- **Cons:** One access policy for both content types — either everything is private (thumbnails need a signed URL per grid item) or everything is public. Lifecycle rules must be written per prefix.

### Option B: Separate buckets by content type
- `streamtube-videos` (private) and `streamtube-thumbnails` (anonymous read), keys `{videoId}/source.{ext}` and `{videoId}/default.jpg`.
- **Pros:** Access policy matches the content: video bytes always mediated by the API, thumbnails served by plain cacheable URLs — which the video grids of Phases 04 and 07 need without signing N URLs per page. Independent lifecycle/retention rules. Cleanup is still a prefix delete inside each bucket.
- **Cons:** Two buckets to bootstrap and two env vars. A public bucket is a deliberate exposure that must be documented.

### Option C: Bucket per video state (raw / processed)
- `streamtube-raw` for the uploaded source, `streamtube-processed` for derived artifacts, with a copy on promotion.
- **Pros:** Clean separation between untrusted input and validated output; the raw bucket can expire aggressively.
- **Cons:** Copying a 10GB object between buckets to change its state is expensive and pointless while there is no transcoding step. Two sources of truth for "where is this video's file".

**Recommendation:** **Option B (separate buckets by content type)** — the access profiles genuinely differ, and paying for that split now avoids either signing a URL per thumbnail in every future grid or making video sources public. Keys stay `{videoId}/…` in both buckets, so deletion and reconciliation are prefix operations. Option C's raw/processed split earns its cost only when transcoding exists, which this phase explicitly does not include.

**Decision:** B

---

## TD-06: Video Worker Packaging & Runtime

**Scope:** Backend

**Capability:** Transversal — covers: "Serviço de processamento em segundo plano (filas)", "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** The C4 diagram models the worker as a separate container from the API. It needs FFmpeg binaries (which the API image does not have and should not carry), the TypeORM entities to update video rows, and the storage client — but it must never serve HTTP. How it is packaged decides how code is shared, how it is built, and how tests reach it. Depends on TD-01.

**Options:**

### Option A: Same codebase, second Compose service, standalone Nest context
- A `video-worker` service built from the same `nestjs-project` image (plus FFmpeg), started with a different command that boots `NestFactory.createApplicationContext(WorkerModule)` — DI, config, TypeORM and the BullMQ processor, no HTTP listener.
- **Pros:** Entities, config, `DomainException` and repositories are shared by import, with no package boundary or duplication. One `npm install`, one `tsc`, one lint run — the Definition of Done stays a single command set. Scales independently (replicas) and crashes independently from the API.
- **Cons:** The worker image needs FFmpeg while the API image does not — either a second Dockerfile stage/target or one slightly fatter shared image. Worker code lives in the API repo, so an unguarded import could pull HTTP concerns into it.

### Option B: Separate subproject at the repo root
- A new top-level directory with its own `package.json`, TypeScript config and Dockerfile, consuming the queue and duplicating (or sharing via a workspace package) the entities.
- **Pros:** Hard boundary — the worker cannot import controllers. Independent dependency set and release cadence. Closest to how it would be deployed as a standalone service.
- **Cons:** Entity/config duplication or a monorepo workspace layer the repo does not have today. Multiplies the Definition of Done (a second test/tsc/lint pipeline) and the CI surface, for one job type.

### Option C: In-process worker inside the API
- The API registers the BullMQ processor in its own container; no separate service.
- **Pros:** Nothing new in Compose; simplest wiring.
- **Cons:** A CPU-bound FFmpeg run competes with request handling in the same container, which is the load profile the phase exists to avoid. Puts FFmpeg in the API image. The phase's deliverables call for a worker service in `docker compose`.

**Recommendation:** **Option A (same codebase, separate container, standalone context)** — it satisfies the architectural requirement (worker isolated from the API, visible in Compose, independently scalable) at the cost of one Dockerfile target, while keeping entities and config shared by plain imports so the single Definition of Done pipeline still covers everything. Option B's package boundary is real but buys isolation the project cannot yet pay for in tooling; Option C contradicts the phase's own performance goal.

**Decision:** A

---

## TD-07: Media Toolchain for Metadata Extraction & Thumbnail Generation

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** The worker must read duration/codec/resolution and cut one frame to a JPEG. FFmpeg does both, but how Node drives it is open — and the obvious answer changed recently: `fluent-ffmpeg` was archived in May 2025 and is flagged deprecated on npm (`2.1.3`, "Package no longer supported"), with `ffmpeg-kit` retired in June 2025. Depends on TD-06 (which image carries the binaries).

**Options:**

### Option A: `child_process.spawn` on system FFmpeg
- The worker image installs `ffmpeg` via apt (the base image is `node:25.6.0-slim`, Debian); the code spawns `ffprobe -v quiet -print_format json -show_format -show_streams` and `ffmpeg -ss <t> -frames:v 1`, parsing stdout and resolving on `close`.
- **Pros:** No dependency that can be deprecated under the project. Full control over arguments, timeouts and cancellation. Streams output instead of buffering, and never blocks the event loop. The binary is pinned by the image, identical in dev and CI.
- **Cons:** Argument construction and error parsing are hand-written (contained: two commands). Arguments must never be built from unvalidated user input. Grows the worker image by the FFmpeg install.

### Option B: `fluent-ffmpeg`
- The historically standard fluent wrapper around the same binaries.
- **Pros:** Ergonomic chained API, built-in `ffprobe()` helper and `screenshots()` for thumbnails, abundant examples.
- **Cons:** Archived and npm-deprecated since May 2025 — no fixes, no security patches, and known incompatibilities with recent FFmpeg builds. Adopting it in a greenfield phase in 2026 imports a dead dependency into the critical path.

### Option C: npm-bundled static binaries (`ffmpeg-static` + `ffprobe-static`)
- Binaries installed as npm packages instead of via the OS.
- **Pros:** No Dockerfile change; version pinned in `package.json`; same binary everywhere.
- **Cons:** `ffprobe-static` has not been published since 2022 and `@ffprobe-installer/ffprobe` since 2023 — the probe half of the toolchain is as stale as Option B. Large binaries in `node_modules`, downloaded per install, with platform-specific resolution.

**Recommendation:** **Option A (`spawn` on system FFmpeg)** — with `fluent-ffmpeg` archived and the static-binary probe packages abandoned, the only maintained path is the OS package plus two well-understood command invocations, which is also what the wrapper did underneath. Concretely: `ffprobe` JSON output for duration/codec/resolution, and a single frame at a fixed fraction of the duration (≈10%, avoiding black leader frames) scaled to a 1280×720 JPEG. Arguments are built exclusively from server-side values (storage paths and computed timestamps), never from client input.

**Decision:** A

---

## TD-08: Unique Video URL Identifier Strategy

**Scope:** Backend

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Every video needs a short, collision-free public identifier — `docs/project-plan.md` flags it as an attention point ("URL curta e única que nunca conflite"). It is used in the watch URL, the streaming/download endpoints (TD-09/TD-10) and the future frontend routes, so its shape is a contract. Project convention (`.claude/rules/nestjs-entities.md`) already mandates a UUID primary key, so this decides what goes in the URL, not what the PK is.

**Options:**

### Option A: Expose the UUID primary key
- The watch URL carries the entity's `uuid`.
- **Pros:** Zero new columns, zero generation logic, uniqueness guaranteed by the PK. Already the project's identifier convention.
- **Cons:** 36 characters — long and unfriendly in a URL meant to be shared. Leaks nothing sensitive, but sets a URL shape no video platform uses.

### Option B: Dedicated short id column generated from `node:crypto`
- An 11-character base64url string (66 bits) in a `public_id` column with a unique index, generated with `randomBytes` — the YouTube-shaped URL, no dependency.
- **Pros:** Short and shareable. 64¹¹ ≈ 7.3×10¹⁹ possibilities — collisions are negligible, and the unique index turns the residual case into a retry rather than a corruption. No dependency to age (notably avoiding `nanoid`, whose current 6.x is ESM-only and would fight the project's CommonJS build). Decouples the public URL from the internal PK.
- **Cons:** One extra column, one extra index, and a generate-and-retry path to write and test.

### Option C: Title slug + disambiguating suffix
- `meu-video-de-ferias-a1b2c3` derived from the title.
- **Pros:** Human-readable, marginally better for SEO.
- **Cons:** The title is editable in Phase 04 — either the URL changes (breaking shared links) or the slug drifts from the title. Requires normalization, collision handling and profanity/edge-case handling. The draft is created before a title exists (TD-03), so the identifier cannot be derived at creation time.

**Recommendation:** **Option B (dedicated `public_id`, 11-char base64url from `node:crypto`)** — the capability asks for a short URL that never conflicts, and a random id in its own uniquely-indexed column gives exactly that while staying immutable across the Phase 04 title edits that would invalidate Option C. Using `node:crypto` instead of a generator package keeps the CommonJS build clean and adds nothing to the dependency surface; the UUID PK stays internal, unchanged.

**Decision:** B

---

## TD-09: Video Streaming Delivery Strategy

**Scope:** Backend

**Capability:** Reprodução via streaming (sem necessidade de download completo)

**Context:** Playback must start without downloading the whole file and must support seeking — i.e. HTTP range requests answered with `206 Partial Content`. The bytes live in object storage (TD-05), which already speaks ranges natively; the decision is who the player talks to. The C4 diagram draws `frontend → Object Storage: Streams`, so the intended shape is on record. Anonymous viewing is a Phase 05 capability, but the mechanism chosen here must not preclude it.

**Options:**

### Option A: Redirect to a short-lived presigned GET
- `GET /videos/:publicId/stream` authorizes, then answers `302` with a presigned URL; the player issues its range requests straight to storage.
- **Pros:** Range/`206`/seeking handled by the storage engine — nothing to implement or get wrong. API cost is O(1) per playback session regardless of file size; no video bytes through the API. Matches the architecture diagram and works unchanged against real S3/CDN.
- **Cons:** The signed URL is shareable until it expires (mitigated by a short TTL). Access control is checked once, at signing time. Requires CORS on the storage service. Per-view accounting must happen at the signing endpoint, not per byte.

### Option B: Proxy range requests through the API
- The endpoint parses `Range`, issues `GetObjectCommand` with the same range, and pipes the body back as `206` via `StreamableFile`.
- **Pros:** Storage stays entirely private and never faces the browser. Full per-request control: authorization, unlisted-video rules (Phase 05), view counting, throttling. No CORS on storage.
- **Cons:** Every played byte crosses the API container — the same load profile TD-02 rejected for uploads, now on the read path and for every concurrent viewer. Range parsing, `Content-Range`/`Accept-Ranges` correctness and stream cleanup become the project's responsibility.

### Option C: Transcode to HLS and serve a playlist
- The worker segments the video into HLS renditions; the player fetches `.m3u8` + segments.
- **Pros:** Adaptive bitrate, the industry standard for real platforms, segments cache well on a CDN.
- **Cons:** Transcoding is explicitly outside this phase (processing means metadata + thumbnail). Multiplies storage, processing time and worker complexity. Solves a problem — variable bandwidth — the phase never states.

**Recommendation:** **Option A (redirect to a short-lived presigned GET)** — it delivers seekable streaming with correct `206` semantics for free, keeps the API out of the byte path, and is exactly the relationship the C4 diagram already models. The shareable-URL window is bounded by a short expiry (minutes) configured as an env var, and the authorization check at the signing endpoint is where Phase 05's unlisted/anonymous rules will attach. Option B remains the fallback if a later phase needs per-byte control; Option C is out of scope.

**Decision:** A

---

## TD-10: Video Download Delivery

**Scope:** Backend

**Capability:** Download do vídeo pelo usuário

**Context:** The platform offers an explicit download of the video file, distinct from playback: the browser must save a file with a sensible name rather than open a player. The byte path was decided in TD-09; what is open is how "save as a named file" is expressed and whether download and streaming share an endpoint. Depends on TD-09.

**Options:**

### Option A: Presigned GET with response-header overrides
- `GET /videos/:publicId/download` returns a `302` to a presigned URL carrying `response-content-disposition=attachment; filename="<title>.mp4"` (and `response-content-type`), signed by the API.
- **Pros:** Reuses TD-09's mechanism exactly — one storage-access code path, no bytes through the API. The saved filename is derived server-side from the video title at signing time. Distinct endpoint gives a natural hook for download counting or future permission rules.
- **Cons:** Depends on the S3 response-header override parameters (supported by S3 and MinIO, but one more compatibility surface). The signed URL is shareable for its TTL, as in TD-09.

### Option B: Proxy the object through the API with `Content-Disposition`
- The endpoint fetches the object and pipes it back with an attachment header.
- **Pros:** Full control over headers, auditing and rate limiting; storage stays private.
- **Cons:** Ties an API worker to a full 10GB transfer — the load profile rejected in TD-02 and TD-09, and worse here because a download has no ranges to break it up.

### Option C: No dedicated endpoint — reuse the streaming URL
- The client points a download link at the stream endpoint.
- **Pros:** Nothing to build.
- **Cons:** No control over the saved filename (the storage key leaks into it), no way to distinguish a view from a download, and the semantics of the two actions collapse into one route.

**Recommendation:** **Option A (presigned GET with `response-content-disposition`)** — it keeps a single storage-access strategy across streaming and download while still giving the download its own authorized endpoint, its own TTL and a filename derived from the video title. Option B reintroduces the byte-path problem the phase is built to avoid; Option C gives up the filename and the ability to ever count downloads separately.

**Decision:** A

---

## TD-11: Video Status Lifecycle & Processing Failure Policy

**Scope:** Backend

**Capability:** Transversal — covers: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** A video row is created before its bytes exist and is mutated by two independent actors (the API on upload events, the worker on processing events). The status column is what the future management panel (Phase 04) renders and what the delivery endpoints (TD-09/TD-10) gate on, so its values and transitions are a contract. Processing can fail for reasons that are permanent (corrupt file, unsupported codec) or transient (worker restart, storage blip), and the two must not be treated alike. Depends on TD-01 and TD-03.

**Options:**

### Option A: Single status enum with a failure reason
- One column over `draft → uploading → processing → ready | failed`, plus a nullable `failure_reason`. Retries are the queue's (bounded attempts with exponential backoff); only exhausted attempts write `failed`. Transitions are idempotent and guarded by the expected current state.
- **Pros:** One source of truth, trivially indexable and renderable. Maps directly onto BullMQ attempt semantics — a transient error stays inside the job while `processing` remains visible to the user. `failed` is reached only once the queue gives up, so it means the same thing every time. Idempotent guards absorb the at-least-once delivery TD-01's Option A implies.
- **Cons:** No per-attempt history — only the last failure reason survives. Distinguishing "never processed" from "retrying" requires reading job state from the queue.

### Option B: Separate upload state and processing state columns
- One column tracks the file (`pending/uploading/stored`), another tracks processing (`queued/running/done/error`).
- **Pros:** Each actor owns its own column, so concurrent writes never contend. Richer diagnostics.
- **Cons:** Two columns to keep consistent and a derived "what does the user see" rule in every consumer. Illegal combinations become representable (`pending` file + `done` processing). More surface for Phase 04's panel to get wrong.

### Option C: Status column plus a processing-events table
- The enum of Option A, with every attempt/transition appended to a `video_processing_events` table.
- **Pros:** Full audit trail; per-attempt debugging; groundwork for a future progress UI.
- **Cons:** A whole extra entity, migration and lifecycle for observability the phase never asks for — BullMQ already retains failed jobs with their errors.

**Recommendation:** **Option A (single enum + `failure_reason`, retries owned by the queue)** — it gives the management panel and the delivery endpoints one unambiguous field to read, and it puts the transient/permanent distinction where it belongs: transient failures are absorbed by bounded queue retries (3 attempts, exponential backoff) while the row stays `processing`; the row becomes `failed` only when the job is exhausted or the file is definitively unusable, with the reason recorded. Every transition is written as a guarded, idempotent update so a redelivered job cannot regress a `ready` video. The abandoned-upload sweep from TD-03 uses the same terminal `failed` state.

**Decision:** A

---

## TD-12: Upload Validation & Limits Policy

**Scope:** Backend

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** Presigned URLs (TD-02) hand the client a direct write into the bucket, so the API cannot inspect the bytes on the way in. The limits — maximum size, accepted container/codec, part size, URL and upload expiry — must therefore be enforced at the edges (before signing and after completion), and they are referenced from at least three places that must agree: the Joi env schema, the presign/complete endpoints, and the worker. Depends on TD-02 and TD-03.

**Options:**

### Option A: Declared-then-verified
- The client declares filename, size and content type; the API validates them against configured limits before signing, and after completion verifies the object with `HeadObject` (real size) plus the worker's `ffprobe` result (real container/codec/duration), failing the video if reality contradicts the declaration.
- **Pros:** Bad requests are rejected before a single byte is uploaded (fast feedback, no wasted storage), while the post-upload verification means the declaration is never trusted. Uses data the pipeline already produces — `HeadObject` in TD-03, `ffprobe` in TD-07 — so it costs almost nothing extra. Limits live in env (Joi-validated) and are read by both API and worker.
- **Cons:** Two enforcement points to keep aligned. A client can still upload garbage up to the size limit before it is caught.

### Option B: Post-upload verification only
- Sign whatever is asked; decide validity when the worker probes the file.
- **Pros:** Fewer moving parts; a single source of truth (the actual file).
- **Cons:** A 10GB unsupported file is fully transferred and stored before rejection. No early feedback for the user. Storage cost and cleanup burden for input that was invalid from the start.

### Option C: Enforce at the storage layer with a signed POST policy
- Use `createPresignedPost` with a `content-length-range` condition so the storage itself rejects oversized uploads.
- **Pros:** The limit is cryptographically bound to the upload; the client cannot exceed it.
- **Cons:** POST policies apply to single-request uploads, not to the multipart flow chosen in TD-02 — the mechanism does not exist for per-part presigned URLs. Would force abandoning Option A of TD-02 and its 5GB ceiling.

**Recommendation:** **Option A (declare-then-verify)** — it is the only option compatible with the multipart handshake that still rejects obviously invalid uploads before the transfer, and its verification step reuses artifacts the pipeline already produces. Concretely: max size, accepted MIME types, multipart part size, presigned-URL TTL and abandoned-upload TTL become env vars validated by the existing Joi schema (`src/config/env.validation.ts`) and surfaced through a namespaced config, so API, worker and Compose read the same numbers. Mismatch between declared and actual is a `failed` video per TD-11, not a silent pass.

**Decision:** A

---

## TD-13: Test Isolation Strategy for Storage & Queue Infrastructure

**Scope:** Backend

**Capability:** Transversal — covers: "Serviço de armazenamento de arquivos (vídeos e thumbnails)", "Serviço de processamento em segundo plano (filas)"

**Context:** The project already settles *whether* to use real infrastructure in tests — `.claude/skills/testing-guide-nestjs-project` prescribes real capture services for side-effect dependencies (the Mailpit precedent), and `nestjs-project/CLAUDE.md` mandates `--runInBand` because suites share one database. What is open is how the two **new** stateful services are isolated: the integration and e2e suites will create objects and enqueue jobs against the same MinIO and queue that the dev environment uses, and leftovers from one suite must not be visible to the next or to the developer. This spans `compose.yaml`, `.env`/`.env.example`, the Joi schema and the test helpers, so it is a contract rather than a per-test choice.

**Options:**

### Option A: Dedicated test namespaces on the same services
- Test-only bucket names and a test queue prefix, supplied via env; a helper creates them on setup and empties/removes them in `afterAll`, mirroring `cleanAllTables` in `src/test/create-test-data-source.ts`.
- **Pros:** No new services, no new tooling — the existing Compose stack is enough, matching the Mailpit precedent. Cleanup is explicit and reviewable. Dev artifacts and test artifacts never mix, so a failed run cannot poison the dev environment. Works identically inside the container, which is where all commands run.
- **Cons:** Cleanup must actually be written (an aborted run can leave a test bucket behind). Isolation is by convention, not enforced by the platform.

### Option B: Ephemeral containers per suite (Testcontainers)
- Each suite spins up its own MinIO/queue container.
- **Pros:** Perfect isolation; no shared state at all; no cleanup code.
- **Cons:** Requires Docker access from inside the `nestjs-api` container (docker-in-docker or socket mounting) — a significant change to how this project runs commands. Adds container startup time to every suite. Contradicts the "everything runs in the Compose container" rule the project enforces.

### Option C: Share dev resources, isolate by key prefix only
- Tests write into the dev buckets under a `test/` prefix and use the same queue.
- **Pros:** Least setup; no extra env vars.
- **Cons:** Test jobs and dev jobs land in the same queue, so a running dev worker can consume test jobs (and vice versa) — cross-contamination that produces flaky, hard-to-diagnose failures. Test objects pollute the dev bucket listing.

**Recommendation:** **Option A (dedicated test namespaces on the shared Compose services)** — it extends the pattern the project already uses for the database and Mailpit, needs nothing beyond env vars and a setup/teardown helper, and keeps every command inside the container as `nestjs-project/CLAUDE.md` requires. Option C's shared queue is the specific failure mode worth spending setup code to avoid: a dev worker silently eating a test job. Option B's isolation is stronger but would require docker-in-docker, which the project's execution model rules out.

**Decision:** A

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Background processing queue technology | A — BullMQ + Redis/Valkey via `@nestjs/bullmq` | **A (BullMQ + Valkey via `@nestjs/bullmq`)** |
| TD-02 | Backend | 10GB upload strategy | A — S3 multipart with per-part presigned URLs | **A (S3 multipart + per-part presigned URLs)** |
| TD-03 | Backend | Upload completion contract & processing trigger | A — Explicit completion endpoint + abandoned-upload sweep | **A (Explicit completion endpoint + abandoned-upload sweep)** |
| TD-04 | Backend | Local S3-compatible storage image | A — Pinned `minio/minio:RELEASE.2025-09-07T16-13-09Z` | **A (Pinned `minio/minio:RELEASE.2025-09-07T16-13-09Z`)** |
| TD-05 | Backend | Bucket & key organization | B — Separate buckets by content type | **B (Separate buckets by content type)** |
| TD-06 | Backend | Video worker packaging & runtime | A — Same codebase, separate container, standalone Nest context | **A (Same codebase, separate container, standalone Nest context)** |
| TD-07 | Backend | Media toolchain (metadata + thumbnail) | A — `child_process.spawn` on system FFmpeg/ffprobe | **A (`child_process.spawn` on system FFmpeg/ffprobe)** |
| TD-08 | Backend | Unique video URL identifier | B — Dedicated `public_id`, 11-char base64url from `node:crypto` | **B (Dedicated `public_id` via `node:crypto`)** |
| TD-09 | Backend | Streaming delivery strategy | A — Redirect to short-lived presigned GET | **A (Redirect to short-lived presigned GET)** |
| TD-10 | Backend | Video download delivery | A — Presigned GET with `response-content-disposition` | **A (Presigned GET with `response-content-disposition`)** |
| TD-11 | Backend | Status lifecycle & processing failure policy | A — Single enum + `failure_reason`, retries owned by the queue | **A (Single enum + `failure_reason`)** |
| TD-12 | Backend | Upload validation & limits policy | A — Declare-then-verify | **A (Declare-then-verify)** |
| TD-13 | Backend | Test isolation for storage & queue | A — Dedicated test namespaces on shared Compose services | **A (Dedicated test namespaces on shared Compose services)** |
