import { describe, it, expect } from 'vitest';
import { generateBoxKey, generateSenderKey, fingerprintOf, sealBundle, openBundle, signSealed, verifySealed } from './seal.js';
import type { AgentLoginBundle, SealedBundle } from './types.js';

const sender = generateSenderKey();
const bundle: AgentLoginBundle = {
  issuedAt: 1_700_000_000_000,
  claude: { token: 'sk-ant-oat01-TOKEN', oauthAccount: { emailAddress: 'a@b.c' }, lastOnboardingVersion: '2.0.0' },
  codex: { apiKey: 'sk-codex' },
  opencode: { providers: { openai: { type: 'api', key: 'sk-oc' } } },
};

function flip(b64: string): string {
  const buf = Buffer.from(b64, 'base64');
  buf[0]! ^= 1;
  return buf.toString('base64');
}

describe('agent login sealing', () => {
  it('round-trips a bundle', () => {
    const k = generateBoxKey();
    expect(openBundle(sealBundle(bundle, k.publicKey, sender.privateKey), k.privateKey, k.publicKey)).toEqual(bundle);
  });

  it('rejects a flipped ct byte', () => {
    const k = generateBoxKey();
    const sealed = sealBundle(bundle, k.publicKey, sender.privateKey);
    expect(() => openBundle({ ...sealed, ct: flip(sealed.ct) }, k.privateKey, k.publicKey)).toThrow('sealed bundle rejected');
  });

  it('rejects a bundle sealed to another key', () => {
    const k = generateBoxKey();
    const other = generateBoxKey();
    const sealed = sealBundle(bundle, other.publicKey, sender.privateKey);
    expect(() => openBundle(sealed, k.privateKey, k.publicKey)).toThrow('sealed bundle rejected');
  });

  it('rejects malformed fields', () => {
    const k = generateBoxKey();
    const sealed = sealBundle(bundle, k.publicKey, sender.privateKey);
    expect(() => openBundle({ ...sealed, epk: 'AAAA' }, k.privateKey, k.publicKey)).toThrow('sealed bundle rejected');
    expect(() => openBundle({ ...sealed, v: 2 } as unknown as SealedBundle, k.privateKey, k.publicKey)).toThrow(
      'sealed bundle rejected',
    );
  });

  it('fingerprint is stable and formatted', () => {
    const k = generateBoxKey();
    expect(fingerprintOf(k.publicKey)).toBe(fingerprintOf(k.publicKey));
    expect(fingerprintOf(k.publicKey)).toMatch(/^[0-9a-f]{4}(-[0-9a-f]{4}){3}$/);
    expect(fingerprintOf(generateBoxKey().publicKey)).not.toBe(fingerprintOf(k.publicKey));
  });

  it('rejection message never contains plaintext', () => {
    const k = generateBoxKey();
    const sealed = sealBundle({ issuedAt: 1, codex: { apiKey: 'sk-SECRET' } }, k.publicKey, sender.privateKey);
    expect(JSON.stringify(sealed)).not.toContain('SECRET');
    let err: unknown;
    try {
      openBundle({ ...sealed, tag: flip(sealed.tag) }, k.privateKey, k.publicKey);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect(String(err)).not.toContain('SECRET');
  });

  it('signs with the sender key, and verification covers every sealed field', () => {
    const k = generateBoxKey();
    const sealed = sealBundle(bundle, k.publicKey, sender.privateKey);
    expect(sealed.spk).toBe(sender.publicKey);
    expect(Buffer.from(sealed.spk, 'base64')).toHaveLength(32);
    expect(verifySealed(sealed)).toBe(true);
    for (const f of ['epk', 'iv', 'ct', 'tag'] as const) {
      expect(verifySealed({ ...sealed, [f]: flip(sealed[f]) })).toBe(false);
    }
    expect(verifySealed({ ...sealed, sig: flip(sealed.sig) })).toBe(false);
  });

  it('a re-signature by another key verifies only under that key', () => {
    const k = generateBoxKey();
    const sealed = sealBundle(bundle, k.publicKey, sender.privateKey);
    const mallory = generateSenderKey();
    const { spk: _s, sig: _g, ...unsigned } = sealed;
    const resigned = signSealed(unsigned, mallory.privateKey);
    expect(verifySealed(resigned)).toBe(true);
    expect(resigned.spk).toBe(mallory.publicKey);
    // Swapping in the honest spk with mallory's sig fails.
    expect(verifySealed({ ...resigned, spk: sender.publicKey })).toBe(false);
    // A valid signature, but spk is bound into the AAD: it no longer opens.
    expect(() => openBundle(resigned, k.privateKey, k.publicKey)).toThrow('sealed bundle rejected');
  });

  it('verifySealed never throws on junk', () => {
    const k = generateBoxKey();
    const sealed = sealBundle(bundle, k.publicKey, sender.privateKey);
    expect(verifySealed({ ...sealed, spk: 'AAAA' })).toBe(false);
    expect(verifySealed({ ...sealed, sig: '' })).toBe(false);
  });
});
