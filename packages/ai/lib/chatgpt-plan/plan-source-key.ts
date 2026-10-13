/**
 * The plan key the key exchange hands an agent (Fizzy #2770, #3037): the
 * source's opaque key — `user:<id>` or `org:<id>` — and, after a dot, the
 * fingerprint of the sign-in whose token it handed out. Agents echo the whole
 * string untouched: in a spent-plan report, in the plans to skip on a
 * re-exchange, and on their usage rows. Dependency-free, so the routes that
 * parse it load nothing else.
 */

const EXCHANGED_PLAN_SOURCE =
	/^(user|org):([\w-]{1,128})(?:\.([0-9a-f]{16}))?$/;

export interface ExchangedPlanSource {
	kind: "user" | "org";
	/** The member's id for `user`, the shared account's id for `org`. */
	id: string;
	/** The source's key without the fingerprint, as `planSourceKey` writes it. */
	key: string;
	/**
	 * The sign-in the token came from; null in a key handed out before the
	 * exchange named it.
	 */
	credentialFingerprint: string | null;
}

export function exchangedPlanSourceKey(
	sourceKey: string,
	credentialFingerprint: string,
): string {
	return `${sourceKey}.${credentialFingerprint}`;
}

/** The parts of an exchanged plan key; null when it is not one. */
export function parseExchangedPlanSource(
	value: string,
): ExchangedPlanSource | null {
	const match = value.match(EXCHANGED_PLAN_SOURCE);
	if (!match) {
		return null;
	}
	const [, kind, id, credentialFingerprint] = match;
	return {
		kind: kind as "user" | "org",
		id: id as string,
		key: `${kind}:${id}`,
		credentialFingerprint: credentialFingerprint ?? null,
	};
}
