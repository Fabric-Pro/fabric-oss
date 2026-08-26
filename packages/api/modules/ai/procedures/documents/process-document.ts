import { ORPCError } from "@orpc/server";
import { config } from "@repo/config";
import {
	getAiChatByIdForOwner,
	getChatDocumentByIdForOwner,
	updateDocumentStatus,
} from "@repo/database";
import { logger } from "@repo/logs";
import { extractionFactory } from "@repo/rag";
import { downloadFile } from "@repo/storage";
import {
	type DocumentProcessingInput,
	getTemporalClient,
} from "@repo/temporal";
import {
	AI_CHAT_WORKBOOK_SIGNATURE_BYTES,
	type AiChatExtractedSheet,
	type AiChatExtractionOutcome,
	type AiChatTruncationReason,
	applyAiChatTextBudget,
	classifyAiChatWorkbook,
	isAiChatTruncationReason,
} from "@repo/utils/ai-chat-attachment";
import { z } from "zod";
import { withCorrelationMemo } from "../../../../lib/temporal-correlation";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../../organizations/lib/membership";
import {
	describeAiChatExtractionFailure,
	describeAiChatWorkbookRejection,
	resolveAiChatAttachmentLimits,
} from "../../lib/ai-chat-attachment-limits";

const TASK_QUEUE = "document-processing";

/**
 * What the inline path produced: the text for the prompt envelope, and the
 * outcome the chip renders.
 *
 * Two fields rather than a text-bearing outcome, because they have different
 * audiences and different lifetimes. `text` goes into the model's rag-context
 * envelope; `outcome` goes to the person who attached the file and must survive
 * the cases where there is no text at all — which is precisely where the old
 * `string | null` return went silent.
 */
interface InlineExtraction {
	/** Text for the envelope. `null` whenever the outcome carries no content. */
	text: string | null;
	outcome: AiChatExtractionOutcome;
}

/**
 * Read the sheet report U5 leaves in `ExtractionResult.metadata` (R10).
 *
 * Defensive because `metadata` is `Record<string, unknown>` and only
 * `LocalXlsxExtractor` populates it — a PDF or DOCX extraction has no sheets and
 * lands here as `undefined`, which is an empty list, not a fault.
 */
function readSheetReport(
	metadata: Record<string, unknown> | undefined,
): AiChatExtractedSheet[] {
	const raw = metadata?.sheets;
	if (!Array.isArray(raw)) {
		return [];
	}
	return raw.flatMap((entry): AiChatExtractedSheet[] => {
		if (typeof entry !== "object" || entry === null) {
			return [];
		}
		const { name, hidden } = entry as { name?: unknown; hidden?: unknown };
		if (typeof name !== "string") {
			return [];
		}
		return [{ name, hidden: hidden === true }];
	});
}

interface TruncationReport {
	reason?: AiChatTruncationReason;
	omittedRowCount: number;
	truncatedSheetNames: string[];
}

/**
 * Read U5's truncation report, or `null` when the walk completed.
 *
 * The extractor already names the omission in the text itself (R7) so the model
 * does not mistake a cut workbook for a complete one. This is the other half:
 * the same facts, routed to the user (R8).
 */
function readTruncationReport(
	metadata: Record<string, unknown> | undefined,
): TruncationReport | null {
	if (metadata?.truncated !== true) {
		return null;
	}
	const omittedRowCount = metadata.omittedRowCount;
	const truncatedSheetNames = metadata.truncatedSheetNames;
	return {
		reason: isAiChatTruncationReason(metadata.truncationReason)
			? metadata.truncationReason
			: undefined,
		omittedRowCount:
			typeof omittedRowCount === "number" &&
			Number.isFinite(omittedRowCount)
				? omittedRowCount
				: 0,
		truncatedSheetNames: Array.isArray(truncatedSheetNames)
			? truncatedSheetNames.filter(
					(name): name is string => typeof name === "string",
				)
			: [],
	};
}

/**
 * Synchronous best-effort text extraction for inline use by the
 * `useCopilotDocumentUpload` hook (PDF/DOCX paperclip attachments).
 *
 * The Temporal `documentProcessingWorkflow` still runs in parallel for
 * chunking/embedding/RAG storage, but the chat surface needs the file
 * body inside the `[Uploaded Document: filename]\n<text>` rag-context
 * envelope BEFORE the user hits Send — the agent reads that envelope
 * directly into the system prompt and otherwise sees only the filename.
 *
 * Every failure stays non-blocking: callers fall back to the existing
 * async workflow path, and a slow / unconfigured pipeline must never block
 * the upload from completing. What changed is what the caller *learns* —
 * failures now return a `failed` outcome carrying a reason instead of a
 * bare `null` that the chip rendered as a clean green check.
 *
 * The workbook-signature rejection is the one exception and still throws: a
 * refused container is a verdict about the file, not a symptom of a flaky
 * pipeline, so it must not degrade into "extraction returned nothing" and
 * let the workflow chunk the bytes anyway. The reason travels on the
 * `ORPCError` message, and the hook maps it onto the chip's outcome there.
 */
async function extractInlineBestEffort(
	s3Path: string,
	filename: string,
	mimeType: string,
	userId: string,
	organizationId: string | null,
	strategy:
		| "local-only"
		| "prefer-external"
		| "external-only"
		| "cost-optimized"
		| "quality-optimized",
): Promise<InlineExtraction> {
	try {
		const downloaded = await downloadFile(s3Path, {
			bucket: config.storage.bucketNames.chatDocuments,
		});

		// Container-signature check on the bytes that actually landed in
		// storage — this is the presigned path, so nothing before now has seen
		// them (`create-upload-url` runs pre-upload and holds only filename,
		// MIME, and size). The hook's identical check at file selection is an
		// advisory affordance; this is the control. Non-workbook filenames
		// classify as accepted and reach the extractor untouched.
		const classification = classifyAiChatWorkbook(
			downloaded.data.subarray(0, AI_CHAT_WORKBOOK_SIGNATURE_BYTES),
			filename,
		);
		if (classification !== "accepted") {
			throw new ORPCError("BAD_REQUEST", {
				message: describeAiChatWorkbookRejection(
					classification,
					filename,
				),
			});
		}

		// The character budget is supplied HERE and nowhere else. This is the
		// inline chat path — the one caller whose extracted text goes straight
		// into a prompt — so it is the one caller that owes the model a bound.
		// The same extractor serves four Temporal ingestion activities, which
		// pass no options and stay unbounded: a budget applied there would cut
		// knowledge-base documents mid-ingest and embed the truncation marker as
		// though it were content (KTD5). The resource bounds travel too, but
		// only to carry the operator's env overrides — the extractor already
		// defaults them for every caller.
		const limits = resolveAiChatAttachmentLimits();
		const result = await extractionFactory.extract(
			downloaded.data,
			filename,
			mimeType,
			{
				strategy,
				userId,
				organizationId: organizationId ?? undefined,
				extractionOptions: {
					extractedTextBudgetChars: limits.extractedTextBudgetChars,
					maxInflatedBytes: limits.maxInflatedBytes,
					maxSheets: limits.maxSheets,
					maxRows: limits.maxRows,
					maxCells: limits.maxCells,
					extractionDeadlineMs: limits.extractionDeadlineMs,
				},
			},
		);
		const text = result.text?.trim() ?? "";
		const sheets = readSheetReport(result.metadata);

		// A file that parsed cleanly and yielded nothing is not a failure, and
		// saying so is the point: a chart-only workbook and a broken pipeline
		// used to be the same `null` (R9, AE5).
		if (!text) {
			logger.info("[ProcessDocument] Inline extraction yielded no text", {
				filename,
				extractor: result.extractorUsed,
				sheetCount: sheets.length,
			});
			return { text: null, outcome: { status: "empty", sheets } };
		}

		const truncation = readTruncationReport(result.metadata);
		if (truncation) {
			logger.info("[ProcessDocument] Inline extraction truncated", {
				filename,
				extractor: result.extractorUsed,
				length: text.length,
				reason: truncation.reason,
				omittedRowCount: truncation.omittedRowCount,
			});
			return {
				text,
				outcome: { status: "truncated", sheets, ...truncation },
			};
		}

		// Backstop the budget for every other format.
		//
		// The option above reaches the extractor, but only the workbook walk
		// honours it — it is the one that can stop mid-file and report where.
		// The PDF, DOCX, and plain-text extractors return whatever they parsed,
		// so a large PDF arrived here whole and went straight into a prompt.
		// That is the same unbounded-inline gap the browser-read path had, on a
		// path the browser never touches.
		//
		// Applied here rather than inside the extractors on purpose: this
		// procedure *is* the chat path, and the four Temporal ingestion
		// activities that share those extractors must keep receiving whole
		// documents (KTD5).
		const budgeted = applyAiChatTextBudget(
			text,
			limits.extractedTextBudgetChars,
		);
		if (budgeted.outcome.status === "truncated") {
			logger.info("[ProcessDocument] Inline extraction budget applied", {
				filename,
				extractor: result.extractorUsed,
				length: budgeted.text.length,
				originalLength: text.length,
			});
			return {
				text: budgeted.text,
				outcome: { ...budgeted.outcome, sheets },
			};
		}

		logger.info("[ProcessDocument] Inline extraction succeeded", {
			filename,
			extractor: result.extractorUsed,
			length: text.length,
		});
		return { text, outcome: { status: "extracted", sheets } };
	} catch (error) {
		// A classifier rejection is a verdict, not a pipeline failure — it must
		// reach the caller instead of being swallowed into a filename-only
		// fallback that still starts the chunking workflow.
		if (error instanceof ORPCError) {
			throw error;
		}
		// Everything else — a download error, a refused inflation ceiling, a
		// crashed extractor — stays non-blocking. The workflow still starts and
		// the upload still completes; the difference is that the reason now
		// travels with the response instead of dying here.
		logger.warn(
			"[ProcessDocument] Inline extraction failed (will fall back to workflow)",
			{
				filename,
				error: error instanceof Error ? error.message : String(error),
			},
		);
		return {
			text: null,
			outcome: {
				status: "failed",
				reason: describeAiChatExtractionFailure(filename, error),
			},
		};
	}
}

export const processDocument = tenantProtectedProcedure
	.use(requirePermission(Permissions.AI_CHAT))
	.route({
		method: "POST",
		path: "/ai/documents/{documentId}/process",
		tags: ["AI"],
		summary: "Process document",
		description:
			"Trigger document processing workflow (extraction, chunking, embedding)",
	})
	.input(
		z.object({
			documentId: z.string(),
			extractionStrategy: z
				.enum([
					"local-only",
					"prefer-external",
					"external-only",
					"cost-optimized",
					"quality-optimized",
				])
				.optional()
				.default("local-only"),
		}),
	)
	.handler(async ({ input, context }) => {
		const { documentId, extractionStrategy } = input;
		const user = context.user;

		console.log("[ProcessDocument] Starting document processing");
		console.log("[ProcessDocument] Document ID:", documentId);
		console.log(
			"[ProcessDocument] Extraction strategy:",
			extractionStrategy,
		);
		console.log("[ProcessDocument] User ID:", user.id);

		// Per-user ownership enforced upfront — peers in the same org
		// cannot enumerate another member's documents by id.
		const document = await getChatDocumentByIdForOwner(documentId, user.id);

		if (!document) {
			throw new ORPCError("NOT_FOUND", { message: "Document not found" });
		}

		console.log("[ProcessDocument] Document found in database");
		console.log("[ProcessDocument] Document.chatId:", document.chatId);
		console.log("[ProcessDocument] Document.userId:", document.userId);
		console.log(
			"[ProcessDocument] Document.organizationId:",
			document.organizationId,
		);

		// Per-user ownership — helper rejects the document's chat if the
		// caller does not own it, even when it belongs to the same org.
		const chat = await getAiChatByIdForOwner(document.chatId, user.id);
		console.log(
			"[ProcessDocument] Chat found:",
			chat ? `ID=${chat.id}` : "NOT FOUND",
		);

		if (!chat) {
			throw new ORPCError("NOT_FOUND", { message: "Chat not found" });
		}

		if (chat.organizationId) {
			const membership = await verifyOrganizationMembership(
				chat.organizationId,
				user.id,
			);

			if (!membership) {
				throw new ORPCError("FORBIDDEN", {
					message: "Not a member of this organization",
				});
			}
		}

		// Check if document is already being processed
		if (document.status === "PROCESSING" || document.status === "READY") {
			return {
				documentId,
				status: document.status,
				workflowId: document.workflowId,
				workflowRunId: document.workflowRunId,
				message:
					document.status === "PROCESSING"
						? "Document is already being processed"
						: "Document has already been processed",
				extractedContent: null,
				// This return skips extraction entirely, so the `null` above
				// means "not attempted on this request", not "nothing readable".
				// Saying so explicitly is what keeps the chip from treating an
				// already-processed document as a file it failed to read.
				extraction: { status: "skipped" } as const,
			};
		}

		// Run inline best-effort text extraction so the chat surface can
		// stamp `[Uploaded Document: filename]\n<text>` into the rag-context
		// envelope on the very first turn — the chunking/embedding workflow
		// can take many seconds (and stalls entirely when the Temporal
		// worker or external embedding provider is misconfigured), but the
		// agent only needs the raw extracted text to read the file content.
		// Errors here do not block the upload; the workflow run below still owns
		// the authoritative READY status transition for retrieval. They are no
		// longer silent, though — `outcome` carries the reason to the chip.
		const { text: extractedContent, outcome: extraction } =
			await extractInlineBestEffort(
				document.s3Path,
				document.filename,
				document.mimeType,
				document.userId,
				document.organizationId,
				extractionStrategy,
			);

		try {
			// Get Temporal client
			const client = await getTemporalClient();

			// Start document processing workflow
			const workflowId = `document-processing-${documentId}`;
			const workflowInput: DocumentProcessingInput = {
				documentId,
				chatId: document.chatId,
				userId: document.userId,
				organizationId: document.organizationId || undefined,
				extractionStrategy,
			};

			console.log("[ProcessDocument] Starting Temporal workflow");
			console.log("[ProcessDocument] Workflow ID:", workflowId);
			console.log(
				"[ProcessDocument] Workflow input:",
				JSON.stringify(workflowInput, null, 2),
			);

			const handle = await client.workflow.start(
				"documentProcessingWorkflow",
				withCorrelationMemo({
					taskQueue: TASK_QUEUE,
					workflowId,
					args: [workflowInput],
				}),
			);

			console.log("[ProcessDocument] Workflow started successfully");
			console.log(
				"[ProcessDocument] Workflow execution ID:",
				handle.firstExecutionRunId,
			);

			// Update document with workflow info
			await updateDocumentStatus({
				documentId,
				status: "PROCESSING",
				workflowStatus: "RUNNING",
				workflowId: handle.workflowId,
				workflowRunId: handle.firstExecutionRunId,
			});

			return {
				documentId,
				status: "PROCESSING",
				workflowId: handle.workflowId,
				workflowRunId: handle.firstExecutionRunId,
				message: "Document processing started",
				extractedContent,
				extraction,
			};
		} catch (error) {
			// Workflow failed to start (Temporal worker missing or
			// unreachable). The inline extraction above may have already
			// produced usable text — surface that to the caller alongside
			// the failure flag so the chat surface can still treat the
			// upload as content-bearing instead of filename-only. RAG
			// chunking/embedding for retrieval remains broken until the
			// worker comes back, but the immediate user-facing flow keeps
			// working. Per `fabric/standards/global/error-handling.md`
			// inline UX takes precedence over background-pipeline state.
			logger.warn("[ProcessDocument] Workflow start failed", {
				documentId,
				hasInlineContent: !!extractedContent,
				error: error instanceof Error ? error.message : String(error),
			});

			await updateDocumentStatus({
				documentId,
				status: "FAILED",
				workflowStatus: "FAILED",
				errorMessage:
					error instanceof Error
						? error.message
						: "Failed to start workflow",
			});

			if (extractedContent) {
				return {
					documentId,
					status: "FAILED" as const,
					workflowId: undefined,
					workflowRunId: undefined,
					message:
						"Document processing failed; using inline extraction",
					extractedContent,
					// The workflow is what failed, not the read. A workbook
					// truncated at the budget is still truncated here, and the
					// user is owed that notice either way.
					extraction,
				};
			}

			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: "Failed to start document processing workflow",
			});
		}
	});
