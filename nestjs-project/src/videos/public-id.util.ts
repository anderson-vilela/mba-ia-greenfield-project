import { randomBytes } from 'node:crypto';

/** 11-char base64url string from 8 random bytes (phase-03-videos/TD-08). */
export function generateVideoPublicId(): string {
  return randomBytes(8).toString('base64url');
}
