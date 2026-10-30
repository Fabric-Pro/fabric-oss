/**
 * Refusal codes of an AI accept saved to a client-document Proposal's Main
 * (Fizzy #2946).
 *
 * The editor's accept of a chat proposal or of a finding-driven revision
 * names itself to `projects.documents.update` with an `aiReview` descriptor.
 * The server checks the change as it would be saved and answers a refused
 * save with `PRECONDITION_FAILED` and one of these as `data.code`, so the
 * editor can restore the text from before the accept and say why.
 *
 * Client-safe: constants only, so the procedure and the web's localized
 * refusal copy share one string. The two structure codes are spelled out
 * rather than read from `preservation.ts`, so importing them never pulls the
 * Markdown parser into a bundle; the types keep them equal.
 */

import type { PreservationViolationCode } from "./preservation";

export const SCOPED_REVISION_REFUSAL = {
	/** A section outside what the change targeted changed. */
	OUTSIDE_TARGET:
		"REVISION_OUTSIDE_TARGET" satisfies PreservationViolationCode,
	/** An existing diagram changed or went away. */
	CHANGED_DIAGRAM:
		"REVISION_CHANGED_DIAGRAM" satisfies PreservationViolationCode,
	/** Main repeats the wording of an answer, a finding or its recommendation. */
	RESPONSE_ECHOED: "RESPONSE_ECHOED",
	/** The finding's answer changed since the revision started. */
	FINDING_RESPONSE_CHANGED: "FINDING_RESPONSE_CHANGED",
	/** The finding's section changed since the analysis raised it. */
	FINDING_SECTION_CHANGED: "FINDING_SECTION_CHANGED",
	/**
	 * The revision token is missing its signature, expired, issued for
	 * another revision, or the saved section is not the revised one.
	 */
	REVISION_TOKEN_INVALID: "REVISION_TOKEN_INVALID",
} as const;

export type ScopedRevisionRefusalCode =
	(typeof SCOPED_REVISION_REFUSAL)[keyof typeof SCOPED_REVISION_REFUSAL];

export const SCOPED_REVISION_REFUSAL_CODES: readonly ScopedRevisionRefusalCode[] =
	Object.values(SCOPED_REVISION_REFUSAL);

/** Whether `code` is one of {@link SCOPED_REVISION_REFUSAL}'s codes. */
export function isScopedRevisionRefusalCode(
	code: unknown,
): code is ScopedRevisionRefusalCode {
	return (
		typeof code === "string" &&
		(SCOPED_REVISION_REFUSAL_CODES as readonly string[]).includes(code)
	);
}

/**
 * The `aiReview` descriptor an AI accept sends with its save to
 * `projects.documents.update`: a chat proposal with the previous body's
 * section keys inside every subtree it patched, or a finding-driven revision
 * with the token `reviseSection` returned.
 */
export type DocumentAiReviewDescriptor =
	| { kind: "CHAT"; patchedSectionKeys?: string[] }
	| {
			kind: "FINDING";
			runId: string;
			findingId: string;
			revisionToken: string;
	  };
