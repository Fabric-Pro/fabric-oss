// Deep import, not the `@repo/rag` barrel: the barrel re-exports the factory,
// which reaches the embedding and payments graph, and pulling that in here drags
// it into every consumer of this module — `upload.ts`'s tests broke on a
// transitive `@repo/database` export the moment the barrel was used. This file
// has no dependencies of its own.
import { XlsxInflationCeilingError } from "@repo/rag/lib/extraction/types";
import {
	type AiChatWorkbookClassification,
	DEFAULT_AI_CHAT_EXTRACTED_TEXT_BUDGET_CHARS,
	DEFAULT_AI_CHAT_EXTRACTION_DEADLINE_MS,
	DEFAULT_AI_CHAT_MAX_CELLS,
	DEFAULT_AI_CHAT_MAX_FILE_BYTES,
	DEFAULT_AI_CHAT_MAX_INFLATED_BYTES,
	DEFAULT_AI_CHAT_MAX_ROWS,
	DEFAULT_AI_CHAT_MAX_SHEETS,
	DEFAULT_AI_CHAT_MIME_ALLOWLIST,
} from "@repo/utils/ai-chat-attachment";
import { resolveAttachmentMime } from "@repo/utils/attachment";

/**
 * Upload byte ceiling. The signed PUT carries this as ContentLength, and the
 * server-upload path measures the decoded buffer against it — an operator can
 * lower the cap but not raise it past a size the inline extraction path could
 * not survive.
 */
export const AI_CHAT_MAX_BYTES_CEILING = 100 * 1024 * 1024; // 100 MB

export interface AiChatAttachmentLimits {
	/** Upload cap, enforced at the storage edge and on the server-upload path. */
	maxBytes: number;
	/** MIME types admitted. Empty rejects everything. */
	allowlist: readonly string[];
	/** Ceiling on inflated archive bytes before extraction aborts (U5). */
	maxInflatedBytes: number;
	/** Character budget for text handed inline to the model (U5, chat only). */
	extractedTextBudgetChars: number;
	/** Workbook walk bounds (U5). */
	maxSheets: number;
	maxRows: number;
	maxCells: number;
	/** Deadline checked inside the walk (U5) — extraction runs inline. */
	extractionDeadlineMs: number;
}

function parsePositiveInt(
	raw: string | undefined,
	fallback: number,
	ceiling?: number,
): number {
	if (raw === undefined) {
		return fallback;
	}
	const n = Number.parseInt(raw.trim(), 10);
	if (!Number.isFinite(n) || n <= 0) {
		return fallback;
	}
	return ceiling !== undefined ? Math.min(n, ceiling) : n;
}

/**
 * Server-authoritative AI-chat attachment limits. Env values are
 * operator-trusted server config (NOT request input). Fails closed: the byte
 * cap clamps to the ceiling, and a present-but-empty allowlist env rejects all
 * types. Mirrors `modules/projects/lib/attachment-limits.ts`; the two systems
 * are deliberately separate — story attachments and chat documents have
 * different caps and different pipelines.
 */
export function resolveAiChatAttachmentLimits(): AiChatAttachmentLimits {
	const allowlistEnv = process.env.FABRIC_AI_CHAT_MIME_ALLOWLIST;
	let allowlist: readonly string[];
	if (allowlistEnv === undefined) {
		allowlist = DEFAULT_AI_CHAT_MIME_ALLOWLIST;
	} else {
		allowlist = allowlistEnv
			.split(",")
			.map((s) => s.trim())
			.filter((s) => s.length > 0);
	}

	return {
		maxBytes: parsePositiveInt(
			process.env.FABRIC_AI_CHAT_MAX_BYTES,
			DEFAULT_AI_CHAT_MAX_FILE_BYTES,
			AI_CHAT_MAX_BYTES_CEILING,
		),
		allowlist,
		maxInflatedBytes: parsePositiveInt(
			process.env.FABRIC_AI_CHAT_MAX_INFLATED_BYTES,
			DEFAULT_AI_CHAT_MAX_INFLATED_BYTES,
		),
		extractedTextBudgetChars: parsePositiveInt(
			process.env.FABRIC_AI_CHAT_EXTRACTED_TEXT_BUDGET_CHARS,
			DEFAULT_AI_CHAT_EXTRACTED_TEXT_BUDGET_CHARS,
		),
		maxSheets: parsePositiveInt(
			process.env.FABRIC_AI_CHAT_MAX_SHEETS,
			DEFAULT_AI_CHAT_MAX_SHEETS,
		),
		maxRows: parsePositiveInt(
			process.env.FABRIC_AI_CHAT_MAX_ROWS,
			DEFAULT_AI_CHAT_MAX_ROWS,
		),
		maxCells: parsePositiveInt(
			process.env.FABRIC_AI_CHAT_MAX_CELLS,
			DEFAULT_AI_CHAT_MAX_CELLS,
		),
		extractionDeadlineMs: parsePositiveInt(
			process.env.FABRIC_AI_CHAT_EXTRACTION_DEADLINE_MS,
			DEFAULT_AI_CHAT_EXTRACTION_DEADLINE_MS,
		),
	};
}

/**
 * Resolve the effective MIME for an upload request against the live allowlist,
 * or null when the file is not admissible.
 *
 * Windows with Excel installed reports `.xlsx` uploads as the legacy
 * `application/vnd.ms-excel` MIME, which would otherwise be rejected. The
 * shared `resolveAttachmentMime` prefers an allowlisted declared MIME and
 * otherwise falls back to the filename extension — so a mislabeled `.xlsx`
 * resolves to the spreadsheet MIME and is admitted, while a genuine `.xls`
 * resolves back to `ms-excel`, which this path's allowlist does not carry, and
 * is refused. It fails closed when neither maps.
 */
export function resolveAiChatUploadMime(
	filename: string,
	declaredMime: string | undefined,
): string | null {
	const { allowlist } = resolveAiChatAttachmentLimits();
	return resolveAttachmentMime(filename, declaredMime, allowlist);
}

/**
 * Server-side copy for a workbook the classifier refused. Shared by the two
 * paths that hold real bytes — `upload.ts` (decoded buffer) and
 * `process-document.ts` (post-download) — so the same signature yields the same
 * sentence whichever path the caller took.
 *
 * The pure classifier stays free of user-facing strings; this is where the
 * server's register lives. Tone per `fabric/standards/ai/ai-copy-tone.md`, and
 * "likely" for the password branch because OLE is shared by every legacy Office
 * format — the signature narrows the cause, it does not prove it.
 */
export function describeAiChatWorkbookRejection(
	classification: Exclude<AiChatWorkbookClassification, "accepted">,
	filename: string,
): string {
	switch (classification) {
		case "legacy-unsupported":
			return `"${filename}" is in the legacy Excel format. You can save it as .xlsx and attach it again.`;
		case "likely-password-protected":
			return `"${filename}" couldn't be read — it's likely password-protected. You may want to attach a copy without protection.`;
		case "unreadable":
			return `"${filename}" couldn't be read. It may be corrupt, or not a valid .xlsx workbook.`;
	}
}

/**
 * Server-side copy for a file the inline extraction path could not read.
 *
 * Sits beside `describeAiChatWorkbookRejection` on purpose: both answer "why is
 * there no content?", and a reviewer retuning the register should find them
 * together. The distinction is authority — that one speaks for a container the
 * classifier refused outright, this one for a file that got as far as the
 * extractor and did not survive it.
 *
 * Every branch names what happened *and* what the user is left with, per
 * `docs/solutions/integration-issues/ai-assistant-codebase-availability-misreport.md`:
 * a reason without a next step is still a dead end. Tone per
 * `fabric/standards/ai/ai-copy-tone.md` — advisory, never commanding.
 */
export function describeAiChatExtractionFailure(
	filename: string,
	error: unknown,
): string {
	// Discriminated on the class, not the message: a ceiling refusal is a
	// verdict worth its own sentence, and a substring match would collapse it
	// into the generic branch the first time someone rewords the throw.
	if (error instanceof XlsxInflationCeilingError) {
		return `"${filename}" couldn't be read — it expands to far more data than extraction can hold. You may want to attach a smaller workbook, or split it into parts.`;
	}

	return `"${filename}" couldn't be read, so the assistant sees only its filename. You may want to attach it again.`;
}
