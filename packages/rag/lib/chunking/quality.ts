/**
 * How good is a project's current chunking (spec 2026-10-28 §8b).
 *
 * Read-only and cheap: works from the chunks already stored for each source
 * and the source's own text, with no model. Shown for any project, including
 * one that never changes a setting.
 */

import { KNOWLEDGE_LEGACY_MAX_CHARS } from "./knowledge";

/** Chunks shorter than this are reported as tiny. */
export const TINY_CHUNK_CHARS = 200;

export interface QualitySource {
	id: string;
	/** Grouping key: the content kind, or the source's system type. */
	contentType: string;
	/** Length of the source's stored text. */
	textLength: number;
	embedded: boolean;
	/** Stored chunks in order; empty when none were found. */
	chunks: Array<{
		content: string;
		profile?: string | null;
		/** Heading path a profile put in front of the chunk. */
		section?: string | null;
	}>;
	/** A knowledge entry: today's cut applies when chunking is off. */
	knowledge?: boolean;
}

export interface SizeDistribution {
	min: number;
	p50: number;
	p90: number;
	max: number;
}

export interface ContentTypeQuality {
	contentType: string;
	sources: number;
	chunks: number;
	sizes: SizeDistribution | null;
	/** Profiles seen on the stored chunks; `setting` for pre-profile chunks. */
	profiles: string[];
}

export interface ChunkingProblems {
	cutMidSentence: number;
	cutMidListItem: number;
	splitTables: number;
	tinyChunks: number;
	notEmbedded: number;
	truncatedKnowledge: { entries: number; charactersLost: number };
}

export interface ChunkingQualityReport {
	byType: ContentTypeQuality[];
	problems: ChunkingProblems;
	/** Example source ids per problem, at most five each. */
	examples: Partial<
		Record<keyof Omit<ChunkingProblems, "truncatedKnowledge">, string[]>
	>;
}

function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) {
		return 0;
	}
	const index = Math.min(
		sorted.length - 1,
		Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
	);
	return sorted[index] as number;
}

export function sizeDistribution(sizes: number[]): SizeDistribution | null {
	if (sizes.length === 0) {
		return null;
	}
	const sorted = [...sizes].sort((a, b) => a - b);
	return {
		min: sorted[0] as number,
		p50: percentile(sorted, 50),
		p90: percentile(sorted, 90),
		max: sorted[sorted.length - 1] as number,
	};
}

const LIST_LINE = /^\s*(?:[-*+]|\d{1,4}[.)])\s+\S/;
const TABLE_LINE = /^\s*\|.*\|\s*$/;
/** A chunk ending like this ended at a natural boundary. */
const CLEAN_END = /(?:[.!?:;)"'`\]*_]|\n)\s*$/;

function lastLine(text: string): string {
	const trimmed = text.replace(/\s+$/, "");
	return trimmed.slice(trimmed.lastIndexOf("\n") + 1);
}

function firstLine(text: string): string {
	const trimmed = text.replace(/^\s+/, "");
	const at = trimmed.indexOf("\n");
	return at === -1 ? trimmed : trimmed.slice(0, at);
}

const TABLE_SEPARATOR_LINE =
	/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

/** A chunk that opens with a header row and its separator reads on its own. */
function repeatsTableHeader(text: string): boolean {
	const lines = text.replace(/^\s+/, "").split("\n", 2);
	return TABLE_SEPARATOR_LINE.test(lines[1] ?? "");
}

/**
 * A profile opens a chunk with its heading path (or the ancestors of its
 * own heading); that label is not where the cut fell, so judge what follows.
 */
function withoutSectionPrefix(
	text: string,
	section: string | null | undefined,
): string {
	if (!section) {
		return text;
	}
	const trimmed = text.replace(/^\s+/, "");
	const label = firstLine(trimmed).trim();
	return label.length > 0 && section.startsWith(label)
		? trimmed.slice(trimmed.indexOf(label) + label.length)
		: text;
}

/**
 * Where the boundary between two consecutive chunks of one source falls.
 * Overlap and heading prefixes make the next chunk start with text the
 * previous one had; only the shape at the cut is judged.
 */
export function classifyBoundary(
	previous: string,
	nextChunk: string,
	nextSection?: string | null,
): "clean" | "mid-sentence" | "mid-list-item" | "split-table" {
	const next = withoutSectionPrefix(nextChunk, nextSection);
	const prevLast = lastLine(previous);
	const nextFirst = firstLine(next);
	if (
		TABLE_LINE.test(prevLast) &&
		TABLE_LINE.test(nextFirst) &&
		!repeatsTableHeader(next)
	) {
		return "split-table";
	}
	if (
		LIST_LINE.test(prevLast) &&
		nextFirst.length > 0 &&
		!LIST_LINE.test(nextFirst) &&
		!/^#{1,6}\s/.test(nextFirst) &&
		/^[a-z0-9]/.test(nextFirst.trim())
	) {
		return "mid-list-item";
	}
	if (!CLEAN_END.test(previous) && /^[a-z]/.test(nextFirst.trim())) {
		return "mid-sentence";
	}
	return "clean";
}

export function analyzeChunkQuality(
	sources: QualitySource[],
): ChunkingQualityReport {
	const problems: ChunkingProblems = {
		cutMidSentence: 0,
		cutMidListItem: 0,
		splitTables: 0,
		tinyChunks: 0,
		notEmbedded: 0,
		truncatedKnowledge: { entries: 0, charactersLost: 0 },
	};
	const examples: ChunkingQualityReport["examples"] = {};
	const note = (key: keyof ChunkingQualityReport["examples"], id: string) => {
		const list = examples[key] ?? [];
		if (list.length < 5 && !list.includes(id)) {
			list.push(id);
		}
		examples[key] = list;
	};

	const groups = new Map<
		string,
		{ sources: number; sizes: number[]; profiles: Set<string> }
	>();

	for (const source of sources) {
		const group = groups.get(source.contentType) ?? {
			sources: 0,
			sizes: [],
			profiles: new Set<string>(),
		};
		group.sources++;
		groups.set(source.contentType, group);

		if (!source.embedded || source.chunks.length === 0) {
			problems.notEmbedded++;
			note("notEmbedded", source.id);
			continue;
		}

		if (source.knowledge && source.chunks.length === 1) {
			const lost = source.textLength - KNOWLEDGE_LEGACY_MAX_CHARS;
			if (lost > 0) {
				problems.truncatedKnowledge.entries++;
				problems.truncatedKnowledge.charactersLost += lost;
			}
		}

		source.chunks.forEach((chunk, index) => {
			group.sizes.push(chunk.content.length);
			group.profiles.add(chunk.profile ?? "setting");
			// A source that is one short chunk is short content, not a
			// fragment; only a fragment of a longer source counts as tiny.
			if (
				chunk.content.trim().length < TINY_CHUNK_CHARS &&
				source.chunks.length > 1
			) {
				problems.tinyChunks++;
				note("tinyChunks", source.id);
			}
			const next = source.chunks[index + 1];
			if (!next) {
				return;
			}
			switch (
				classifyBoundary(chunk.content, next.content, next.section)
			) {
				case "mid-sentence":
					problems.cutMidSentence++;
					note("cutMidSentence", source.id);
					break;
				case "mid-list-item":
					problems.cutMidListItem++;
					note("cutMidListItem", source.id);
					break;
				case "split-table":
					problems.splitTables++;
					note("splitTables", source.id);
					break;
				default:
					break;
			}
		});
	}

	const byType = [...groups.entries()]
		.map(([contentType, group]) => ({
			contentType,
			sources: group.sources,
			chunks: group.sizes.length,
			sizes: sizeDistribution(group.sizes),
			profiles: [...group.profiles].sort(),
		}))
		.sort((a, b) => b.sources - a.sources);

	return { byType, problems, examples };
}
