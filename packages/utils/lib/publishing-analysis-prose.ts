/**
 * Splitting a publishing topic's Planning & Analysis into the half a person
 * edits and the half the product reads structurally (Fizzy #1851).
 *
 * Lives in `@repo/utils` and not beside the schema because all three consumers
 * need it — the query layer, the Temporal generators and the web tab — and
 * `@repo/utils` is the only package all three already depend on.
 *
 * Input is `unknown` on purpose. The schema belongs to Phase 2A and keeps
 * growing; naming its fields here in a type would go stale silently, which is
 * the same reasoning `flattenPlanningAnalysis` records for staying
 * structure-agnostic.
 *
 * The two field lists below ARE a copy of that schema's key set, and the copy
 * is checked rather than trusted: a schema field in neither list would vanish
 * from the editable document AND from the generation prompt with nothing going
 * red on either side. `@repo/temporal`'s
 * `src/activities/publishing-planning/__tests__/analysis-field-partition.test.ts`
 * asserts the partition is exact and total. It lives there because that is the
 * only package allowed to import both the schema and this module.
 */

/** Prose, in the order it is rendered. Everything else is data. */
export const PROSE_FIELDS = [
	"topicAngle",
	"whyWorthPublishing",
	"keyDetails",
	"recommendedAuthors",
	"authorVoiceAndPerspective",
	"audienceAndDistributionFit",
	"risks",
	"preDraftGuidance",
] as const;

/**
 * Structured sections, kept out of the document because the product reads them
 * by name: `contentTypes` decides which media tabs are offered,
 * `recommendedQuestions` mints decision threads, `sourceSignals` is provenance.
 */
export const DATA_FIELDS = [
	"contentTypes",
	"supportingAssets",
	"sourceSignals",
	"recommendedQuestions",
] as const;

export type AnalysisData = Record<string, unknown>;

export interface EffectiveAnalysis {
	prose: string;
	data: AnalysisData;
	/**
	 * Whether a human wrote this prose. NOT derivable from `prose` being empty:
	 * an author who deletes every word has made a decision, and a reader that
	 * cannot tell that from "never edited" will happily re-seed their document
	 * from the AI text they just removed.
	 */
	overridden: boolean;
}

/**
 * `keyDetailsToUse` → `Key details to use`.
 *
 * Sentence case, not Title Case: these become headings inside prose a person
 * reads and a model reads, and `Key Details To Use` reads as a proper noun —
 * something to quote rather than a label over the content beneath it.
 *
 * EXPORTED because `flattenPlanningAnalysis` in `@repo/temporal` renders the
 * same document for the generation prompt and must humanize a key identically.
 * It held a line-for-line copy of this function until Fizzy #1851; the copy
 * could not be removed then only because `@repo/utils` must never depend on
 * `@repo/temporal`. The dependency runs the other way, so the copy is gone and
 * this is the single definition.
 */
export function humanizeKey(key: string): string {
	const spaced = key
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/[_-]+/g, " ")
		.trim()
		.toLowerCase();
	return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Walk one value into indented lines. Structure-agnostic on purpose — see
 * `PROSE_FIELDS` above and `flattenPlanningAnalysis` in `@repo/temporal`.
 *
 * EXPORTED for the same reason as `humanizeKey`: the prompt side rendered the
 * identical walker and the two must not drift. If a prompt ever genuinely needs
 * different indentation or escaping from the document, fork it THERE with a
 * comment saying why — do not quietly edit this one.
 */
export function renderValue(value: unknown, depth: number): string[] {
	const pad = "  ".repeat(depth);
	if (value == null) {
		return [];
	}
	if (typeof value === "string") {
		const trimmed = value.trim();
		return trimmed ? [`${pad}${trimmed}`] : [];
	}
	if (typeof value === "number" || typeof value === "boolean") {
		return [`${pad}${String(value)}`];
	}
	if (Array.isArray(value)) {
		return value.flatMap((item) => renderValue(item, depth));
	}
	if (typeof value === "object") {
		return Object.entries(value as Record<string, unknown>).flatMap(
			([key, nested]) => {
				const body = renderValue(nested, depth + 1);
				return body.length > 0
					? [`${pad}${humanizeKey(key)}:`, ...body]
					: [];
			},
		);
	}
	return [];
}

/** The prose half, as Markdown. Empty sections are omitted, never left bare. */
export function renderAnalysisProse(content: unknown): string {
	if (content == null || typeof content !== "object") {
		return "";
	}
	const record = content as Record<string, unknown>;
	const lines: string[] = [];
	for (const key of PROSE_FIELDS) {
		const body = renderValue(record[key], 1);
		if (body.length > 0) {
			lines.push(`### ${humanizeKey(key)}`, ...body, "");
		}
	}
	return lines.join("\n").trimEnd();
}

export function splitAnalysis(content: unknown): {
	prose: string;
	data: AnalysisData;
} {
	const record =
		content != null && typeof content === "object"
			? (content as Record<string, unknown>)
			: {};
	const data: AnalysisData = {};
	for (const key of DATA_FIELDS) {
		if (record[key] !== undefined) {
			data[key] = record[key];
		}
	}
	return { prose: renderAnalysisProse(record), data };
}

export function effectivePlanningAnalysis(input: {
	ai: unknown;
	revision: { body: string; sourceAnalysisVersion: number } | null;
}): EffectiveAnalysis | null {
	if (input.ai == null) {
		return null;
	}
	const { prose, data } = splitAnalysis(input.ai);
	return input.revision
		? { prose: input.revision.body, data, overridden: true }
		: { prose, data, overridden: false };
}
