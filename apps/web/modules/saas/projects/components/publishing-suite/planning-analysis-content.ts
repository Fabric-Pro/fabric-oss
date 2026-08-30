/**
 * The shape of a Planning & Analysis document, read defensively.
 *
 * `content` arrives as a `Json` column, so nothing at the type level stops it
 * holding a string, a number, or an object written by an older build. Every
 * accessor here drops what it cannot understand rather than throwing: a panel
 * that renders nothing is a bad afternoon, a panel that crashes the Topic Item
 * Page takes the whole topic with it.
 *
 * The section ORDER lives here too, and it is the same order the seeded prompt
 * asks the model to produce, so the page reads the way the prompt was written.
 */

interface ClassifiedRecommendation {
	type: string;
	rationale: string;
}

export interface PlanningQuestion {
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
 * Just the questions.
 *
 * Exported separately because the Summary & Questions tab shows them without
 * the rest of the worksheet (FR39) — and reading them through the same function
 * is what stops the two surfaces disagreeing about which questions are open.
 */
export function readPlanningQuestions(content: unknown): PlanningQuestion[] {
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

/** True when the document has nothing worth rendering. */
export function isEmptyAnalysis(doc: PlanningAnalysisDocument): boolean {
	return (
		doc.prose.length === 0 &&
		doc.keyDetails.length === 0 &&
		doc.buckets.length === 0 &&
		doc.sourceSignals.length === 0 &&
		doc.risks.length === 0 &&
		doc.questions.length === 0 &&
		doc.preDraftGuidance === null
	);
}
