/**
 * The asset-clamp vocabulary and algorithm shared by every Publishing Suite
 * content type that carries a `confirmedAssets` / `assetsNeedingConfirmation`
 * pair (Fizzy #1988).
 *
 * Originated in Case Study (Fizzy #1854, Phase 2C-1) as an inline pass and
 * moved here once a second content type needed the identical behavior: a
 * claimed-confirmed asset an open approval thread is about gets moved to
 * "needs confirmation" server-side, because the model's own claim of
 * confirmation is not trustworthy evidence of it.
 */

/**
 * Decision kinds whose open thread makes a claimed-confirmed ASSET untrustworthy.
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
 * Whether a claimed-confirmed asset is the thing an open approval is about.
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
 * The kind whose open thread makes this asset untrustworthy, or null.
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
 * Move every claimed-confirmed asset an open approval is about into the
 * needs-confirmation list. Never upgrades: an asset the model itself hedged
 * stays hedged even with no open thread.
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
