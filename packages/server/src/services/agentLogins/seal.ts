// Seals the agent-login bundle to the runner's X25519 key so the relay only
// ever carries ciphertext. ECIES shape: ephemeral X25519 → HKDF-SHA256 →
// AES-256-GCM, all node:crypto. The AAD binds the recipient's fingerprint, so a
// bundle sealed for one runner cannot be replayed into another, and the
// sender's public key, so a relay that strips the signature and re-signs with
// its own key gets a bundle that no longer opens.
//
// Sealing alone is anonymous — anyone holding the runner's public key can seal
// to it. The laptop's Ed25519 signature over the sealed fields is what lets the
// runner accept bundles only from the laptop it pinned on first use.
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';
import type { AgentLoginBundle, SealedBundle } from './types.js';

const INFO = 'strado-agent-logins:v1';
const REJECTED = 'sealed bundle rejected';

const rawPublic = (k: KeyObject): Buffer => Buffer.from(k.export({ format: 'jwk' }).x as string, 'base64url');
const publicFromRaw = (raw: Buffer, crv: 'X25519' | 'Ed25519' = 'X25519'): KeyObject => {
  if (raw.length !== 32) throw new Error(REJECTED);
  return createPublicKey({ key: { kty: 'OKP', crv, x: raw.toString('base64url') }, format: 'jwk' });
};
const privateFromDer = (b64: string): KeyObject =>
  createPrivateKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'pkcs8' });

/** publicKey: base64 raw 32 bytes. privateKey: base64 pkcs8 DER — never leaves the runner. */
export function generateBoxKey(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  return {
    publicKey: rawPublic(publicKey).toString('base64'),
    privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
  };
}

/** The laptop's signing key. Same encodings as the box key: raw 32-byte public, pkcs8 private. */
export function generateSenderKey(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey: rawPublic(publicKey).toString('base64'),
    privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
  };
}

/** First 16 hex chars of sha256(raw pubkey), grouped for reading aloud. */
export function fingerprintOf(publicKey: string): string {
  const hex = createHash('sha256').update(Buffer.from(publicKey, 'base64')).digest('hex').slice(0, 16);
  return hex.match(/.{4}/g)!.join('-');
}

function deriveKey(shared: Buffer, epk: Buffer, recipient: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', shared, Buffer.concat([epk, recipient]), INFO, 32));
}

const aadFor = (recipientPublicKey: string, spk: string) =>
  Buffer.from(`${INFO}:${fingerprintOf(recipientPublicKey)}:${spk}`);
const senderPublicOf = (senderPrivateKey: string) =>
  rawPublic(createPublicKey(privateFromDer(senderPrivateKey))).toString('base64');

type UnsignedSealed = Omit<SealedBundle, 'spk' | 'sig'>;

/** Exactly the string the contract names: the base64 fields as sent. */
const signedMessage = (s: UnsignedSealed) => Buffer.from(`${INFO}|${s.epk}|${s.iv}|${s.ct}|${s.tag}`);

export function signSealed(unsigned: UnsignedSealed, senderPrivateKey: string): SealedBundle {
  const priv = privateFromDer(senderPrivateKey);
  return {
    ...unsigned,
    spk: senderPublicOf(senderPrivateKey),
    sig: sign(null, signedMessage(unsigned), priv).toString('base64'),
  };
}

/** Whether sig is spk's signature over the sealed fields. Never throws. */
export function verifySealed(sealed: SealedBundle): boolean {
  try {
    const sig = Buffer.from(sealed.sig, 'base64');
    if (sig.length !== 64) return false;
    return verify(null, signedMessage(sealed), publicFromRaw(Buffer.from(sealed.spk, 'base64'), 'Ed25519'), sig);
  } catch {
    return false;
  }
}

export function sealBundle(bundle: AgentLoginBundle, recipientPublicKey: string, senderPrivateKey: string): SealedBundle {
  const recipientRaw = Buffer.from(recipientPublicKey, 'base64');
  const eph = generateKeyPairSync('x25519');
  const epk = rawPublic(eph.publicKey);
  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: publicFromRaw(recipientRaw) });
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(shared, epk, recipientRaw), iv);
  cipher.setAAD(aadFor(recipientPublicKey, senderPublicOf(senderPrivateKey)));
  const ct = Buffer.concat([cipher.update(JSON.stringify(bundle), 'utf8'), cipher.final()]);
  return signSealed(
    {
      v: 1,
      epk: epk.toString('base64'),
      iv: iv.toString('base64'),
      ct: ct.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
    },
    senderPrivateKey,
  );
}

/** Decrypts only — the caller checks verifySealed and the sender pin first.
 *  Throws one fixed message on any failure — never the cause, which could
 *  carry plaintext. */
export function openBundle(sealed: SealedBundle, privateKey: string, publicKey: string): AgentLoginBundle {
  try {
    if (sealed.v !== 1) throw new Error(REJECTED);
    const epk = Buffer.from(sealed.epk, 'base64');
    const iv = Buffer.from(sealed.iv, 'base64');
    const tag = Buffer.from(sealed.tag, 'base64');
    if (iv.length !== 12 || tag.length !== 16) throw new Error(REJECTED);
    const priv = privateFromDer(privateKey);
    const shared = diffieHellman({ privateKey: priv, publicKey: publicFromRaw(epk) });
    const decipher = createDecipheriv('aes-256-gcm', deriveKey(shared, epk, Buffer.from(publicKey, 'base64')), iv);
    decipher.setAAD(aadFor(publicKey, sealed.spk));
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(Buffer.from(sealed.ct, 'base64')), decipher.final()]);
    return JSON.parse(pt.toString('utf8')) as AgentLoginBundle;
  } catch {
    throw new Error(REJECTED);
  }
}
