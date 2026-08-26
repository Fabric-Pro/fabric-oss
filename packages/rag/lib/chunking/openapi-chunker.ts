/**
 * Structure-aware chunking for OpenAPI/Swagger documents.
 *
 * A spec chunked by character window is worse than useless: 2048-character
 * slices cut mid-operation and mid-schema, so a retrieved chunk is a fragment of
 * JSON with no endpoint, no method and half a model. That is what every
 * `.json`/`.yaml` upload got before this module existed.
 *
 * Here the unit of retrieval is the unit of meaning:
 *
 * - one **summary** chunk — the API's identity, auth, and every endpoint listed,
 *   so "what can this API do" has something to match;
 * - one chunk per **operation** — self-contained, with all inputs, all response
 *   codes and the names of the models involved;
 * - one chunk per named **model**.
 *
 * The consequence worth stating: total file size stops mattering. A question
 * retrieves the handful of operations it matches, so a 50 MB spec costs the same
 * prompt space as a small one. This is why specs belong in project context
 * rather than in a chat attachment, which must fit one request body.
 *
 * Modelled on `code-chunker.ts`, which does the same job for source files.
 */

import { logger } from "@repo/logs";
import {
	describeOpenApiSpec,
	type OpenApiDescription,
	renderModel,
	renderOperation,
	renderSpecSummary,
} from "@repo/openapi-tools";
import type { TextChunk } from "./types";

/**
 * Ceiling for one chunk, in characters.
 *
 * Larger than the generic 2048 because an operation is a unit — splitting one
 * across chunks is the failure this module exists to prevent — and because the
 * embedding layer's real limit is 8191 tokens (~32k chars), far above this.
 */
const DEFAULT_MAX_CHUNK_CHARS = 6000;

/** What kind of thing a chunk describes. */
export type OpenApiChunkKind = "summary" | "operation" | "model";

export interface OpenApiChunk extends TextChunk {
	specMetadata: {
		kind: OpenApiChunkKind;
		specTitle: string;
		specVersion: string;
		/** Set on operation chunks. */
		httpMethod?: string;
		path?: string;
		operationId?: string;
		operationTags?: string[];
		/** Set on model chunks. */
		modelName?: string;
		/** Set when one rendering had to be split across several chunks. */
		partIndex?: number;
		partCount?: number;
	};
}

export interface OpenApiChunkOptions {
	/** Maximum characters per chunk (default 6000). */
	maxChunkChars?: number;
}

/**
 * Break a single line that is itself longer than the budget.
 *
 * Line boundaries alone are not enough: a spec description is very often one
 * unbroken line of several thousand characters, and splitting only between lines
 * left it whole in an oversized chunk — 40k characters against a 6k ceiling in
 * the case that found this, which then hits the embedding layer's own per-input
 * ceiling and gets diluted across a recombined vector. Split inside the line
 * instead. Still no truncation: every character lands in some piece.
 */
function splitLongLine(line: string, maxChars: number): string[] {
	if (line.length <= maxChars) {
		return [line];
	}
	const pieces: string[] = [];
	for (let offset = 0; offset < line.length; offset += maxChars) {
		pieces.push(line.slice(offset, offset + maxChars));
	}
	return pieces;
}

/**
 * Split one over-long rendering into chunks that respect the ceiling.
 *
 * Never truncates — the embedding layer takes the same position for the same
 * reason (`generator.ts`: "truncation silently discards text the caller believed
 * was embedded"). Each part repeats the heading lines, which carry the API
 * identity and the operation, so part 3 of an operation is still attributable on
 * its own.
 */
function splitRendering(text: string, maxChars: number): string[] {
	if (text.length <= maxChars) {
		return [text];
	}

	const rawLines = text.split("\n");

	// The repeated header must be BOUNDED, because it is built from `info.title`
	// and a path — both user-supplied and neither length-checked. Unbounded, a
	// 20k-character title made every continuation part exceed the ceiling and
	// turned a 29 KB rendering into 1.9 MB across 94 parts: the header was
	// re-emitted in full on each one. Capping it is not data loss — the complete
	// title is in the first part and in the summary chunk; this copy exists only
	// so a later part is attributable.
	const headerBudget = Math.max(80, Math.floor(maxChars / 4));
	const fullHeader = rawLines.slice(0, 3).join("\n");
	const header =
		fullHeader.length > headerBudget
			? `${fullHeader.slice(0, headerBudget)}…`
			: fullHeader;
	const continuation = `${header}\n(continued)`;

	// Room a continuation part has for content, after its repeated header. The
	// header cap above keeps this comfortably positive; the floor is belt-and-
	// braces against a future change to that cap.
	const bodyBudget = Math.max(256, maxChars - continuation.length - 1);

	const lines = rawLines.flatMap((line) => splitLongLine(line, bodyBudget));

	const parts: string[] = [];
	let current: string[] = [];
	let currentLength = 0;

	for (const line of lines) {
		// +1 for the newline we will rejoin with.
		if (currentLength + line.length + 1 > maxChars && current.length > 0) {
			parts.push(current.join("\n"));
			current = [continuation];
			currentLength = continuation.length + 1;
		}
		current.push(line);
		currentLength += line.length + 1;
	}

	if (current.length > 0) {
		parts.push(current.join("\n"));
	}

	return parts;
}

function pushChunks(
	target: OpenApiChunk[],
	text: string,
	maxChars: number,
	metadata: Omit<OpenApiChunk["specMetadata"], "partIndex" | "partCount">,
	filename: string,
): void {
	const parts = splitRendering(text, maxChars);
	for (const [partIndex, part] of parts.entries()) {
		target.push({
			content: part,
			index: target.length,
			tokenEstimate: Math.ceil(part.length / 4),
			metadata: {
				filename,
				startOffset: 0,
				endOffset: part.length,
				strategy: "DOCUMENT",
				section:
					metadata.kind === "operation"
						? `${metadata.httpMethod} ${metadata.path}`
						: metadata.kind === "model"
							? `Model: ${metadata.modelName}`
							: "API overview",
			},
			specMetadata:
				parts.length > 1
					? { ...metadata, partIndex, partCount: parts.length }
					: metadata,
		});
	}
}

/**
 * Chunk an already-described spec. Exposed separately so a caller that has
 * described the document once (to detect it, or to read its title) does not pay
 * for a second parse.
 */
export function chunkDescribedOpenApiSpec(
	spec: OpenApiDescription,
	filename: string,
	options: OpenApiChunkOptions = {},
): OpenApiChunk[] {
	const maxChunkChars = options.maxChunkChars ?? DEFAULT_MAX_CHUNK_CHARS;
	const chunks: OpenApiChunk[] = [];

	const common = {
		specTitle: spec.title,
		specVersion: spec.version,
	};

	pushChunks(
		chunks,
		renderSpecSummary(spec),
		maxChunkChars,
		{ kind: "summary", ...common },
		filename,
	);

	for (const operation of spec.operations) {
		pushChunks(
			chunks,
			renderOperation(spec, operation),
			maxChunkChars,
			{
				kind: "operation",
				...common,
				httpMethod: operation.method,
				path: operation.path,
				operationId: operation.operationId,
				operationTags: operation.tags,
			},
			filename,
		);
	}

	for (const model of spec.models) {
		pushChunks(
			chunks,
			renderModel(spec, model),
			maxChunkChars,
			{ kind: "model", ...common, modelName: model.name },
			filename,
		);
	}

	logger.info(
		`[OpenApiChunker] ${spec.title} v${spec.version}: ${chunks.length} chunks ` +
			`(${spec.operations.length} operations, ${spec.models.length} models)`,
	);

	return chunks;
}

/**
 * Describe and chunk a spec document supplied as JSON or YAML text.
 *
 * Throws if the content is not a spec this can read; callers should have run
 * `looksLikeOpenApiSpec` first and routed accordingly.
 */
export function chunkOpenApiSpec(
	content: string,
	filename: string,
	options: OpenApiChunkOptions = {},
): OpenApiChunk[] {
	return chunkDescribedOpenApiSpec(
		describeOpenApiSpec(content),
		filename,
		options,
	);
}
