/**
 * RFC 8785 JSON Canonicalization Scheme (JCS) — minimal,
 * dependency-free implementation sufficient for the desired_state
 * payload, which is a flat object of strings + numbers + uuids.
 *
 * Rules implemented:
 *   - Object keys sorted lexicographically (UTF-16 code unit order,
 *     which JavaScript's sort does by default for Latin keys).
 *   - No whitespace.
 *   - Strings encoded with JSON.stringify (which uses RFC 8259
 *     escaping; JCS allows it for ASCII).
 *   - Numbers serialized via JSON.stringify (handles ints + floats
 *     in the canonical short form for the values we use).
 *   - Booleans + null pass-through.
 *
 * NOT implemented (not needed for desired_state):
 *   - Full Unicode case folding for non-Latin keys.
 *   - IEEE-754 number canonicalization for fractional values.
 *
 * The signed bytes are exactly the UTF-8 encoding of the returned
 * string. The host verifies against these bytes verbatim.
 */
export function jcs(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('jcs: non-finite number');
    }
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map((v) => jcs(v)).join(',') + ']';
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return (
      '{' +
      keys
        .map(
          (k) =>
            JSON.stringify(k) +
            ':' +
            jcs((value as Record<string, unknown>)[k]),
        )
        .join(',') +
      '}'
    );
  }
  throw new Error(`jcs: unsupported value type ${typeof value}`);
}
