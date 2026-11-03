/**
 * Chunking analysis and tuning (spec 2026-10-28 §8b "Measure", §8c).
 *
 * The deterministic parts live here, pure and testable: profiling the
 * content, sampling, the candidate settings per content type, retrieval
 * scoring (recall@k, MRR) and choosing the winner. The model (question
 * generation) and the embeddings are called by the analysis workflow, which
 * hands their results to these functions.
 */

import { chooseChunkProfile } from "./content-routing";
import {
	type ChunkProfile,
	type ChunkProfileTuning,
	type ContentKind,
	chunkWithProfile,
	PROFILE_SIZES,
} from "./profiles";

/** Fewer sources of a type than this: no experiment, the §5 default. */
export const MIN_SOURCES_TO_MEASURE = 5;
/** Sources sampled per content type. */
export const MAX_SAMPLE_PER_TYPE = 20;
/** Questions the model writes per sampled source. */
export const QUESTIONS_PER_SOURCE = 4;
/** A candidate within this much recall of the best may win on cost. */
export const RECALL_TOLERANCE = 0.05;

export interface AnalysisSource {
	id: string;
	contentType: string;
	kind?: ContentKind;
	mimeType: string;
	filename: string;
	text: string;
}

/**
 * The group a source is analysed and tuned under: its known kind, else the
 * profile its content's own shape suggests (§5 step 3), else `prose`. Profile
 * names are valid `chunkProfiles` keys, so a tuning chosen for a detected
 * group applies to the same content at chunking time.
 */
export function contentGroupFor(params: {
	kind?: ContentKind;
	content: string;
	mimeType: string;
	filename: string;
}): string {
	if (params.kind) {
		return params.kind;
	}
	return chooseChunkProfile({
		content: params.content,
		mimeType: params.mimeType,
		filename: params.filename,
	}).profile;
}

export interface SourceProfile {
	id: string;
	contentType: string;
	length: number;
	headings: number;
	listRatio: number;
	datedHeadings: number;
	speakerLines: number;
	/** The profile §5 would choose today. */
	profile: ChunkProfile;
}

const HEADING = /^#{1,6}\s+\S/;
const LIST_OR_TABLE = /^\s*(?:[-*+]|\d{1,4}[.)]|\|)\s*\S/;
const DATED = /\b(\d{4}-\d{2}-\d{2}|v?\d+\.\d+(?:\.\d+)?)\b/;
const SPEAKER =
	/^(?:\[?\d{1,2}:\d{2}(?::\d{2})?\]?\s*)?[A-Z][\w.'-]*(?: [A-Z][\w.'-]*){0,3}:\s+\S/;

/** Step 1: deterministic features of one source. */
export function profileSource(source: AnalysisSource): SourceProfile {
	const lines = source.text.split("\n").map((l) => l.slice(0, 400));
	const nonBlank = lines.filter((l) => l.trim().length > 0);
	const headings = lines.filter((l) => HEADING.test(l));
	return {
		id: source.id,
		contentType: source.contentType,
		length: source.text.length,
		headings: headings.length,
		listRatio:
			nonBlank.length === 0
				? 0
				: nonBlank.filter((l) => LIST_OR_TABLE.test(l)).length /
					nonBlank.length,
		datedHeadings: headings.filter((h) => DATED.test(h)).length,
		speakerLines: nonBlank.filter((l) => SPEAKER.test(l.trim())).length,
		profile: chooseChunkProfile({
			content: source.text,
			mimeType: source.mimeType,
			filename: source.filename,
			kind: source.kind,
		}).profile,
	};
}

export interface TypeProfile {
	contentType: string;
	sources: number;
	totalChars: number;
	medianChars: number;
	/** The profile most sources of this type get today. */
	defaultProfile: ChunkProfile;
	measurable: boolean;
}

export function profileByType(profiles: SourceProfile[]): TypeProfile[] {
	const groups = new Map<string, SourceProfile[]>();
	for (const p of profiles) {
		groups.set(p.contentType, [...(groups.get(p.contentType) ?? []), p]);
	}
	return [...groups.entries()]
		.map(([contentType, list]) => {
			const lengths = list.map((p) => p.length).sort((a, b) => a - b);
			const votes = new Map<ChunkProfile, number>();
			for (const p of list) {
				votes.set(p.profile, (votes.get(p.profile) ?? 0) + 1);
			}
			const defaultProfile = [...votes.entries()].sort(
				(a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
			)[0]?.[0] as ChunkProfile;
			return {
				contentType,
				sources: list.length,
				totalChars: lengths.reduce((s, n) => s + n, 0),
				medianChars: lengths[Math.floor((lengths.length - 1) / 2)] ?? 0,
				defaultProfile,
				measurable: list.length >= MIN_SOURCES_TO_MEASURE,
			};
		})
		.sort((a, b) => b.sources - a.sources);
}

/**
 * The sample of one type: evenly spread over the sources sorted by id, so
 * the same project gives the same sample on every run.
 */
export function sampleSources<T extends { id: string }>(
	sources: T[],
	max = MAX_SAMPLE_PER_TYPE,
): T[] {
	const sorted = [...sources].sort((a, b) => a.id.localeCompare(b.id));
	if (sorted.length <= max) {
		return sorted;
	}
	const step = sorted.length / max;
	return Array.from(
		{ length: max },
		(_, i) => sorted[Math.floor(i * step)] as T,
	);
}

export interface AnalysisEstimate {
	types: Array<{ contentType: string; sources: number; sampled: number }>;
	sampledSources: number;
	questions: number;
	/** Embedding calls: candidate chunks of the sample, plus the questions. */
	embeddingCalls: number;
}

export function estimateAnalysis(
	byType: TypeProfile[],
	candidatesPerType: number,
): AnalysisEstimate {
	const types = byType.map((t) => ({
		contentType: t.contentType,
		sources: t.sources,
		sampled: t.measurable ? Math.min(t.sources, MAX_SAMPLE_PER_TYPE) : 0,
	}));
	const sampledSources = types.reduce((s, t) => s + t.sampled, 0);
	const questions = sampledSources * QUESTIONS_PER_SOURCE;
	const avgChunksPerSource = 4;
	return {
		types,
		sampledSources,
		questions,
		embeddingCalls:
			sampledSources * avgChunksPerSource * candidatesPerType + questions,
	};
}

export interface Candidate {
	/** Stable key, e.g. `items:1200/3000`, or `current` for the project setting. */
	key: string;
	profile: ChunkProfile;
	tuning?: ChunkProfileTuning;
	/** The setting the project uses today for this type. */
	current: boolean;
}

function sized(
	profile: Exclude<ChunkProfile, "openapi" | "prose">,
	factor: number,
): ChunkProfileTuning {
	const base = PROFILE_SIZES[profile];
	return {
		profile,
		target: Math.round((base.target * factor) / 100) * 100,
		max: Math.round((base.max * factor) / 100) * 100,
	};
}

/**
 * Step 3: 2–4 candidates for a type — the current setting, the type's
 * default profile, and that profile at neighbouring sizes. MEASURE runs only
 * the current one.
 */
export function candidatesFor(
	type: TypeProfile,
	current: { profile: ChunkProfile; tuning?: ChunkProfileTuning },
	mode: "MEASURE" | "TUNE",
): Candidate[] {
	const currentCandidate: Candidate = {
		key: "current",
		profile: current.profile,
		tuning: current.tuning,
		current: true,
	};
	if (mode === "MEASURE") {
		return [currentCandidate];
	}
	const out: Candidate[] = [currentCandidate];
	const profile = type.defaultProfile;
	if (profile !== "prose" && profile !== "openapi") {
		for (const factor of [1, 0.6, 1.5]) {
			const tuning = sized(profile, factor);
			const key = `${profile}:${tuning.target}/${tuning.max}`;
			if (
				!(
					current.profile === profile &&
					current.tuning?.target === tuning.target
				)
			) {
				out.push({ key, profile, tuning, current: false });
			}
		}
	}
	return out.slice(0, 4);
}

/** Chunk one source with a candidate; `prose` is the caller's fallback. */
export function chunkForCandidate(
	source: AnalysisSource,
	candidate: Candidate,
	prose: (text: string) => string[],
): string[] {
	if (candidate.profile === "prose" || candidate.profile === "openapi") {
		return prose(source.text);
	}
	return chunkWithProfile(
		source.text,
		source.filename,
		candidate.profile,
		candidate.tuning,
	).map((c) => c.chunk.content);
}

export interface EvalQuestion {
	sourceId: string;
	question: string;
	/** A passage copied from the source that answers the question. */
	answer: string;
}

function normalize(text: string): string {
	return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Whether a chunk holds the answer: the chunk is from the right source and
 * contains the answer passage, or most of it when the passage was cut.
 */
export function chunkAnswers(
	chunk: { sourceId: string; text: string },
	question: EvalQuestion,
): boolean {
	if (chunk.sourceId !== question.sourceId) {
		return false;
	}
	const text = normalize(chunk.text);
	const answer = normalize(question.answer);
	if (answer.length === 0) {
		return false;
	}
	if (text.includes(answer)) {
		return true;
	}
	const words = answer.split(" ").filter((w) => w.length > 3);
	if (words.length === 0) {
		return false;
	}
	const found = words.filter((w) => text.includes(w)).length;
	return found / words.length >= 0.8;
}

export interface RankedChunk {
	sourceId: string;
	text: string;
	score: number;
}

export function cosine(a: number[], b: number[]): number {
	let dot = 0;
	let na = 0;
	let nb = 0;
	for (let i = 0; i < a.length; i++) {
		const x = a[i] as number;
		const y = b[i] as number;
		dot += x * y;
		na += x * x;
		nb += y * y;
	}
	return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/** Retrieval over a candidate's chunks, with the project's Top K and threshold. */
export function rankChunks(
	queryEmbedding: number[],
	chunks: Array<{ sourceId: string; text: string; embedding: number[] }>,
	topK: number,
	threshold: number,
): RankedChunk[] {
	return chunks
		.map((c) => ({
			sourceId: c.sourceId,
			text: c.text,
			score: cosine(queryEmbedding, c.embedding),
		}))
		.filter((c) => c.score >= threshold)
		.sort((a, b) => b.score - a.score)
		.slice(0, topK);
}

export interface RetrievalScore {
	questions: number;
	/** Share of questions with an answering chunk in the top K. */
	recallAtK: number;
	/** Mean reciprocal rank of the first answering chunk. */
	mrr: number;
}

export function scoreRetrieval(
	results: Array<{ question: EvalQuestion; ranked: RankedChunk[] }>,
): RetrievalScore {
	if (results.length === 0) {
		return { questions: 0, recallAtK: 0, mrr: 0 };
	}
	let hits = 0;
	let reciprocal = 0;
	for (const { question, ranked } of results) {
		const rank = ranked.findIndex((c) => chunkAnswers(c, question));
		if (rank >= 0) {
			hits++;
			reciprocal += 1 / (rank + 1);
		}
	}
	return {
		questions: results.length,
		recallAtK: hits / results.length,
		mrr: reciprocal / results.length,
	};
}

export interface ScoredCandidate {
	candidate: Candidate;
	score: RetrievalScore;
	/** Chunks the candidate cuts the sample into (cost). */
	chunks: number;
	embeddingTokens: number;
}

/**
 * Step 4: among the candidates within {@link RECALL_TOLERANCE} of the best
 * recall, the cheapest (fewest chunks) wins; a tie goes to the current one.
 */
export function pickWinner(scored: ScoredCandidate[]): ScoredCandidate | null {
	if (scored.length === 0) {
		return null;
	}
	const best = Math.max(...scored.map((s) => s.score.recallAtK));
	const eligible = scored.filter(
		(s) => s.score.recallAtK >= best - RECALL_TOLERANCE,
	);
	return (
		[...eligible].sort(
			(a, b) =>
				a.chunks - b.chunks ||
				Number(b.candidate.current) - Number(a.candidate.current) ||
				b.score.mrr - a.score.mrr,
		)[0] ?? null
	);
}

export interface ProposalRow {
	contentType: string;
	sources: number;
	current: string;
	proposed: string;
	/** Recall before → after; null when the type was not measured. */
	recallBefore: number | null;
	recallAfter: number | null;
	/** Chunks after the change for the sample, to show re-embed cost. */
	reembedChunks: number | null;
	reason: string;
	/** What applying writes into `chunkProfiles` for this type. */
	tuning: ChunkProfileTuning | null;
}

export function describeCandidate(candidate: Candidate): string {
	if (candidate.profile === "prose") {
		return "project setting";
	}
	return candidate.tuning?.target
		? `${candidate.profile} (${candidate.tuning.target}/${candidate.tuning.max})`
		: candidate.profile;
}

/** Step 5: one proposal row per type. */
export function proposalRow(params: {
	type: TypeProfile;
	scored: ScoredCandidate[];
	/** The setting the type uses today, named even when it was not measured. */
	currentSetting?: { profile: ChunkProfile; tuning?: ChunkProfileTuning };
}): ProposalRow {
	const { type, scored, currentSetting } = params;
	const current = scored.find((s) => s.candidate.current);
	if (!type.measurable || scored.length === 0) {
		return {
			contentType: type.contentType,
			sources: type.sources,
			current: current
				? describeCandidate(current.candidate)
				: currentSetting
					? describeCandidate({
							key: "current",
							current: true,
							...currentSetting,
						})
					: "–",
			proposed: type.defaultProfile,
			recallBefore: null,
			recallAfter: null,
			reembedChunks: null,
			reason: "not enough content to measure",
			tuning:
				type.defaultProfile === "prose" ||
				type.defaultProfile === "openapi"
					? null
					: { profile: type.defaultProfile },
		};
	}
	const winner = pickWinner(scored) as ScoredCandidate;
	const keep = winner.candidate.current;
	return {
		contentType: type.contentType,
		sources: type.sources,
		current: current ? describeCandidate(current.candidate) : "–",
		proposed: describeCandidate(winner.candidate),
		recallBefore: current?.score.recallAtK ?? null,
		recallAfter: winner.score.recallAtK,
		reembedChunks: keep ? 0 : winner.chunks,
		reason: keep
			? "the current setting is as good as any candidate"
			: winner.score.recallAtK > (current?.score.recallAtK ?? 0)
				? "finds more answers"
				: "as good, with fewer chunks",
		tuning: keep
			? null
			: (winner.candidate.tuning ?? {
					profile: winner.candidate.profile,
				}),
	};
}
