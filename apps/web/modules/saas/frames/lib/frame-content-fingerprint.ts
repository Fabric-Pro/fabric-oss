/**
 * What identifies one version of a page for the viewer's approvals: a SHA-256
 * of everything a page is made of that decides what it does, which is its
 * blocks and the tools it declared. An edit to either gives another value, so
 * an "allow" given to the page as it was is not taken for the page as it is.
 *
 * Null when this browser cannot hash (no `crypto.subtle`, as outside a secure
 * context): the caller then remembers no approval and asks every time.
 */
export async function frameContentFingerprint(page: {
	blocks: ReadonlyArray<{ id: string; type: string; content: string }>;
	runtimeTools: readonly string[];
}): Promise<string | null> {
	const subtle = globalThis.crypto?.subtle;
	if (!subtle) {
		return null;
	}
	const material = JSON.stringify([
		page.blocks.map((block) => [block.id, block.type, block.content]),
		[...page.runtimeTools].sort(),
	]);
	const digest = await subtle.digest(
		"SHA-256",
		new TextEncoder().encode(material),
	);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}
