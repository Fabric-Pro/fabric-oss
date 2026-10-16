/**
 * 32-bit FNV-1a over a string's UTF-16 code units. Pure and dependency-free,
 * so it runs in Node, the browser and Temporal workflow code alike
 * (`glossy/keys.ts` cannot: it needs `node:crypto`).
 */
export function fnv1a(value: string, seed: number): number {
	let hash = seed;
	for (let i = 0; i < value.length; i++) {
		hash ^= value.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
}

const FNV_OFFSET_BASIS = 0x811c9dc5;
/** Golden-ratio constant, used only to decorrelate the second pass. */
const SECOND_SEED = 0x9e3779b9;

/**
 * Sixteen lowercase hex characters: two independently seeded FNV-1a passes,
 * each padded to eight. Callers add their own prefix or suffix.
 */
export function fnv1aHex64(value: string): string {
	const low = fnv1a(value, FNV_OFFSET_BASIS).toString(16).padStart(8, "0");
	const high = fnv1a(value, SECOND_SEED).toString(16).padStart(8, "0");
	return `${low}${high}`;
}
