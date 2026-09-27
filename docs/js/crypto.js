// Decrypts docs/data/index.enc produced by `photorganize.py build`.
// Layout: "PORG1" | salt(16) | iv(12) | iterations(u32 BE) | AES-256-GCM(gzip(json)) + tag
export async function decryptIndex(buf, passphrase) {
  const u8 = new Uint8Array(buf);
  if (new TextDecoder().decode(u8.slice(0, 5)) !== 'PORG1') throw new Error('Not a photorganize index');
  const salt = u8.slice(5, 21), iv = u8.slice(21, 33);
  const iter = new DataView(buf).getUint32(33);
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  let gz;
  try {
    gz = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, u8.slice(37));
  } catch {
    throw new Error('Wrong passphrase');
  }
  const text = await new Response(new Blob([gz]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
  return JSON.parse(text);
}
