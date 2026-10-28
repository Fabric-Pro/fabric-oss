/** Retain only request identity and a digest, never the draft text. */
export interface PendingCodingPrompt {
	key: string;
	promptId: string;
}

export async function getPendingCodingPrompt(
	runId: string,
	content: string,
): Promise<PendingCodingPrompt> {
	const key = `coding-prompt:${runId}`;
	const bytes = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(content),
	);
	const digest = Array.from(new Uint8Array(bytes), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
	const raw = sessionStorage.getItem(key);
	if (raw) {
		try {
			const existing = JSON.parse(raw);
			if (
				existing.digest === digest &&
				typeof existing.promptId === "string" &&
				/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
					existing.promptId,
				)
			) {
				return { key, promptId: existing.promptId };
			}
		} catch {
			/* Replace malformed local identity data before any network mutation. */
		}
	}
	const promptId = crypto.randomUUID();
	sessionStorage.setItem(key, JSON.stringify({ digest, promptId }));
	return { key, promptId };
}

export function clearPendingCodingPrompt(pending: PendingCodingPrompt): void {
	try {
		const raw = sessionStorage.getItem(pending.key);
		if (raw && JSON.parse(raw).promptId === pending.promptId) {
			sessionStorage.removeItem(pending.key);
		}
	} catch {
		// A successful native receipt remains successful if local cleanup fails.
		// Keeping the old identity is safer than generating a duplicate request.
	}
}
