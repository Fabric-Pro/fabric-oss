import {
	failGlossyBuild,
	markGlossyBuildSuperseded,
	recordAudit,
} from "@repo/database";
import { redactLogText } from "@repo/utils/log-redaction";
import {
	GLOSSY_BUILD_NON_RETRYABLE_ERROR_TYPE_SET,
	type GlossyBuildNonRetryableErrorType,
} from "../../workflows/ai-non-retryable-errors";
import { GLOSSY_BUILD_FAILURE_MESSAGES, GLOSSY_BUILD_LOG } from "./shared";
import type {
	FailGlossyBuildActivityInput,
	FailGlossyBuildActivityResult,
	GlossyBuildErrorCode,
} from "./types";

/**
 * The build workflow's failure path (Fizzy #2589, R9, R30, KTD4, KTD5,
 * KTD24).
 *
 * One guarded write records the attempt FAILED with a fixed code and a fixed
 * message and releases the claim; the published edition is untouched, so
 * viewers keep the previous one. The failure's own text never reaches the
 * row — it can quote the document, a provider URL, or a key — and is logged
 * only after redaction, with URLs and key-shaped tokens removed as well, and
 * truncated. `build_failed` is audited only when the write applied: an
 * attempt that already lost its claim marks itself superseded instead.
 */

/** Longest failure detail that reaches the log. */
const LOG_DETAIL_MAX_CHARS = 300;

/** Scanned at most this far, so a huge message cannot slow the redaction. */
const LOG_DETAIL_SCAN_CHARS = 4_000;

export function glossyBuildErrorCode(code: string): GlossyBuildErrorCode {
	return GLOSSY_BUILD_NON_RETRYABLE_ERROR_TYPE_SET.has(code)
		? (code as GlossyBuildNonRetryableErrorType)
		: "BUILD_FAILED";
}

/**
 * Failure text for the log. `redactLogText` covers credentials, tokens, and
 * PII; provider keys of the `sk-…` shape and URLs — which can name an
 * internal host — are removed here too.
 */
export function redactGlossyFailureDetail(
	detail: string | null | undefined,
): string | null {
	if (!detail) {
		return null;
	}
	const { text } = redactLogText(detail.slice(0, LOG_DETAIL_SCAN_CHARS));
	const scrubbed = text
		.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, "[URL]")
		.replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, "[REDACTED]")
		.replace(/\s+/g, " ")
		.trim();
	return scrubbed.length > LOG_DETAIL_MAX_CHARS
		? `${scrubbed.slice(0, LOG_DETAIL_MAX_CHARS - 1)}…`
		: scrubbed;
}

export async function failGlossyBuildActivity(
	input: FailGlossyBuildActivityInput,
): Promise<FailGlossyBuildActivityResult> {
	const code = glossyBuildErrorCode(input.code);
	console.warn(`${GLOSSY_BUILD_LOG} Build failed`, {
		buildId: input.buildId,
		code,
		detail: redactGlossyFailureDetail(input.detail),
	});

	const outcome = await failGlossyBuild({
		buildId: input.buildId,
		errorCode: code,
		errorMessage: GLOSSY_BUILD_FAILURE_MESSAGES[code],
	});
	if (outcome === "superseded") {
		await markGlossyBuildSuperseded(input.buildId);
		return { outcome, code };
	}

	recordAudit({
		action: "project.glossy_edition.build_failed",
		category: "project",
		severity: "warning",
		outcome: "failure",
		actor: { type: "user", userId: input.startedById },
		organizationId: input.organizationId,
		projectId: input.projectId,
		resource: { type: "project_document", id: input.documentId },
		metadata: { buildId: input.buildId, errorCode: code },
	});
	return { outcome, code };
}
