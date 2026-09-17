export async function sha256Hex(
	bytes: Uint8Array<ArrayBuffer>,
): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(digest), (b) =>
		b.toString(16).padStart(2, "0"),
	).join("");
}

export async function computeSnapshotDigest(
	entries: ReadonlyArray<{ path: string; sha256: string }>,
): Promise<string> {
	const lines = [...entries]
		.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
		.map((e) => `${e.path}\0${e.sha256}\n`)
		.join("");
	return sha256Hex(new TextEncoder().encode(lines));
}
