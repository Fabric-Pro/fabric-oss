/** Compare only fields consumed by a row, including cloned timestamp values. */
export function equalMessageFields(a: unknown, b: unknown, fields: string[]) {
	if (a === b) {
		return true;
	}
	if (!a || !b) {
		return false;
	}
	const left = a as Record<string, unknown>;
	const right = b as Record<string, unknown>;
	return fields.every(
		(key) =>
			Object.is(left[key], right[key]) ||
			JSON.stringify(left[key]) === JSON.stringify(right[key]),
	);
}
