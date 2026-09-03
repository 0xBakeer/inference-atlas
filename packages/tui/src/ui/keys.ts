/**
 * Enter, as terminals actually send it.
 *
 * Ink resolves a keypress to a single name, and only carriage return (`\r`) becomes
 * `key.return`. A line feed (`\n`) is named `enter` and never sets that flag, so a handler
 * written as `key.return` is dead on every terminal that sends LF — which is what several
 * WSL/ConPTY setups and some multiplexers do. The symptom is the worst kind: pressing Enter
 * does nothing at all, with no error to go on.
 *
 * `\n` is not in Ink's non-alphanumeric list either, so it also arrives as printable
 * `input` — which is why `printableInput` exists: without it a stray LF is appended to the
 * filter string instead of ending the filter.
 */

/** Ink's key flags, narrowed to what these helpers actually read. */
export interface EnterKey {
  return?: boolean;
}

/** True for Enter however the terminal spelled it: named `return`, CR, or LF. */
export function isEnter(input: string, key: EnterKey): boolean {
  return key.return === true || input === '\r' || input === '\n';
}

/** Enter, or an explicit yes. Used by confirmation dialogs. */
export function isConfirm(input: string, key: EnterKey): boolean {
  return isEnter(input, key) || input === 'y' || input === 'Y';
}

/** Text worth putting in a filter box: no control characters, no empty events. */
export function printableInput(input: string): boolean {
  if (input.length === 0) return false;
  for (const ch of input) {
    const code = ch.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}
