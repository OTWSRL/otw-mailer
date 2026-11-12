const encoder = new TextEncoder()

/** Text as UTF-8 bytes. */
export function utf8(text: string): Uint8Array {
  return encoder.encode(text)
}

/** Bytes as base64. Works without Node's Buffer, for runtimes that only have the web's APIs. */
export function base64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64')
  }
  let binary = ''
  for (let at = 0; at < bytes.length; at += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000))
  }
  return btoa(binary)
}

/** Bytes as URL-safe base64, without padding. */
export function base64url(bytes: Uint8Array): string {
  return base64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Bytes as lowercase hex. */
export function hex(bytes: Uint8Array): string {
  let out = ''
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return out
}

/** `size` random bytes, as hex. */
export function randomHex(size: number): string {
  return hex(crypto.getRandomValues(new Uint8Array(size)))
}

/** Whether text is printable ASCII only, so a header can carry it as it is. */
export function isAscii(text: string): boolean {
  return /^[\x20-\x7e]*$/.test(text)
}
