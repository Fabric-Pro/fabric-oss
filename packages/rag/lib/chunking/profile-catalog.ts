/**
 * The chunking profiles and their default sizes (spec 2026-10-28 §4, §6).
 * Free of imports so the RAG Settings page can show them without loading the
 * chunker; `profiles.ts` re-exports everything here.
 */

export const CHUNK_PROFILES = [
	"sectioned",
	"whole",
	"items",
	"dated",
	"dialogue",
	"tabular",
	"openapi",
	"prose",
] as const;

export type ChunkProfile = (typeof CHUNK_PROFILES)[number];

export interface ProfileSize {
	/** Units are merged up to this many characters. */
	target: number;
	/** A single unit longer than this is split. */
	max: number;
	/** Overlap; for `dialogue` it is counted in turns, otherwise characters. */
	overlap: number;
}

/** Sizes live in code in the first version (§6). `prose`/`openapi` use theirs. */
export const PROFILE_SIZES: Record<
	Exclude<ChunkProfile, "openapi" | "prose">,
	ProfileSize
> = {
	sectioned: { target: 2000, max: 4000, overlap: 0 },
	whole: { target: 6000, max: 6000, overlap: 0 },
	items: { target: 1200, max: 3000, overlap: 0 },
	dated: { target: 2000, max: 4000, overlap: 0 },
	dialogue: { target: 2000, max: 3000, overlap: 1 },
	tabular: { target: 2000, max: 3000, overlap: 0 },
};

/** Limits a per-type tuning must stay within. */
export const PROFILE_SIZE_LIMITS = {
	minTarget: 200,
	maxChars: 12000,
	maxOverlap: 2000,
} as const;

/** Split methods a Custom type can use: the project setting's own choices. */
export const CUSTOM_SPLIT_METHODS = [
	"DOCUMENT",
	"SEMANTIC",
	"PARAGRAPH",
	"RECURSIVE",
	"SENTENCE",
	"FIXED",
] as const;

export type CustomSplitMethod = (typeof CUSTOM_SPLIT_METHODS)[number];

/** Bounds of a Custom type's size and overlap, as the project sliders. */
export const CUSTOM_CHUNK_LIMITS = {
	minSize: 500,
	maxSize: 10000,
	maxOverlap: 2000,
} as const;

/**
 * What a caller knows about the content. Repository-import classifications,
 * Fabric document types and knowledge entries map onto these.
 */
export const CONTENT_KINDS = [
	"prd",
	"spec",
	"design",
	"readme",
	"reference",
	"adr",
	"decision",
	"note",
	"backlog",
	"tasks",
	"checklist",
	"journal",
	"changelog",
	"release-notes",
	"meeting-series",
	"transcript",
	"chat",
	"csv",
	"spreadsheet",
	"openapi",
	"knowledge",
	"other",
] as const;

export type ContentKind = (typeof CONTENT_KINDS)[number];

export function isContentKind(value: unknown): value is ContentKind {
	return (
		typeof value === "string" &&
		(CONTENT_KINDS as readonly string[]).includes(value)
	);
}

export function isChunkProfile(value: unknown): value is ChunkProfile {
	return (
		typeof value === "string" &&
		(CHUNK_PROFILES as readonly string[]).includes(value)
	);
}
