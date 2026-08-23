import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';

/**
 * Synchronous SHA-256 of a UTF-8 string.
 *
 * Deliberately not Web Crypto: `crypto.subtle.digest` is async, and the config explorer
 * recomputes `config_id` on every keystroke while rendering. A sync hash keeps that a
 * pure function of the form state instead of a race.
 */
export function sha256Hex(input: string): string {
  return bytesToHex(sha256(utf8ToBytes(input)));
}

/** SHA-256 truncated to `n` hex characters — how every Atlas id is shortened. */
export function sha256Short(input: string, n: number): string {
  return sha256Hex(input).slice(0, n);
}
