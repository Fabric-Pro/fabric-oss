/**
 * Chunking for knowledge entries (spec 2026-10-28 §4, §7).
 *
 * Today an entry is one vector of its title and body, cut at 24,000
 * characters, so the tail of a long entry is never searchable. With
 * content-type chunking on, a short entry stays one `whole` chunk and a long
 * one is cut by `sectioned` (paragraphs when it has no headings), so all of it
 * is embedded. Off, the single cut text is returned exactly as before.
 *
 * The embed and delete paths for knowledge entries live with the knowledge
 * store; they take these chunks and point keys rather than deciding chunking
 * themselves, so `content-routing.ts` stays the one decision point.
 */

import { isContentAwareChunkingActive } from "./content-routing";
import {
	type ChunkProfile,
	type ChunkProfilesConfig,
	chunkWithProfile,
	isCustomChunking,
	type ProfileChunkPayload,
	profileForKind,
} from "./profiles";

/** Today's cut: title and body, at most this many characters, one vector. */
export const KNOWLEDGE_LEGACY_MAX_CHARS = 24_000;

/** The single text an entry is embedded as today. */
export function knowledgeEmbeddingText(entry: {
	title: string;
	body: string;
}): string {
	return `${entry.title}\n\n${entry.body}`.slice(
		0,
		KNOWLEDGE_LEGACY_MAX_CHARS,
	);
}

export interface KnowledgeChunk {
	/** Index within the entry; the point key is `knowledge:<entryId>:<index>`. */
	index: number;
	text: string;
	/** Empty when content-type chunking is off. */
	payload: ProfileChunkPayload & {
		profile?: ChunkProfile;
		profileReason?: "kind";
	};
}

/** Qdrant point key of one chunk of an entry (§7). */
export function knowledgePointKey(entryId: string, index: number): string {
	return `knowledge:${entryId}:${index}`;
}

export async function chunkKnowledgeEntry(params: {
	title: string;
	body: string;
	chunkByContentType?: boolean;
	organizationId?: string | null;
	chunkProfiles?: ChunkProfilesConfig;
}): Promise<KnowledgeChunk[]> {
	const contentAware = await isContentAwareChunkingActive({
		chunkByContentType: params.chunkByContentType,
		organizationId: params.organizationId,
		chunkProfiles: params.chunkProfiles,
	});
	// Knowledge on Custom keeps today's single point per entry.
	if (
		!contentAware ||
		isCustomChunking(
			params.chunkProfiles?.knowledge,
			params.chunkByContentType,
		)
	) {
		return [
			{ index: 0, text: knowledgeEmbeddingText(params), payload: {} },
		];
	}

	const full = `${params.title}\n\n${params.body}`;
	const profile = profileForKind("knowledge", full.length) ?? "whole";
	const tuning = params.chunkProfiles?.knowledge;
	const effective =
		tuning?.profile &&
		tuning.profile !== "prose" &&
		tuning.profile !== "openapi"
			? tuning.profile
			: profile === "whole" || profile === "sectioned"
				? profile
				: "sectioned";
	const pieces = chunkWithProfile(full, params.title, effective, tuning);
	return pieces.map((piece, index) => ({
		index,
		// A chunk taken out of a long entry still names the entry it came from.
		text:
			index === 0 || piece.chunk.content.startsWith(params.title)
				? piece.chunk.content
				: `${params.title}\n\n${piece.chunk.content}`,
		payload: {
			profile: effective,
			profileReason: "kind",
			...piece.payload,
		},
	}));
}

/** How much of an entry today's cut loses, for the quality panel (§8b). */
export function knowledgeTruncatedChars(entry: {
	title: string;
	body: string;
}): number {
	const full = entry.title.length + 2 + entry.body.length;
	return Math.max(0, full - KNOWLEDGE_LEGACY_MAX_CHARS);
}
