// Runs after `dotenv/config` in every Jest project (unit, integration and e2e),
// so it overrides whatever `.env` supplied for the dev environment.
//
// TD-13 decided Option A: tests share the Compose services but live in their own
// namespaces. The storage side is covered by STORAGE_TEST_KEY_PREFIX; this file
// covers the queue side. Without a dedicated BullMQ prefix, test jobs land in the
// same keyspace the `video-worker` container consumes, so the dev worker picks up
// (and the suite's `obliterate` deletes) jobs from under each other — the exact
// cross-contamination Option C was rejected for.
process.env.QUEUE_PREFIX = process.env.QUEUE_TEST_PREFIX ?? 'bull-test';
