/**
 * One before/after line in a proposal review row.
 *
 * Extracted from `BacklogChangeProposal` so the Create-vs-Enrich routing
 * control can render the re-targeted enrichment preview in the same visual
 * language as the rest of the review row, without either file importing the
 * other.
 *
 * WHY THIS DIFFS RATHER THAN TRUNCATES: the original showed the first 80
 * characters of each side. That works when a field is short and rewritten
 * wholesale — an AI Update changing a one-line title — but a
 * structure-preserving enrichment inserts new detail *inside* a body that can
 * run to thousands of characters. Both sides then truncate to the same opening
 * words, and the reviewer is shown a strikethrough line and a green line that
 * read identically. Observed on staging: a 10,585 → 15,605 character
 * enrichment rendered as two byte-identical 80-character strings.
 *
 * So the field locates the region that actually differs and shows that, with
 * an ellipsis marking the unchanged text on either side.
 */

/** Characters of the differing region shown per side before eliding. */
const CHANGE_MAX_CHARS = 220;

/**
 * Below this length a value is shown WHOLE rather than narrowed to its changed
 * span. Narrowing exists to stop two long bodies truncating to the same opening
 * words; applied to a short value it only adds noise — "P2_MEDIUM" → "P1_HIGH"
 * shares a leading "P", and eliding it renders "…2_MEDIUM", which is harder to
 * read than the value itself.
 */
const NARROW_ABOVE_CHARS = 120;

export type ChangeRegion = {
	/** Text present in `from` but not `to`. Empty for a pure addition. */
	removed: string;
	/** Text present in `to` but not `from`. Empty for a pure deletion. */
	added: string;
	/** Unchanged text precedes the region shown. */
	elidedBefore: boolean;
	/** Unchanged text follows the region shown. */
	elidedAfter: boolean;
};

/**
 * Narrow two strings to the span that differs, by trimming their common prefix
 * and common suffix. Pure and exported so the behaviour is testable without
 * rendering.
 *
 * Deliberately character-level rather than word- or line-level: it needs no
 * tokenisation, cannot mis-align on markdown, and for the append-shaped edits a
 * structure-preserving merge produces it lands on exactly the inserted text.
 */
export function changedRegion(from: string, to: string): ChangeRegion {
	if (from === to) {
		return {
			removed: "",
			added: "",
			elidedBefore: false,
			elidedAfter: false,
		};
	}

	const max = Math.min(from.length, to.length);
	let prefix = 0;
	while (prefix < max && from[prefix] === to[prefix]) {
		prefix++;
	}

	// Cap the suffix scan so prefix and suffix cannot overlap on inputs that
	// repeat (e.g. "aaaa" vs "aaaaaa"), which would otherwise yield negative
	// slice bounds and a nonsense region.
	let suffix = 0;
	const suffixLimit = max - prefix;
	while (
		suffix < suffixLimit &&
		from[from.length - 1 - suffix] === to[to.length - 1 - suffix]
	) {
		suffix++;
	}

	return {
		removed: from.slice(prefix, from.length - suffix),
		added: to.slice(prefix, to.length - suffix),
		elidedBefore: prefix > 0,
		elidedAfter: suffix > 0,
	};
}

function clamp(value: string): string {
	return value.length > CHANGE_MAX_CHARS
		? `${value.slice(0, CHANGE_MAX_CHARS)}…`
		: value;
}

/** Wrap the changed span in the ellipses that stand for untouched text. */
function withElisions(
	value: string,
	{ elidedBefore, elidedAfter }: ChangeRegion,
): string {
	if (!value) {
		return "";
	}
	return `${elidedBefore ? "…" : ""}${clamp(value)}${elidedAfter ? "…" : ""}`;
}

export function ProposalDiffField({
	label,
	from,
	to,
}: {
	label: string;
	from: string;
	to: string;
}) {
	// Short values are shown whole: both fit, so nothing collides and the
	// reader is better served by the complete before and after.
	const narrow =
		from.length > NARROW_ABOVE_CHARS || to.length > NARROW_ABOVE_CHARS;
	const region = narrow
		? changedRegion(from, to)
		: {
				removed: from === to ? "" : from,
				added: from === to ? "" : to,
				elidedBefore: false,
				elidedAfter: false,
			};
	const removed = withElisions(region.removed, region);
	const added = withElisions(region.added, region);

	return (
		<div className="text-xs">
			<span className="font-medium text-muted-foreground">{label}:</span>
			<div className="ml-2">
				{removed ? (
					<span className="line-through text-destructive/70">
						{removed}
					</span>
				) : null}
				{removed && added ? <br /> : null}
				{added ? (
					<span className="text-success dark:text-green-400">
						{added}
					</span>
				) : null}
				{/* Whitespace-only or otherwise invisible edit: say so rather
				    than render two blank lines that read as "nothing changes". */}
				{!removed && !added ? (
					<span className="text-muted-foreground">
						Formatting only — no visible text change.
					</span>
				) : null}
			</div>
		</div>
	);
}
