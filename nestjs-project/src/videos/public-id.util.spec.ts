import { generateVideoPublicId } from './public-id.util';

describe('generateVideoPublicId', () => {
  it('produces an 11-char base64url string', () => {
    const id = generateVideoPublicId();
    expect(id).toMatch(/^[A-Za-z0-9_-]{11}$/);
  });

  it('does not produce collisions across 10k samples', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 10_000; i++) {
      ids.add(generateVideoPublicId());
    }
    expect(ids.size).toBe(10_000);
  });
});
