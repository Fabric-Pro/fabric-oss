/**
 * The clamp vocabulary for a Case Study draft (Fizzy #1854, Phase 2C-1).
 *
 * `customerIdentity` and `metricsBasis` are the MODEL's claim about its own
 * output. The generation activity lowers an over-confident one from the topic's
 * open approval threads, and records WHY it did so in the draft's `generation`
 * block so the panel can say "Fabric set this" rather than letting a clamped
 * label read as the model's own judgement.
 *
 * Lives in `@repo/utils` — a leaf both `@repo/temporal` and the web app already
 * import from — because the writer and the reader are in different packages and
 * the link between them is otherwise string equality across a package boundary.
 * That is the shape this very slice removed for the working-draft composer, and
 * reintroducing it here would fail in the worse direction: an unrecognised
 * reason maps to "not clamped", so a rename makes the warning VANISH while the
 * clamped label stays. Silent under-warning, on the surface whose whole purpose
 * is to warn.
 */

/** Why a field was clamped: the decision kind whose open thread caused it. */
export const CASE_STUDY_CLAMP_REASON = {
	customerIdentity: "CUSTOMER_NAME",
	metricsBasis: "METRICS_APPROVAL",
	/**
	 * Assets are clamped by MATCH, not wholesale: an open approval about one
	 * asset says nothing about an unrelated one, and demoting every asset would
	 * teach the reader to ignore the list.
	 */
	assets: "ASSET_APPROVAL",
} as const;

/** The `generation.clamped` record a draft carries. */
export interface CaseStudyClampRecord {
	customerIdentity?: typeof CASE_STUDY_CLAMP_REASON.customerIdentity;
	metricsBasis?: typeof CASE_STUDY_CLAMP_REASON.metricsBasis;
	/** The asset labels moved out of `confirmedAssets`. */
	assets?: string[];
}

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
