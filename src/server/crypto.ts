// AES-GCM encryption of stored Radius passwords, plus session token helpers.
// Uses only WebCrypto, which the Workers runtime provides.

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// RADIUS_CREDENTIAL_KEY is a base64-encoded 32-byte key, e.g. from
// `openssl rand -base64 32`.
async function importKey(secret: string): Promise<CryptoKey> {
  const raw = fromBase64(secret);
  if (raw.length !== 32) {
    throw new Error("RADIUS_CREDENTIAL_KEY must be a base64-encoded 32-byte key");
  }
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

// The username is bound to the ciphertext as additional authenticated data,
// so a ciphertext can't be moved onto another account's row.
export async function encryptPassword(secret: string, username: string, password: string) {
  const key = await importKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(username.toLowerCase()) },
    key,
    encoder.encode(password),
  );
  return { ciphertext: toBase64(new Uint8Array(ciphertext)), iv: toBase64(iv) };
}

export async function decryptPassword(
  secret: string,
  username: string,
  ciphertext: string,
  iv: string,
): Promise<string> {
  const key = await importKey(secret);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(iv), additionalData: encoder.encode(username.toLowerCase()) },
    key,
    fromBase64(ciphertext),
  );
  return decoder.decode(plaintext);
}

export function newSessionToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
