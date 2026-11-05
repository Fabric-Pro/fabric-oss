/** Ordinary reads never carry a bearer link; explicit sharing commands own link access. */
export function frameReadDto<T extends { shareToken?: string | null }>(
	frame: T,
) {
	return {
		...frame,
		// Preserve the published field shape without returning the credential.
		shareToken: null,
		shareUrl: undefined,
		shareEmbedUrl: undefined,
	};
}
