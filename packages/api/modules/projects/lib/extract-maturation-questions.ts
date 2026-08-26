/**
 * Question-extraction bridge (Feature Maturation V2, §5.2).
 *
 * The stage-enhance prompts surface open questions as markdown sections inside the
 * feature doc ("Open Questions (Discovery)", "Questions (Prioritized)", "Open
 * Questions", "Critical & High Outstanding Questions", …). This module mints
 * those — and ONLY those — as OPEN `DecisionLogEntry` roots so the Summary &
 * Questions tab can surface them.
 *
 * "Initial Questions" is DELIBERATELY skipped. The placeholder stage emits both an
 * "Initial Questions" draft AND a refined "Open Questions (Discovery)" set in a
 * single pass; surfacing both double-counts the same concerns (e.g. the toolkit
 * question appears in each, worded differently, so exact-text dedupe misses it).
 * We treat "Initial Questions" as the draft and read only the refined section.
 *
 * DELIBERATELY SECTION-COUPLED (reversing the earlier "section-agnostic" design).
 * Extraction is now a DETERMINISTIC parse of the spec's question-headed sections —
 * NOT an LLM gap-analysis. The LLM pass invented questions beyond what the spec
 * actually stated (the recurring "I see more questions than the spec lists"
 * complaint); a parser cannot invent. Trade-off: a future prompt that renames a
 * question heading away from "…Question…" would drop it (caught by the unit
 * tests). Forward-only: pre-existing inferred OPEN roots from older LLM runs are
 * not deleted here.
 *
 * Dedupe is by a STABLE key from the normalized question text, so re-parsing after
 * the next run does not re-mint an already open/answered question. Resolved /
 * struck-through items in the spec are skipped.
 *
 * PM-sync isolation (§7.7): minting OPEN question roots writes a maturation
 * surface, never `description`/`acceptanceCriteria`, so it never triggers PM sync.
 */

import { createHash } from "node:crypto";
import {
	createDecisionLogEntry,
	type FeatureMaturationState,
	findDecisionByQuestionId,
	isAiAnswerRecommendationsEnabled,
	type MaturationTenantFilter,
	markQuestionsPossiblyResolved,
	setQuestionStatus,
} from "@repo/database";
import { combineCleanSpec } from "@repo/utils/clean-spec-content";
import { stripInlineDecoration } from "@repo/utils/markdown-heading";
import { classifyQuestionTopics } from "./classify-question-topics";
import { proposeQuestionAnswers } from "./propose-question-answers";

export interface ExtractedQuestion {
	question: string;
	impactedSection: string | null;
}

const HEADING_RE = /^#{1,6}\s+(.+?)\s*$/;
/**
 * Question-headed sections treated as DRAFT and skipped — superseded by the
 * refined "Open Questions (Discovery)" set the same placeholder run emits.
 *
 * `^…$`-anchored, so it is tested against the NORMALIZED heading text: a PO who
 * highlights or bolds the "Initial Questions" heading in the editor stores
 * `<mark data-color="#fef08a">Initial Questions</mark>` / `**Initial
 * Questions**`, neither of which this anchored pattern can match. The skip would
 * then silently stop applying and the draft questions would leak into the minted
 * set alongside their refined duplicates — the exact double-count this rule
 * exists to prevent.
 */
const SKIP_QUESTION_HEADING_RE = /^initial\s+questions?$/i;
/** A list item at the section's base indent (0–2 spaces): `- `, `* `, `1. `, `1) `. */
const TOP_ITEM_RE = /^\s{0,2}(?:[-*+]|\d+[.)])\s+(.+?)\s*$/;
/** Sub-bullet labels used under a prioritized question — never questions themselves. */
const LABEL_RE =
	/^(?:why it matters|options?|recommendation|owner|decider|who likely has it|needed input|reason|suggested scope|status|evidence)\b/i;

/** A question item is "resolved" when struck through or marked resolved/decided. */
function isResolvedItem(raw: string): boolean {
	return (
		/~~/.test(raw) || /\b(?:resolved|answered|decided)\b\s*[:-]/i.test(raw)
	);
}

/** Strip a leading "Q:"/"Question:" label and markdown emphasis; trim. */
function cleanQuestionText(raw: string): string {
	let t = raw.trim();
	t = t.replace(/^(?:q|question)\s*[:.)-]\s*/i, "");
	t = t.replace(/\*\*/g, "").replace(/__/g, "");
	t = t.replace(/(^|\s)[*_]([^*_]+)[*_]/g, "$1$2");
	return t.trim();
}

/**
 * Parse the open questions literally stated in a spec's question-headed sections.
 * Pure — no model call. Yields exactly the stated, unresolved questions and
 * nothing inferred.
 */
export function parseSpecQuestions(spec: string): ExtractedQuestion[] {
	const out: ExtractedQuestion[] = [];
	const seen = new Set<string>();
	let heading: string | null = null;
	let inQuestionSection = false;

	for (const line of spec.split("\n")) {
		const h = line.match(HEADING_RE);
		if (h) {
			heading = h[1].trim();
			// Both section tests run on the normalized heading text so editor
			// decoration (highlight, bold, code) can't turn a question section
			// off — `cleanQuestionText` below already strips emphasis from ITEM
			// text, and this closes the same gap for the heading. The normalized
			// string is for MATCHING ONLY (it is lossy); `heading` keeps the
			// original text, which is what gets stored as `impactedSection`.
			const headingText = stripInlineDecoration(heading);
			inQuestionSection =
				/question/i.test(headingText) &&
				!SKIP_QUESTION_HEADING_RE.test(headingText);
			continue;
		}
		if (!inQuestionSection) {
			continue;
		}
		const item = line.match(TOP_ITEM_RE);
		if (!item) {
			continue;
		}
		const raw = item[1];
		if (isResolvedItem(raw) || LABEL_RE.test(raw.trim())) {
			continue;
		}
		const text = cleanQuestionText(raw);
		// A real question is a sentence; drop fragments / stray labels.
		if (
			text.length < 8 ||
			(!text.includes("?") && text.split(/\s+/).length < 4)
		) {
			continue;
		}
		const key = text.toLowerCase().replace(/\s+/g, " ").trim();
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		out.push({ question: text, impactedSection: heading });
	}
	return out;
}

/**
 * Stable dedupe key for a question: normalize (lowercase, collapse whitespace,
 * drop surrounding punctuation) then hash. The same question re-parsed later
 * yields the same key, so `findDecisionByQuestionId` skips re-minting it.
 */
export function questionStableKey(question: string): string {
	const normalized = question
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, "")
		.replace(/\s+/g, " ")
		.trim();
	return `q_${createHash("sha256").update(normalized).digest("hex").slice(0, 16)}`;
}

interface MintedQuestion {
	id: string;
	question: string;
	impactedSection: string | null;
	topic: string | null;
}

export interface ExtractionResult {
	/** Questions parsed from the spec's question sections. */
	extracted: number;
	/** New OPEN roots minted this run. */
	minted: number;
	/** Parsed questions already present (open or answered) — not re-minted. */
	skipped: number;
	/** Soft-closed (`POSSIBLY_RESOLVED`) OPEN roots the refreshed spec no longer lists (#5). */
	softClosed: number;
	/** `POSSIBLY_RESOLVED` roots reactivated to OPEN because the refresh re-emitted them (#5). */
	reactivated: number;
	/** The newly minted question roots. */
	questions: MintedQuestion[];
}

export interface ExtractMaturationQuestionsParams {
	feature: FeatureMaturationState;
	tenantFilter: MaturationTenantFilter;
}

const SUMMARY_MAX = 280;

/**
 * Parse the feature's question sections and mint any genuinely new ones as OPEN,
 * AGENT-authored Decision Log roots. Idempotent at the question level: a question
 * already open or already resolved is skipped.
 */
export async function extractMaturationQuestions({
	feature,
	tenantFilter,
}: ExtractMaturationQuestionsParams): Promise<ExtractionResult> {
	const spec = combineCleanSpec(
		feature.description,
		feature.acceptanceCriteria,
	);
	if (!spec.trim()) {
		return {
			extracted: 0,
			minted: 0,
			skipped: 0,
			softClosed: 0,
			reactivated: 0,
			questions: [],
		};
	}

	const parsed = parseSpecQuestions(spec);

	// Phase 1 — dedupe: keep only questions with no existing root for their stable
	// key (an OPEN or already-answered match must NOT be re-minted). A match that is
	// currently POSSIBLY_RESOLVED is REACTIVATED to OPEN — the refresh re-emitted a
	// question a prior reconciliation soft-closed (#5).
	let skipped = 0;
	let reactivated = 0;
	const presentQuestionIds: string[] = [];
	const toMint: Array<{
		text: string;
		questionId: string;
		impactedSection: string | null;
	}> = [];
	for (const q of parsed) {
		const text = q.question.trim();
		if (!text) {
			continue;
		}
		const questionId = questionStableKey(text);
		presentQuestionIds.push(questionId);
		const existing = await findDecisionByQuestionId({
			tenantFilter,
			userStoryId: feature.id,
			questionId,
		});
		if (existing) {
			if (existing.status === "POSSIBLY_RESOLVED") {
				const flipped = await setQuestionStatus({
					tenantFilter,
					rootId: existing.id,
					status: "OPEN",
				});
				if (flipped > 0) {
					reactivated++;
				}
			}
			skipped++;
			continue;
		}
		toMint.push({
			text,
			questionId,
			impactedSection: q.impactedSection ?? null,
		});
	}

	// Phase 2 — classify only the genuinely-new questions into topics (one batched,
	// best-effort model call; falls back to "Other" and never throws).
	const topics = await classifyQuestionTopics({
		questions: toMint.map((q) => q.text),
		tenantFilter,
	});

	// Phase 3 — mint each new question as an OPEN AGENT root carrying its topic.
	let minted = 0;
	const questions: MintedQuestion[] = [];
	for (let i = 0; i < toMint.length; i++) {
		const { text, questionId, impactedSection } = toMint[i];
		const topic = topics[i] ?? null;
		const root = await createDecisionLogEntry({
			tenantFilter,
			userStoryId: feature.id,
			authorType: "AGENT",
			status: "OPEN",
			content: text,
			summary:
				text.length > SUMMARY_MAX
					? `${text.slice(0, SUMMARY_MAX - 1)}…`
					: text,
			questionId,
			impactedSection,
			topic,
		});
		minted++;
		questions.push({
			id: root.id,
			question: text,
			impactedSection: root.impactedSection,
			topic: root.topic,
		});
	}

	// Phase 3b — AI answer recommendations (#7). Best-effort: stamps each freshly
	// minted root's metadata with suggested options (each justified) drawn from the
	// same context the spec was built from. Gated by the org dogfood flag (FR-15) AND
	// the per-feature toggle (default ON); never throws — a failure just leaves the
	// new questions un-recommended.
	if (
		feature.autoProposeAnswers &&
		questions.length > 0 &&
		(await isAiAnswerRecommendationsEnabled(tenantFilter.organizationId))
	) {
		await proposeQuestionAnswers({
			feature,
			questions: questions.map((q) => ({
				rootId: q.id,
				question: q.question,
			})),
			tenantFilter,
		});
	}

	// Phase 4 — reconcile (#5, option A+C): any OPEN question root the refreshed spec
	// no longer lists is soft-closed to POSSIBLY_RESOLVED (dropped from the active
	// list, never deleted — restorable, and reactivated above if it reappears). The
	// reactivated + newly-minted keys are all in `presentQuestionIds`, so they are
	// never closed by this pass.
	const softClosed = await markQuestionsPossiblyResolved({
		tenantFilter,
		userStoryId: feature.id,
		presentQuestionIds,
	});

	return {
		extracted: parsed.length,
		minted,
		skipped,
		softClosed,
		reactivated,
		questions,
	};
}
