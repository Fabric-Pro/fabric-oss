/**
 * One place that decides how a piece of project-context content gets chunked.
 *
 * This exists because there were three copies of that decision — the file-upload
 * activity, the wizard activity, and `auto-embed` — each with its own
 * `detectChunkingStrategy` and its own thresholds. Three copies meant a spec
 * uploaded through the project uploader could be chunked by endpoint while the
 * same file uploaded during project creation was shredded into character
 * windows, and neither path errored: the upload succeeded, the contract was just
 * gone. A bug that looks like success is a bug that ships.
 *
 * Callers ask this module what to do and act on the answer, so adding a
 * structure-aware format in future is one change rather than three.
 */

import { isFeatureEnabled } from "@repo/database";
import { logger } from "@repo/logs";
import {
	describeOpenApiSpec,
	looksLikeOpenApiSpec,
	type OpenApiDescription,
} from "@repo/openapi-tools";
import { chunkText } from "./chunker";
import {
	chunkDescribedOpenApiSpec,
	type OpenApiChunk,
} from "./openapi-chunker";
import {
	type ChunkProfile,
	type ChunkProfileReason,
	type ChunkProfilesConfig,
	type ContentKind,
	chunkProseByBoundaries,
	chunkWithProfile,
	customChunkSettings,
	detectProfile,
	isCustomChunking,
	profileForKind,
} from "./profiles";
import type { ChunkingStrategy, TextChunk } from "./types";

/** Below this, content is embedded whole rather than chunked. */
export const CHUNKING_THRESHOLD = 2048;
export const DEFAULT_CHUNK_SIZE = 2048;
export const DEFAULT_CHUNK_OVERLAP = 200;

export type ContentRoute =
	| {
			/** Structure-aware: chunk by endpoint and model. */
			kind: "openapi";
			specVersion: string;
			/**
			 * The parsed document, carried so nothing downstream re-parses it.
			 * Without this the ingestion path parsed the same spec three times —
			 * once to detect, once to route, once to chunk — which on a
			 * multi-megabyte spec inside a Temporal activity is real CPU for
			 * nothing.
			 */
			description: OpenApiDescription;
	  }
	| {
			/** A document that declares itself a spec but cannot be read. */
			kind: "malformed-openapi";
			reason: string;
	  }
	| {
			/** Everything else — the pre-existing character-window behaviour. */
			kind: "text";
			strategy: ChunkingStrategy;
	  };

/**
 * The MIME-based strategy choice that predates this module.
 *
 * Behaviour is unchanged and deliberately so: this is the fallback for every
 * format that is not structure-aware, and altering it here would silently
 * re-chunk every existing context type.
 */
export function detectTextChunkingStrategy(
	mimeType: string,
): "DOCUMENT" | "PARAGRAPH" | "RECURSIVE" {
	if (
		mimeType.includes("markdown") ||
		mimeType.includes("text/plain") ||
		mimeType.includes("text/html")
	) {
		return "DOCUMENT";
	}
	if (
		mimeType.includes("pdf") ||
		mimeType.includes("word") ||
		mimeType.includes("document")
	) {
		return "PARAGRAPH";
	}
	return "RECURSIVE";
}

/** Only these can carry a spec; anything else skips the detection cost. */
function couldBeSpec(mimeType: string, filename: string): boolean {
	const lowerName = filename.toLowerCase();
	return (
		mimeType.includes("json") ||
		mimeType.includes("yaml") ||
		mimeType.includes("yml") ||
		lowerName.endsWith(".json") ||
		lowerName.endsWith(".yaml") ||
		lowerName.endsWith(".yml")
	);
}

/**
 * Decide how to chunk one piece of content.
 *
 * `text` is always a safe answer — a caller that cannot handle the `openapi`
 * route can treat it as `text` and lose only the structure, not the content.
 *
 * Async because the feature gate is a runtime toggle, not an environment
 * variable: `isFeatureEnabled` reads the override row an admin writes from the
 * console (falling back to `FABRIC_FEATURE_OPENAPI_SPEC_CONTEXT`, then to the
 * registry default), so turning this on or off is a flip rather than a
 * redeploy. The read is cached for ten seconds inside `@repo/database`, so the
 * per-call cost is a map lookup and a flip reaches a running worker within that
 * window. Resolved HERE rather than at each ingestion path, so there stays one
 * decision — the whole point of this module.
 */
export async function routeContentForChunking(params: {
	content: string;
	mimeType: string;
	filename: string;
}): Promise<ContentRoute> {
	const { content, mimeType, filename } = params;
	const textRoute: ContentRoute = {
		kind: "text",
		strategy: detectTextChunkingStrategy(mimeType),
	};

	if (!(await isFeatureEnabled("OPENAPI_SPEC_CONTEXT"))) {
		return textRoute;
	}

	if (!couldBeSpec(mimeType, filename)) {
		return textRoute;
	}

	const detection = looksLikeOpenApiSpec(content);
	switch (detection.kind) {
		case "spec": {
			// Describe here, once, and carry the result forward.
			try {
				return {
					kind: "openapi",
					specVersion: detection.specVersion,
					description: describeOpenApiSpec(content),
				};
			} catch (error) {
				return {
					kind: "malformed-openapi",
					reason:
						error instanceof Error
							? error.message
							: "Unknown parse error",
				};
			}
		}
		case "malformed":
			return { kind: "malformed-openapi", reason: detection.reason };
		default:
			// A `.json` that is not a spec is not an error — it is a JSON file.
			return textRoute;
	}
}

/**
 * Chunk one piece of project-context content, structure-aware where possible.
 *
 * The single entry point the ingestion paths call. Returning the route alongside
 * the chunks lets a caller stamp the right `ProjectContextType` and surface a
 * malformed spec, without re-running detection or duplicating the decision.
 */
export interface ProjectContentChunkResult {
	route: ContentRoute;
	/**
	 * The profile the content was chunked with. With content-type chunking off
	 * this is always `prose` (or `openapi` for a spec): today's behaviour.
	 */
	profile: ChunkProfile;
	reason: ChunkProfileReason;
	chunks: TextChunk[];
	/** Set when the content is a spec, so the caller can stamp `API_SPEC`. */
	contextTypeOverride?: "API_SPEC";
	/** Per-chunk Qdrant payload additions, index-aligned with `chunks`. */
	chunkPayloads: Array<Record<string, unknown>>;
}

/**
 * Payload fields for one chunk, so an endpoint chunk is identifiable in Qdrant
 * without re-reading its text.
 */
function payloadForChunk(chunk: TextChunk): Record<string, unknown> {
	const spec = (chunk as OpenApiChunk).specMetadata;
	if (!spec) {
		return {};
	}
	return {
		specTitle: spec.specTitle,
		specVersion: spec.specVersion,
		specChunkKind: spec.kind,
		httpMethod: spec.httpMethod ?? null,
		path: spec.path ?? null,
		operationId: spec.operationId ?? null,
		operationTags: spec.operationTags ?? null,
	};
}

/**
 * Whether content-type profiles apply: the project (or company) has per-type
 * rows or the earlier toggle, AND the
 * `CONTENT_AWARE_CHUNKING` flag. The project is checked first so one that
 * never changed chunking does not even read the flag — its chunking cannot
 * change.
 */
export async function isContentAwareChunkingActive(params: {
	chunkByContentType?: boolean;
	organizationId?: string | null;
	/** Per-type rows; any row (even Custom) means the project moved. */
	chunkProfiles?: ChunkProfilesConfig;
}): Promise<boolean> {
	if (
		params.chunkByContentType !== true &&
		Object.keys(params.chunkProfiles ?? {}).length === 0
	) {
		return false;
	}
	return isFeatureEnabled(
		"CONTENT_AWARE_CHUNKING",
		params.organizationId ?? undefined,
	);
}

/**
 * Choose the profile for content on the text route (§5): override, then the
 * caller's known kind, then detection, then the project fallback (`prose`).
 */
export function chooseChunkProfile(params: {
	content: string;
	mimeType: string;
	filename: string;
	kind?: ContentKind;
	profileOverride?: ChunkProfile | null;
}): { profile: ChunkProfile; reason: ChunkProfileReason } {
	const { content, mimeType, filename, kind, profileOverride } = params;
	if (profileOverride && profileOverride !== "openapi") {
		return { profile: profileOverride, reason: "override" };
	}
	if (kind) {
		const fromKind = profileForKind(kind, content.length);
		if (fromKind && fromKind !== "openapi") {
			return { profile: fromKind, reason: "kind" };
		}
	}
	const detected = detectProfile({ content, mimeType, filename });
	if (detected) {
		return { profile: detected, reason: "detected" };
	}
	return { profile: "prose", reason: "fallback" };
}

export async function chunkProjectContent(params: {
	content: string;
	mimeType: string;
	filename: string;
	/** Below this the content is embedded whole (default 2048). */
	chunkingThreshold?: number;
	chunkSize?: number;
	chunkOverlap?: number;
	/** Overrides the MIME-derived strategy on the text route (RAG settings). */
	textStrategy?: ChunkingStrategy;
	/**
	 * The project's "Chunk by content type" toggle. Off (the default, and the
	 * state of every existing project) means today's chunking, byte for byte.
	 */
	chunkByContentType?: boolean;
	/** Resolves the per-organization `CONTENT_AWARE_CHUNKING` override. */
	organizationId?: string | null;
	/** What the caller knows the content is (§5 step 2). */
	kind?: ContentKind;
	/** A source-level override (§6); wins over everything else. */
	profileOverride?: ChunkProfile | null;
	/** Per-type tuning from `ProjectRagSettings.chunkProfiles`. */
	chunkProfiles?: ChunkProfilesConfig;
}): Promise<ProjectContentChunkResult> {
	const {
		content,
		mimeType,
		filename,
		chunkingThreshold = CHUNKING_THRESHOLD,
		chunkSize = DEFAULT_CHUNK_SIZE,
		chunkOverlap = DEFAULT_CHUNK_OVERLAP,
		textStrategy,
		kind,
		profileOverride,
		chunkProfiles,
	} = params;

	const contentAware = await isContentAwareChunkingActive(params);

	const route = await routeContentForChunking({
		content,
		mimeType,
		filename,
	});

	if (route.kind === "openapi") {
		const chunks = chunkDescribedOpenApiSpec(route.description, filename);
		return {
			route,
			profile: "openapi",
			reason: "detected",
			chunks,
			contextTypeOverride: "API_SPEC",
			chunkPayloads: chunks.map((chunk) =>
				contentAware
					? {
							...payloadForChunk(chunk),
							profile: "openapi",
							profileReason: "detected",
						}
					: payloadForChunk(chunk),
			),
		};
	}

	// A malformed spec is NOT silently chunked as text — that is precisely the
	// silent detail loss this feature exists to prevent. The caller surfaces it.
	if (route.kind === "malformed-openapi") {
		return {
			route,
			profile: "openapi",
			reason: "detected",
			chunks: [],
			chunkPayloads: [],
		};
	}

	const proseParams = {
		content,
		filename,
		route,
		chunkingThreshold,
		chunkSize,
		chunkOverlap,
		textStrategy,
	};

	if (!contentAware) {
		// Unchanged pre-existing behaviour.
		const chunks = chunkProse(proseParams);
		return {
			route,
			profile: "prose",
			reason: "fallback",
			chunks,
			chunkPayloads: chunks.map(() => ({})),
		};
	}

	const choice = chooseChunkProfile({
		content,
		mimeType,
		filename,
		kind,
		profileOverride,
	});
	// Per-type tuning: by the known kind first, then by the chosen profile. A
	// tuned profile replaces the default one, but never a source's override.
	const tuning =
		(kind ? chunkProfiles?.[kind] : undefined) ??
		chunkProfiles?.[choice.profile];
	// A type on Custom chunks as before per-type rows existed, with its own
	// split method, size and overlap where it set them; a source's own
	// override still wins.
	if (
		choice.reason !== "override" &&
		isCustomChunking(tuning, params.chunkByContentType)
	) {
		const custom = customChunkSettings(tuning, {
			splitMethod: textStrategy,
			chunkSize,
			chunkOverlap,
		});
		const chunks = chunkProse({
			...proseParams,
			textStrategy: custom.splitMethod,
			chunkSize: custom.chunkSize,
			chunkOverlap: custom.chunkOverlap,
		});
		return {
			route,
			profile: "prose",
			reason: "fallback",
			chunks,
			chunkPayloads: chunks.map(() => ({})),
		};
	}
	const profile =
		tuning?.profile && choice.reason !== "override"
			? tuning.profile
			: choice.profile;

	if (profile === "prose" || profile === "openapi") {
		const chunks = chunkProse({ ...proseParams, boundaryAware: true });
		return {
			route,
			profile: "prose",
			reason: choice.reason,
			chunks,
			chunkPayloads: chunks.map(() => ({
				profile: "prose",
				profileReason: choice.reason,
			})),
		};
	}

	const profiled = chunkWithProfile(content, filename, profile, tuning);
	logger.info("[ContentRouting] Chunked by profile", {
		filename,
		profile,
		reason: choice.reason,
		chunks: profiled.length,
	});
	return {
		route,
		profile,
		reason: choice.reason,
		chunks: profiled.map((p) => p.chunk),
		chunkPayloads: profiled.map((p) => ({
			profile,
			profileReason: choice.reason,
			...p.payload,
		})),
	};
}

const BOUNDARY_AWARE_STRATEGIES: ReadonlySet<ChunkingStrategy> = new Set([
	"DOCUMENT",
	"PARAGRAPH",
	"RECURSIVE",
]);

/** Today's text-route chunking: whole below the threshold, else windows. */
function chunkProse(params: {
	content: string;
	filename: string;
	route: Extract<ContentRoute, { kind: "text" }>;
	chunkingThreshold: number;
	chunkSize: number;
	chunkOverlap: number;
	textStrategy?: ChunkingStrategy;
	/** Content-aware chunking: size-driven strategies cut at boundaries. */
	boundaryAware?: boolean;
}): TextChunk[] {
	const {
		content,
		filename,
		route,
		chunkingThreshold,
		chunkSize,
		chunkOverlap,
		textStrategy,
		boundaryAware,
	} = params;
	if (content.length <= chunkingThreshold) {
		return [
			{
				content,
				index: 0,
				metadata: {
					filename,
					startOffset: 0,
					endOffset: content.length,
				},
			},
		];
	}

	const strategy = textStrategy ?? route.strategy;
	// SEMANTIC, SENTENCE, FIXED and CODE_AST are explicit choices and keep
	// their own cuts; the size-driven ones cut mid-word at their overlap.
	if (boundaryAware && BOUNDARY_AWARE_STRATEGIES.has(strategy)) {
		return chunkProseByBoundaries(content, filename, {
			chunkSize,
			chunkOverlap,
		});
	}

	return chunkText(content, filename, {
		strategy,
		chunkSize,
		chunkOverlap,
	});
}
