/**
 * Pure formatter for the operation-result chat message.
 *
 * Input: outcome + label + summary + optional artifact link + optional
 *        errorCode.
 * Output: `{ content, metadata }` — both ready to drop into
 *         `ConversationMessage` for the operation_result variant.
 *
 * This module deliberately has ZERO side effects (no DB, no logging,
 * no env access). It must be safe to import from
 *   - `@repo/temporal` workflow code (which is deterministic and must
 *     never touch I/O during replay),
 *   - `@repo/api` oRPC handlers (server side, request-scoped),
 *   - `@repo/database` queries (avoid — currently no import path needed).
 *
 * Why `@repo/utils` and not `@repo/api`?
 *   `@repo/temporal` cannot import from `@repo/api` (would invert the
 *   dep graph: API depends on Temporal, not the other way). `@repo/utils`
 *   is neutral and already a dependency of both.
 *
 * # Content shape (I3 — link no longer inlined)
 *
 *   {HEADER}
 *
 *   {summary?}{TRUNCATION_SUFFIX?}
 *
 * The artifact link does NOT appear in `content` — it travels via
 * `metadata.artifact` and the renderer (`<SystemMessage>`) displays it
 * as a separate paragraph element. A prior revision inlined
 * `\n\n[Label](URL)` at the end of `content` and relied on a regex
 * strip in the renderer to peel it back off before markdown-rendering;
 * that regex over-matched any caller-supplied summary that itself
 * ended with a markdown link. Splitting the data shape eliminates the
 * entire regex.
 *
 * ## Contract for downstream consumers of `ConversationMessage`
 *
 *   **Artifact links live in `metadata.artifact`, NOT in `content`.**
 *
 *   Any consumer that reads ONLY `content` (search indexing, plaintext
 *   exports, transcript downloads, mobile/alternate renderers, copy-
 *   share clipboard paths, third-party integrations) will see only the
 *   header + summary and will silently miss the artifact reference.
 *
 *   Today the only user-visible renderer is
 *   `apps/web/components/ai-elements/SystemMessage.tsx`, which reads
 *   `metadata.artifact` and renders a separate deep-link element. Any
 *   NEW consumer MUST follow the same
 *   pattern. If you find yourself building a consumer that can only
 *   read `content`, surface the artifact via a hyperlink in the
 *   summary BEFORE it reaches this formatter (i.e. the caller
 *   negotiates the link into the summary text), don't expect this
 *   module to do it for you.
 *
 * # Truncation budget
 *
 *   total = HEADER.length + 2 (sep) + summary.length + (suffix? suffix.length : 0)
 *
 * If total > MAX_CONTENT_LENGTH (2000), slice the summary by
 * `surplus + suffix.length` chars then append suffix. The link is no
 * longer part of content, so no link budget reservation is needed.
 *
 * # Error masking (FR-11)
 *
 * If either `errorCode` or `summary` looks like a stack trace (regex
 * heuristic), the summary is replaced with a generic copy. The original
 * `errorCode` is dropped from `metadata` in that case so the redaction
 * isn't leaked back through structured data.
 */

export type OperationOutcome = "success" | "failure" | "partial" | "cancelled";

export interface OperationArtifact {
	readonly label: string;
	readonly url: string;
}

export interface BuildOperationResultMessageInput {
	readonly outcome: OperationOutcome;
	readonly operationLabel: string;
	readonly summary: string;
	readonly artifact?: OperationArtifact;
	readonly errorCode?: string;
}

export interface OperationResultMessageMetadata {
	readonly kind: "operation_result";
	readonly outcome: OperationOutcome;
	readonly operationLabel: string;
	readonly artifact?: OperationArtifact;
	readonly errorCode?: string;
}

export interface BuildOperationResultMessageOutput {
	readonly content: string;
	readonly metadata: OperationResultMessageMetadata;
}

const HEADER = "SYSTEM";
const TRUNCATION_SUFFIX = "…";
const MAX_CONTENT_LENGTH = 2000;
const PARA_SEP = "\n\n";

/**
 * Heuristic: a stack trace usually contains
 *   - `"at "` followed by an identifier and a file path, OR
 *   - file paths with line:column like `(:42:7)`, OR
 *   - the bare prefix `"Error:"` / `"TypeError:"` / etc. followed by
 *     newlines and stack lines.
 *
 * We tolerate false positives in favour of conservatively masking
 * anything that looks Node-ish — the worst case is a slightly less
 * specific user-facing error message, not a stack trace leaked into the
 * chat UI.
 */
const STACK_TRACE_RE = /(\n\s*at\s+[\w$.<>]+\s*\(?|^\s*(Type)?Error:)/m;

function looksLikeStackTrace(value: string | undefined): boolean {
	if (!value) {
		return false;
	}
	return STACK_TRACE_RE.test(value);
}

function genericFailureCopy(outcome: OperationOutcome): string {
	if (outcome === "failure") {
		return "The operation failed. Check the activity log for details.";
	}
	if (outcome === "partial") {
		return "The operation partially completed. Check the activity log for details.";
	}
	if (outcome === "cancelled") {
		return "The operation was cancelled.";
	}
	return "The operation completed.";
}

export function buildOperationResultMessage(
	input: BuildOperationResultMessageInput,
): BuildOperationResultMessageOutput {
	const { outcome, operationLabel, summary, artifact, errorCode } = input;

	// FR-11: stack-trace masking.
	const masked =
		looksLikeStackTrace(errorCode) || looksLikeStackTrace(summary);
	const effectiveSummary = masked ? genericFailureCopy(outcome) : summary;

	// Fixed overhead: header + paragraph separator. The artifact link
	// no longer lives in content (I3) — it travels via metadata only —
	// so it does not consume the summary budget.
	const fixedOverhead = HEADER.length + PARA_SEP.length;
	const summaryBudget = MAX_CONTENT_LENGTH - fixedOverhead;

	let renderedSummary = effectiveSummary;
	if (renderedSummary.length > summaryBudget) {
		const sliceTo = summaryBudget - TRUNCATION_SUFFIX.length;
		if (sliceTo > 0) {
			renderedSummary =
				renderedSummary.slice(0, sliceTo) + TRUNCATION_SUFFIX;
		} else {
			renderedSummary = "";
		}
	}

	const content = `${HEADER}${PARA_SEP}${renderedSummary}`;

	const metadata: OperationResultMessageMetadata = {
		kind: "operation_result",
		outcome,
		operationLabel,
		...(artifact ? { artifact } : {}),
		...(errorCode && !masked ? { errorCode } : {}),
	};

	return { content, metadata };
}
