/**
 * The shape of a Planning & Analysis document, read defensively.
 *
 * `content` arrives as a `Json` column, so nothing at the type level stops it
 * holding a string, a number, or an object written by an older build. Every
 * accessor here drops what it cannot understand rather than throwing: a panel
 * that renders nothing is a bad afternoon, a panel that crashes the Topic Item
 * Page takes the whole topic with it.
 *
 * The section ORDER lives here too, in the same order the seeded prompt asks
 * the model to produce. Since Fizzy #1851 the PROSE half is no longer rendered
 * from these lists — `renderAnalysisProse` in `@repo/utils` owns that, and it
 * is the document a person now edits — so what this module still renders is
 * the DATA half: the content-type and supporting-asset buckets, and the source
 * signals.
 */

import type { EffectiveAnalysis } from "@repo/utils/publishing-analysis-prose";

interface ClassifiedRecommendation {
	type: string;
	rationale: string;
}

interface PlanningQuestion {
	questionId: string;
	decisionKind: string;
	subject: string | null;
	question: string;
	recommendedResponse: string | null;
	whyItMatters: string | null;
	source: "MODEL" | "DERIVED";
}

const str = (v: unknown): string | null =>
	typeof v === "string" && v.trim().length > 0 ? v : null;

const strList = (v: unknown): string[] =>
	Array.isArray(v) ? v.map(str).filter((s): s is string => s !== null) : [];

const classified = (v: unknown): ClassifiedRecommendation[] => {
	if (!Array.isArray(v)) {
		return [];
	}
	const out: ClassifiedRecommendation[] = [];
	for (const item of v) {
		if (typeof item !== "object" || item === null) {
			continue;
		}
		const type = str((item as Record<string, unknown>).type);
		const rationale = str((item as Record<string, unknown>).rationale);
		if (type && rationale) {
			out.push({ type, rationale });
		}
	}
	return out;
};

const obj = (v: unknown): Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v)
		? (v as Record<string, unknown>)
		: {};

/** A prose section: a heading and the body the model wrote under it. */
interface ProseSection {
	key: string;
	label: string;
	body: string;
}

/** A bucketed section: three lists, any of which may be empty. */
interface BucketSection {
	key: string;
	label: string;
	buckets: {
		key: string;
		label: string;
		items: ClassifiedRecommendation[];
	}[];
}

export interface PlanningAnalysisDocument {
	prose: ProseSection[];
	keyDetails: ProseSection[];
	buckets: BucketSection[];
	sourceSignals: string[];
	risks: string[];
	questions: PlanningQuestion[];
	preDraftGuidance: string | null;
}

const PROSE_FIELDS: { key: string; label: string }[] = [
	{ key: "topicAngle", label: "Topic angle" },
	{ key: "whyWorthPublishing", label: "Why this is worth publishing" },
	{ key: "recommendedAuthors", label: "Recommended authors" },
	{ key: "authorVoiceAndPerspective", label: "Author voice and perspective" },
	{
		key: "audienceAndDistributionFit",
		label: "Audience and distribution fit",
	},
];

const KEY_DETAIL_FIELDS: { key: string; label: string }[] = [
	{ key: "released", label: "What was released" },
	{ key: "problem", label: "The problem" },
	{ key: "solution", label: "The solution" },
	{ key: "whatMakesItInteresting", label: "What makes it interesting" },
	{ key: "evidence", label: "Evidence" },
	{ key: "quotes", label: "Quotes" },
	{ key: "caveats", label: "Caveats" },
];

const BUCKET_FIELDS: {
	key: string;
	label: string;
	buckets: { key: string; label: string }[];
}[] = [
	{
		key: "contentTypes",
		label: "Content types",
		buckets: [
			{ key: "recommended", label: "Recommended" },
			{ key: "needsConfirmation", label: "Needs confirmation" },
			{ key: "deferred", label: "Deferred" },
		],
	},
	{
		key: "supportingAssets",
		label: "Supporting assets",
		buckets: [
			{ key: "recommended", label: "Recommended" },
			{ key: "requiresApproval", label: "Requires approval" },
			{ key: "deferred", label: "Deferred" },
		],
	},
];

export function readPlanningAnalysis(
	content: unknown,
): PlanningAnalysisDocument {
	const c = obj(content);

	// Only sections the model actually filled in are returned. An empty heading
	// reads as a section the analysis failed to fill, which is a different claim
	// from "the evidence did not support one" — and the prompt is explicit that
	// weak evidence should be said out loud rather than padded.
	const prose = PROSE_FIELDS.flatMap(({ key, label }) => {
		const body = str(c[key]);
		return body ? [{ key, label, body }] : [];
	});

	const details = obj(c.keyDetails);
	const keyDetails = KEY_DETAIL_FIELDS.flatMap(({ key, label }) => {
		const body = str(details[key]);
		return body ? [{ key, label, body }] : [];
	});

	const buckets = BUCKET_FIELDS.flatMap((section) => {
		const source = obj(c[section.key]);
		const filled = section.buckets.flatMap((b) => {
			const items = classified(source[b.key]);
			return items.length > 0 ? [{ ...b, items }] : [];
		});
		return filled.length > 0
			? [{ key: section.key, label: section.label, buckets: filled }]
			: [];
	});

	// Since Fizzy #1851 Task 11 every live caller feeds
	// `EffectiveAnalysis["data"]` — the media-tab gate in `TopicItemPage.tsx`
	// and the data sections in `PlanningAnalysisTab.tsx` — so the prose-only
	// keys (`topicAngle`, `risks`, `preDraftGuidance`, …) are simply absent
	// from the input and what comes back is the DATA half: buckets and source
	// signals. The prose-side branches below are kept, not dead-stripped,
	// because they are how this parser stays total over the schema: fed a raw
	// analysis row it still returns both halves, and no branch has to know
	// which of the two it was handed.
	return {
		prose,
		keyDetails,
		buckets,
		sourceSignals: strList(c.sourceSignals),
		risks: strList(c.risks),
		questions: readPlanningQuestions(content),
		preDraftGuidance: str(c.preDraftGuidance),
	};
}

/**
 * Just the questions, as the analysis itself raised them.
 *
 * No longer exported (2A-3): the Summary & Questions tab used to show these
 * straight from the blob, but a blob has no status and no answer, so the
 * decision-thread rows the analysis reconciles into (`reconcileTopicQuestions`)
 * are the source of truth for display now — `TopicQuestionsPanel` reads
 * `listTopicDecisions`, not this. What remains here is `readPlanningAnalysis`'s
 * own use below, assembling the worksheet's `questions` field, which is the
 * analysis's own record of what it raised, not a second rendering of it.
 */
function readPlanningQuestions(content: unknown): PlanningQuestion[] {
	const raw = obj(content).questions;
	if (!Array.isArray(raw)) {
		return [];
	}
	const out: PlanningQuestion[] = [];
	for (const item of raw) {
		const q = obj(item);
		const questionId = str(q.questionId);
		const question = str(q.question);
		if (!questionId || !question) {
			continue;
		}
		out.push({
			questionId,
			decisionKind: str(q.decisionKind) ?? "OTHER",
			subject: str(q.subject),
			question,
			recommendedResponse: str(q.recommendedResponse),
			whyItMatters: str(q.whyItMatters),
			source: q.source === "DERIVED" ? "DERIVED" : "MODEL",
		});
	}
	return out;
}

/**
 * A lenient, structure-agnostic "is there anything here at all" walk over an
 * `EffectiveAnalysis["data"]` value.
 *
 * Deliberately NOT `readPlanningAnalysis` + `isEmptyDocument`: that pair
 * validates each bucket item against the full recommendation shape (`type`
 * AND `rationale`), which is right for deciding what to RENDER but wrong for
 * deciding what counts as SUBSTANCE — a malformed or partial item is still
 * evidence the model (or a future producer of `data`) wrote something. This
 * walk only asks whether any leaf survives trimming.
 */
function isEmptyValue(value: unknown): boolean {
	if (value == null) {
		return true;
	}
	if (typeof value === "string") {
		return value.trim().length === 0;
	}
	if (Array.isArray(value)) {
		return value.every(isEmptyValue);
	}
	if (typeof value === "object") {
		return Object.values(value as Record<string, unknown>).every(
			isEmptyValue,
		);
	}
	// Numbers and booleans (e.g. `0`, `false`) are still real content.
	return false;
}

/**
 * True when there is nothing worth rendering.
 *
 * Takes the RESOLVER's output — AI text, or the author's own override — and
 * nothing else. It used to also accept a parsed `PlanningAnalysisDocument`,
 * because `PlanningAnalysisTab` still read the raw AI row directly; that
 * overload was scaffolding for Tasks 9-11 and went with Task 11, the commit
 * that moved the tab onto the resolver.
 *
 * Both halves have to be empty. `risks` and `preDraftGuidance` moved from
 * fields this file parsed off the raw AI JSON to PROSE (Fizzy #1851, Task 8),
 * so a check that inspected only the DATA half would call a risk-heavy
 * analysis "empty" the moment its substance moved into prose — which is
 * exactly the analysis the media-tab gate in `TopicItemPage.tsx` must NOT
 * suppress the generation tabs for.
 */
export function isEmptyAnalysis(effective: EffectiveAnalysis | null): boolean {
	if (effective === null) {
		return true;
	}
	return effective.prose.trim().length === 0 && isEmptyValue(effective.data);
}
