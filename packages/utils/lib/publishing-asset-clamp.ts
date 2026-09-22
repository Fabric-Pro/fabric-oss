/**
 * The asset-clamp vocabulary and algorithm shared by every Publishing Suite
 * content type that carries a `confirmedAssets` / `assetsNeedingConfirmation`
 * pair (Fizzy #1988).
 *
 * Originated in Case Study (Fizzy #1854, Phase 2C-1) as an inline pass and
 * moved here once a second content type needed the identical behavior: a
 * claimed-confirmed asset an unresolved approval thread is about gets moved to
 * "needs confirmation" server-side, because the model's own claim of
 * confirmation is not trustworthy evidence of it.
 */

/**
 * Decision kinds whose unresolved thread makes a claimed-confirmed ASSET
 * untrustworthy.
 *
 * Wider than `ASSET_APPROVAL` alone: an unapproved internal UI capture or an
 * unconfirmed video walkthrough is the same claim wearing a different kind.
 */
export const ASSET_RESTRICTING_KINDS: ReadonlySet<string> = new Set([
	"ASSET_APPROVAL",
	"INTERNAL_UI",
	"VIDEO_WALKTHROUGH",
]);

/**
 * Fold case and collapse whitespace, for comparing an asset label the MODEL
 * wrote against a subject a HUMAN typed into a decision thread. Neither side is
 * canonical, so an exact match would miss "the latency chart" against
 * "The Latency Chart".
 */
export function normalizeAssetLabel(value: string): string {
	return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Whether a claimed-confirmed asset is the thing an unresolved approval is
 * about.
 *
 * Containment in EITHER direction, because the two sides are written by
 * different authors at different times: a thread subject "latency chart" should
 * catch an asset called "the latency chart (Q3)", and vice versa. Over-matching
 * demotes an asset to "needs confirmation", which is the safe direction; a miss
 * leaves an unapproved asset labelled safe to publish, which is the whole
 * failure this exists to prevent.
 */
export function assetIsRestricted(
	asset: string,
	restrictedSubjects: readonly string[],
): boolean {
	const a = normalizeAssetLabel(asset);
	if (!a) {
		return false;
	}
	return restrictedSubjects.some((subject) => {
		const s = normalizeAssetLabel(subject);
		return s.length > 0 && (a.includes(s) || s.includes(a));
	});
}

/**
 * The kind whose unresolved thread makes this asset untrustworthy, or null.
 *
 * Runs over the SAME pre-filtered thread set that decides the move, never over
 * all threads: a subject can be named by a CUSTOMER_NAME thread and by an
 * ASSET_APPROVAL one, and attributing the move to the wrong one tells a reader
 * Fabric acted for a reason that is not the reason.
 */
export function matchingRestrictedKind(
	asset: string,
	restrictedThreads: readonly { kind: string; label: string }[],
): string | null {
	for (const kind of ASSET_RESTRICTING_KINDS) {
		const labels = restrictedThreads
			.filter((t) => t.kind === kind)
			.map((t) => t.label);
		if (assetIsRestricted(asset, labels)) {
			return kind;
		}
	}
	return null;
}

/** The `generation.clamped` record the 2D types carry. */
export interface PublishingClampRecord {
	/** Labels moved out of `confirmed`, pre-dedupe. Absent when nothing moved. */
	assets?: string[];
	/** label -> the ASSET_RESTRICTING_KINDS member that caused the move. */
	assetKinds?: Record<string, string>;
}

/**
 * Move every claimed-confirmed asset an unresolved approval is about into the
 * needs-confirmation list. Never upgrades: an asset the model itself hedged
 * stays hedged even with no unresolved thread.
 *
 * `moved` is PRE-dedupe, matching what the Case Study call site has always
 * recorded, and the caller assigns it only when non-empty — an unclamped draft
 * carries no `assets` key at all.
 */
export function clampConfirmedAssets(input: {
	confirmed: readonly string[];
	needsConfirmation: readonly string[];
	restricted: readonly { kind: string; label: string }[];
}): {
	confirmed: string[];
	needsConfirmation: string[];
	moved: { label: string; kind: string }[];
} {
	const restricting = input.restricted.filter((t) =>
		ASSET_RESTRICTING_KINDS.has(t.kind),
	);
	const subjects = restricting.map((t) => t.label);

	const moved: { label: string; kind: string }[] = [];
	const kept: string[] = [];
	for (const asset of input.confirmed) {
		if (assetIsRestricted(asset, subjects)) {
			const kind = matchingRestrictedKind(asset, restricting);
			if (kind === null) {
				// Unreachable: `restricting` is filtered to
				// ASSET_RESTRICTING_KINDS and matchingRestrictedKind partitions
				// that same set. Throwing rather than defaulting keeps a future
				// partitioning bug from silently writing an assetKinds value
				// that violates the invariant in spec 5.4.
				throw new Error(
					"clamp: moved an asset with no matching restricting kind",
				);
			}
			moved.push({ label: asset, kind });
		} else {
			kept.push(asset);
		}
	}

	// Normalized on BOTH sides. Selection already matched normalized, so an
	// exact-equality dedupe let "The Latency Chart" and "the latency chart"
	// through as two entries.
	const seen = new Set(input.needsConfirmation.map(normalizeAssetLabel));
	const appended: string[] = [];
	for (const m of moved) {
		const key = normalizeAssetLabel(m.label);
		if (!seen.has(key)) {
			seen.add(key);
			appended.push(m.label);
		}
	}

	return {
		confirmed: kept,
		needsConfirmation: [...input.needsConfirmation, ...appended],
		moved,
	};
}

/**
 * What a settled asset confirmation grants (Fizzy #1988).
 *
 * Three values rather than a boolean, because a binary answer is how the
 * enforcement gap opened: once a thread was settled it simply stopped
 * restricting, whatever the answer said, so "approved for internal use only"
 * mechanically unlocked the asset for every format the suite writes.
 */
export const ASSET_CONFIRMATION_SCOPES = {
	ANY_AUDIENCE: "ANY_AUDIENCE",
	INTERNAL_ONLY: "INTERNAL_ONLY",
	NOT_APPROVED: "NOT_APPROVED",
} as const;

export type AssetConfirmationScope =
	(typeof ASSET_CONFIRMATION_SCOPES)[keyof typeof ASSET_CONFIRMATION_SCOPES];

/**
 * The answer texts a draft-raised asset confirmation offers.
 *
 * Fixed strings, and the scope is read back by matching against them
 * (`assetConfirmationScope`). The alternative — interpreting whatever a member
 * typed — would mean deciding from prose whether an asset may be published,
 * which is the one judgement this feature exists to take away from a model.
 */
export const ASSET_CONFIRMATION_ANSWERS: Readonly<
	Record<AssetConfirmationScope, string>
> = {
	ANY_AUDIENCE: "Confirmed — cleared for any audience.",
	INTERNAL_ONLY: "Confirmed for internal audiences only.",
	NOT_APPROVED: "Not confirmed — leave it out.",
};

/**
 * Content types whose readership is chosen rather than public.
 *
 * EMPTY, deliberately, and it is an extension point rather than an oversight.
 * Every format the suite generates today leaves the company — a case study, a
 * webinar script, a newsletter, a post, and an email whose own audience
 * (`AUDIENCE_SCOPE`) is the undecided thing about it. So an asset cleared for
 * internal audiences only is cleared for none of them, and `INTERNAL_ONLY`
 * promotes nothing until a genuinely internal format exists to list here.
 *
 * That is the point of the value, not a gap in it: it records a real decision
 * — the asset exists and has been looked at — without letting it read as
 * permission to publish.
 */
export const INTERNAL_AUDIENCE_POST_TYPES: ReadonlySet<string> =
	new Set<string>();

/**
 * The scope a settled answer grants, or null when it grants nothing mechanical.
 *
 * Null for free text, deliberately. A typed answer still reaches the model in
 * the settled-decisions block, where it reads as guidance; what it does not do
 * is move an asset into the list the draft presents as cleared. Silence is the
 * safe direction here: a missed promotion leaves a confirmed asset labelled
 * "needs confirmation", which is a person re-confirming something; a wrong one
 * publishes an asset nobody cleared.
 */
export function assetConfirmationScope(
	answer: string | null | undefined,
): AssetConfirmationScope | null {
	if (!answer) {
		return null;
	}
	const normalized = normalizeAssetLabel(answer);
	for (const [scope, text] of Object.entries(ASSET_CONFIRMATION_ANSWERS)) {
		if (normalizeAssetLabel(text) === normalized) {
			return scope as AssetConfirmationScope;
		}
	}
	// The PLANNING ANALYSIS's own approval options, which predate this loop and
	// already sit answered on live topics. They are a prefix rather than a
	// constant because the analysis interpolates the subject into them
	// ("Approved — the draft may use the latency chart."). Without this, an
	// asset a member approved before any of this existed would stay listed as
	// unconfirmed forever, and the loop would only ever close for questions a
	// draft raised itself.
	//
	// The analysis's approval is unscoped by construction — it offers exactly
	// two answers — so it reads as ANY_AUDIENCE, which is the same permission
	// the restriction half has always granted a settled thread.
	for (const [prefix, scope] of ANALYSIS_APPROVAL_PREFIXES) {
		if (normalized.startsWith(prefix)) {
			return scope;
		}
	}
	return null;
}

/**
 * Longest first, so "not approved" is never read as "approved" — they share no
 * prefix today, and ordering them makes that independent of the wording.
 */
const ANALYSIS_APPROVAL_PREFIXES: readonly [string, AssetConfirmationScope][] =
	[
		["not approved — leave", "NOT_APPROVED"],
		["approved — the draft may use", "ANY_AUDIENCE"],
	];

/** Whether a settled scope clears an asset for `postType`. */
export function scopeCoversPostType(
	scope: AssetConfirmationScope,
	postType: string,
): boolean {
	if (scope === "ANY_AUDIENCE") {
		return true;
	}
	if (scope === "INTERNAL_ONLY") {
		return INTERNAL_AUDIENCE_POST_TYPES.has(postType);
	}
	return false;
}

/**
 * Move an asset a member has confirmed out of "needs confirmation" — the other
 * half of the loop the clamp opens.
 *
 * The clamp alone never closed it. An asset sits in `needsConfirmation`
 * because the MODEL put it there, so answering the question changed nothing
 * mechanical: the next generation asked the same model the same thing, and the
 * same item came back on the list with the same instruction to go and confirm
 * it. The settled answer reached the prompt as advice and nothing more.
 *
 * MATCHED ON EXACT NORMALIZED EQUALITY, and this is the one place that must
 * NOT reuse `assetIsRestricted`'s containment. Containment is right for the
 * clamp because over-matching demotes — the safe direction. Here over-matching
 * would present an asset as cleared because a member confirmed something whose
 * label happens to contain it ("the latency chart" clearing "the latency chart
 * from the internal deck"), which is exactly the failure the clamp exists to
 * prevent, arrived at from the other side.
 *
 * Runs BEFORE the clamp at every call site: anything this promotes is still
 * subject to an unresolved thread naming it, and the clamp puts it back.
 */
export function promoteConfirmedAssets(input: {
	confirmed: readonly string[];
	needsConfirmation: readonly string[];
	settled: readonly { label: string; scope: AssetConfirmationScope }[];
	postType: string;
}): {
	confirmed: string[];
	needsConfirmation: string[];
	promoted: { label: string; scope: AssetConfirmationScope }[];
} {
	const clearing = new Map<string, AssetConfirmationScope>();
	for (const entry of input.settled) {
		if (!scopeCoversPostType(entry.scope, input.postType)) {
			continue;
		}
		const key = normalizeAssetLabel(entry.label);
		if (key) {
			clearing.set(key, entry.scope);
		}
	}
	if (clearing.size === 0) {
		return {
			confirmed: [...input.confirmed],
			needsConfirmation: [...input.needsConfirmation],
			promoted: [],
		};
	}

	const promoted: { label: string; scope: AssetConfirmationScope }[] = [];
	const stillNeeded: string[] = [];
	for (const asset of input.needsConfirmation) {
		const scope = clearing.get(normalizeAssetLabel(asset));
		if (scope) {
			promoted.push({ label: asset, scope });
		} else {
			stillNeeded.push(asset);
		}
	}

	// Normalized dedupe on the confirmed side too: the model may already list
	// the same asset as confirmed in a different case, and a draft that names
	// one asset twice reads as two.
	const seen = new Set(input.confirmed.map(normalizeAssetLabel));
	const appended: string[] = [];
	for (const p of promoted) {
		const key = normalizeAssetLabel(p.label);
		if (!seen.has(key)) {
			seen.add(key);
			appended.push(p.label);
		}
	}

	return {
		confirmed: [...input.confirmed, ...appended],
		needsConfirmation: stillNeeded,
		promoted,
	};
}
