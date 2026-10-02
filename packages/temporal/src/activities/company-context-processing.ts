/**
 * Company context file processing (Fizzy #2719).
 *
 * The project context processing activities (`./project-context-processing`)
 * serve an organization's company context sources too: each resolves the
 * owner on its input once and hands a company owner here. A company run reads
 * and writes `CompanyContextSource`, always scoped by the owner's
 * organization, chunks with the organization's RAG settings, embeds with the
 * organization's model into the company collection, and has none of the
 * project-only side effects — Job Hub rows and import-as-document.
 */

import { AIProviderNotConfiguredError } from "@repo/ai";
import {
	companyContextStoragePrefix,
	type ExtractionStatus,
} from "@repo/database";
import {
	COMPANY_EMBEDDING_RESOLUTION,
	type CompanyEmbeddingModel,
	chunkProjectContent,
	companyEmbeddingIdentity,
	deleteCompanyContextRowPoints,
	deleteCompanyContextSourcePoints,
	generateEmbeddings,
	getCompanyChunkSettings,
	resolveCompanyEmbeddingModel,
	storeCompanyContextPoints,
	type TextChunk,
	unsupportedEmbeddingModelMessage,
} from "@repo/rag";
import { heartbeat } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";
import type { CompanyContextOwner } from "../lib/context-owner";
import {
	type ContextSourceRow,
	companyContextRowStore,
} from "../lib/context-row-store";
import {
	CHUNKING_THRESHOLD,
	DEFAULT_CHUNK_OVERLAP,
	DEFAULT_CHUNK_SIZE,
	downloadAndExtractText,
} from "./lib/context-file-text";

/** What a company source records when no provider can embed it. */
const COMPANY_NO_PROVIDER_MESSAGE =
	"AI provider not configured. Configure an embedding provider in Settings → AI to enable retrieval for this context.";

/** What a company run reports, in the shape of the project activity's result. */
interface CompanySourceProcessingResult {
	success: boolean;
	chunkCount: number;
	extractorUsed?: string;
	qdrantIds: string[];
	error?: string;
	embedded?: boolean;
	embeddingError?: string;
}

/**
 * Record a company source's status. A company source has no Job Hub row; its
 * status lives on its own table, and a source deleted while it was being
 * processed has nothing left to mark.
 */
export async function setCompanySourceStatus(
	owner: CompanyContextOwner,
	contextId: string,
	status: ExtractionStatus,
	error?: string,
): Promise<void> {
	const matched = await companyContextRowStore(owner).setStatus(
		contextId,
		status,
		error ? { extractionError: error } : undefined,
	);
	if (!matched) {
		console.warn(
			`[ProjectContextProcessing] Company context source ${contextId} no longer exists; status ${status} not recorded`,
		);
	}
}

/**
 * `processProjectContext` for a company owner: a company source's uploaded
 * file.
 *
 * The same download and extraction as a project file, then:
 *  - the file must sit under the organization's own storage prefix;
 *  - the extracted text is stored on the source, and from then on a failure
 *    keeps that extraction and records only that indexing failed, as a
 *    project file does (bug #1039);
 *  - the organization's embedding model is resolved the way every company
 *    embed resolves it, from the organization's own configuration. With none,
 *    the source records why it is not searchable; one whose vectors the
 *    collection cannot hold fails the source before anything reaches Qdrant;
 *  - it chunks with the organization's RAG settings, each unset one falling
 *    back to the project pipeline's defaults, and keeps its own type:
 *    company context accepts only FILE, TEXT and LINK, so a spec is chunked
 *    by endpoint but the row is never re-typed;
 *  - `storeCompanySourceChunks` writes the points, stamped with the model the
 *    embedding call reports having used.
 *
 * No Job Hub row, and never imported as a document, whatever its metadata
 * says.
 */
export async function processCompanySource(
	contextId: string,
	userId: string,
	extractionStrategy: string,
	owner: CompanyContextOwner,
): Promise<CompanySourceProcessingResult> {
	const { organizationId } = owner;
	const rows = companyContextRowStore(owner);
	console.log(
		`[ProjectContextProcessing] Processing company context: ${contextId}`,
	);
	console.log(`[ProjectContextProcessing] organizationId: ${organizationId}`);

	const safeHeartbeat = (phase: string) => {
		try {
			heartbeat({ phase, contextId });
		} catch {
			// Not in activity context (e.g., testing) - ignore
		}
	};

	let extractionPersisted = false;
	let extractorUsed: string | undefined;
	// This run removed the source's earlier points, so a failure from then on
	// leaves it unindexed.
	let pointsRemoved = false;

	try {
		safeHeartbeat("starting");

		// Scoped by the organization alone: the API authorized the caller for
		// the source before starting the workflow.
		const context = await rows.loadSource(contextId);
		if (!context) {
			// Deleted before its processing ran: there is nothing to do, and
			// no retry will bring it back.
			throw ApplicationFailure.nonRetryable(
				`Company context source not found: ${contextId}`,
				"COMPANY_CONTEXT_SOURCE_NOT_FOUND",
			);
		}
		if (!context.s3Path) {
			throw new Error(`No S3 path for context: ${contextId}`);
		}
		if (
			!context.s3Path.startsWith(
				companyContextStoragePrefix(organizationId),
			)
		) {
			// Company files live under the organization's own prefix; a key
			// anywhere else is not this organization's to read.
			throw ApplicationFailure.nonRetryable(
				`Company context file is outside its organization's storage: ${contextId}`,
				"COMPANY_CONTEXT_STORAGE_MISMATCH",
			);
		}

		await setCompanySourceStatus(owner, contextId, "EXTRACTING");

		const extraction = await downloadAndExtractText(
			{ ...context, s3Path: context.s3Path },
			{
				contextId,
				extractionStrategy,
				userId,
				organizationId,
				safeHeartbeat,
			},
		);
		const { extractedText } = extraction;
		extractorUsed = extraction.extractorUsed;

		// No text fails the source before anything is stored, as for a
		// project file (#1684).
		if (!extractedText.trim()) {
			const emptyExtractionMessage =
				"No readable text could be extracted from this file.";
			console.warn(
				`[ProjectContextProcessing] Extraction yielded no text; skipping chunking (contextId: ${contextId}, mimeType: ${context.mimeType ?? "unknown"})`,
			);
			await setCompanySourceStatus(
				owner,
				contextId,
				"FAILED",
				emptyExtractionMessage,
			);
			return {
				success: false,
				chunkCount: 0,
				extractorUsed,
				qdrantIds: [],
				error: emptyExtractionMessage,
			};
		}

		// Clears the message an earlier failed run left, which the source's
		// page reads.
		await rows.setStatus(contextId, "COMPLETED", {
			content: extractedText,
			extractionError: null,
		});
		extractionPersisted = true;

		// Resolved from the organization's own configuration, as the embedding
		// call below resolves it: an organization whose only provider is a
		// dedicated embedding one can index, and an acting member's personal
		// key never decides whether it can.
		let model: CompanyEmbeddingModel;
		try {
			model = await resolveCompanyEmbeddingModel({
				organizationId,
				userId,
			});
		} catch (error) {
			if (!(error instanceof AIProviderNotConfiguredError)) {
				throw error;
			}
			console.log(
				"[ProjectContextProcessing] No embedding provider configured, skipping company context embedding",
			);
			// A company source is useful only once it is searchable, so it
			// says why it is not rather than sitting silent.
			await rows
				.recordIndexingFailure(contextId, COMPANY_NO_PROVIDER_MESSAGE)
				.catch((writeError) =>
					console.warn(
						`[ProjectContextProcessing] Failed to record the missing provider on ${contextId}: ${writeError}`,
					),
				);
			return {
				success: true,
				chunkCount: 0,
				extractorUsed,
				qdrantIds: [],
			};
		}
		if (!model.supported) {
			const reason = unsupportedEmbeddingModelMessage(model);
			console.warn(`[ProjectContextProcessing] ${reason}`);
			await setCompanySourceStatus(owner, contextId, "FAILED", reason);
			return {
				success: false,
				chunkCount: 0,
				extractorUsed,
				qdrantIds: [],
				error: reason,
			};
		}

		safeHeartbeat("chunking");
		console.log("[ProjectContextProcessing] Chunking company context");
		const chunking = await getCompanyChunkSettings(organizationId, {
			chunkSize: DEFAULT_CHUNK_SIZE,
			chunkOverlap: DEFAULT_CHUNK_OVERLAP,
			splitMethod: null,
		});
		const chunkResult = await chunkProjectContent({
			content: extractedText,
			mimeType: context.mimeType || "",
			filename: context.originalFilename || contextId,
			chunkingThreshold: CHUNKING_THRESHOLD,
			chunkSize: chunking.chunkSize,
			chunkOverlap: chunking.chunkOverlap,
			...(chunking.strategy ? { textStrategy: chunking.strategy } : {}),
		});
		if (chunkResult.route.kind === "malformed-openapi") {
			const reason = `This file looks like an OpenAPI/Swagger document but could not be read: ${chunkResult.route.reason}`;
			console.warn(`[ProjectContextProcessing] ${reason}`);
			await setCompanySourceStatus(owner, contextId, "FAILED", reason);
			return {
				success: false,
				chunkCount: 0,
				extractorUsed,
				qdrantIds: [],
				error: reason,
			};
		}
		const { chunks } = chunkResult;
		console.log(
			`[ProjectContextProcessing] Created ${chunks.length} chunks (route=${chunkResult.route.kind})`,
		);
		if (chunks.length === 0) {
			console.log("[ProjectContextProcessing] No chunks created");
			return {
				success: true,
				chunkCount: 0,
				extractorUsed,
				qdrantIds: [],
			};
		}

		safeHeartbeat("embedding");
		console.log("[ProjectContextProcessing] Generating embeddings");
		const embeddingResult = await generateEmbeddings(
			chunks.map((chunk) => chunk.content),
			{
				userId,
				organizationId,
				tags: ["company-context", "rag-embedding"],
				// The organization's model, resolved as `model` was.
				...COMPANY_EMBEDDING_RESOLUTION,
			},
		);

		return await storeCompanySourceChunks({
			owner,
			context,
			chunks,
			embeddings: embeddingResult.embeddings,
			// The model that produced these vectors: `model`, unless the
			// organization switched models since it was resolved.
			embeddingModel: companyEmbeddingIdentity(embeddingResult),
			extractorUsed,
			onPointsRemoved: () => {
				pointsRemoved = true;
			},
			safeHeartbeat,
		});
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : "Unknown error";

		if (extractionPersisted) {
			console.warn(
				`[ProjectContextProcessing] Post-extraction step failed (status remains COMPLETED): ${errorMessage}`,
			);
			// Not searchable: record why on the source, keeping its COMPLETED
			// extraction. A pass that removed its earlier points also clears
			// its index markers.
			await rows
				.recordIndexingFailure(
					contextId,
					`Search indexing failed: ${errorMessage}`,
					pointsRemoved ? { pointsRemoved: true } : undefined,
				)
				.catch((writeError) =>
					console.warn(
						`[ProjectContextProcessing] Failed to record the indexing failure on ${contextId}: ${writeError}`,
					),
				);
			return {
				success: true,
				chunkCount: 0,
				extractorUsed,
				qdrantIds: [],
				embedded: false,
				embeddingError: errorMessage,
			};
		}

		console.error(
			`[ProjectContextProcessing] Failed to process company context: ${errorMessage}`,
		);
		// Best-effort, as for a project context; the error is rethrown for
		// Temporal's retry policy.
		try {
			await setCompanySourceStatus(
				owner,
				contextId,
				"FAILED",
				errorMessage,
			);
		} catch {
			// Ignore errors when updating status
		}
		throw error;
	}
}

/**
 * Company: write a source's chunks to its organization's company collection
 * and mark it embedded with the model they were written with.
 *
 * The source's earlier points go first — a re-run may produce fewer chunks
 * than the last, and deterministic point ids alone would leave the old tail
 * searchable — and every chunk must land, since readiness reads the mark and
 * a source is marked only whole. A source deleted while this ran matches no
 * row on the mark; the points just written then belong to nothing and are
 * removed.
 */
async function storeCompanySourceChunks(params: {
	owner: CompanyContextOwner;
	context: ContextSourceRow;
	chunks: TextChunk[];
	embeddings: number[][];
	/** Identity of the model that produced `embeddings`. */
	embeddingModel: string;
	extractorUsed: string | undefined;
	/**
	 * Called once the earlier points are deleted. Not before: a delete that
	 * failed leaves the source's index markers as they were, and the retry
	 * deletes again.
	 */
	onPointsRemoved: () => void;
	safeHeartbeat: (phase: string) => void;
}): Promise<CompanySourceProcessingResult> {
	const { owner, context, chunks, embeddings, embeddingModel } = params;
	const { organizationId } = owner;
	const contextId = context.id;

	if (embeddings.length !== chunks.length) {
		throw new Error(
			`Expected ${chunks.length} embeddings for context ${contextId}, got ${embeddings.length}`,
		);
	}

	params.safeHeartbeat("storing");
	console.log("[ProjectContextProcessing] Storing company context in Qdrant");
	await deleteCompanyContextRowPoints({
		organizationId,
		contextIds: [contextId],
	});
	params.onPointsRemoved();
	const qdrantIds = await storeCompanyContextPoints(
		chunks.map((chunk, index) => ({
			organizationId,
			sourceId: contextId,
			contextId,
			contextType: context.type,
			embeddingModel,
			content: chunk.content,
			chunkIndex: index,
			embedding: embeddings[index],
			sourceTitle: context.sourceTitle ?? context.originalFilename,
			sourceUrl: context.sourceUrl,
		})),
	);

	const marked = await companyContextRowStore(owner).markEmbedded(contextId, {
		qdrantId: qdrantIds[0] ?? null,
		embeddingModel,
	});
	if (!marked) {
		console.warn(
			`[ProjectContextProcessing] Company context source ${contextId} was deleted while it was embedded; removing its points`,
		);
		await deleteCompanyContextSourcePoints({
			organizationId,
			sourceId: contextId,
		});
		return {
			success: true,
			chunkCount: 0,
			extractorUsed: params.extractorUsed,
			qdrantIds: [],
			embedded: false,
		};
	}

	console.log(
		`[ProjectContextProcessing] Successfully processed company context: ${chunks.length} chunks, ${qdrantIds.length} Qdrant points`,
	);
	return {
		success: true,
		chunkCount: chunks.length,
		extractorUsed: params.extractorUsed,
		qdrantIds,
		embedded: true,
	};
}

/**
 * Company: forget a source's index and its extracted text, remove its points,
 * and process it again from its file. The index markers go first, so from the
 * first write on the source reads as not ready rather than claiming vectors
 * this retry is about to remove. Any failure throws for Temporal to retry;
 * each step is safe to repeat.
 */
export async function retryCompanySource(
	contextId: string,
	userId: string,
	extractionStrategy: string,
	owner: CompanyContextOwner,
): Promise<CompanySourceProcessingResult> {
	const rows = companyContextRowStore(owner);
	await rows.clearEmbedding(contextId);
	await deleteCompanyContextRowPoints({
		organizationId: owner.organizationId,
		contextIds: [contextId],
	});
	await rows.setStatus(contextId, "PENDING", {
		content: "",
		extractionError: null,
	});
	return processCompanySource(contextId, userId, extractionStrategy, owner);
}
