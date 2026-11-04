export function executionRequestKey(
	body: unknown,
	header: string | undefined,
	legacyHeader?: string,
) {
	const present = [body, header, legacyHeader].filter(
		(value) => value !== undefined,
	);
	if (
		present.some(
			(value) =>
				typeof value !== "string" ||
				!/^[\x21-\x7e]{1,200}$/.test(value),
		)
	) {
		throw new Error("Invalid execution request key");
	}
	if (new Set(present).size > 1) {
		throw new Error("Request keys disagree");
	}
	return present[0] as string | undefined;
}
