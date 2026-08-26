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
}): Promise<ProjectContentChunkResult> {
	const {
		content,
		mimeType,
		filename,
		chunkingThreshold = CHUNKING_THRESHOLD,
		chunkSize = DEFAULT_CHUNK_SIZE,
		chunkOverlap = DEFAULT_CHUNK_OVERLAP,
		textStrategy,
	} = params;

	const route = await routeContentForChunking({
		content,
		mimeType,
		filename,
	});

	if (route.kind === "openapi") {
		const chunks = chunkDescribedOpenApiSpec(route.description, filename);
		return {
			route,
			chunks,
			contextTypeOverride: "API_SPEC",
			chunkPayloads: chunks.map(payloadForChunk),
		};
	}

	// A malformed spec is NOT silently chunked as text — that is precisely the
	// silent detail loss this feature exists to prevent. The caller surfaces it.
	if (route.kind === "malformed-openapi") {
		return { route, chunks: [], chunkPayloads: [] };
	}

	// Unchanged pre-existing behaviour for everything else.
	if (content.length <= chunkingThreshold) {
		return {
			route,
			chunks: [
				{
					content,
					index: 0,
					metadata: {
						filename,
						startOffset: 0,
						endOffset: content.length,
					},
				},
			],
			chunkPayloads: [{}],
		};
	}

	const chunks = chunkText(content, filename, {
		strategy: textStrategy ?? route.strategy,
		chunkSize,
		chunkOverlap,
	});
	return { route, chunks, chunkPayloads: chunks.map(() => ({})) };
}
