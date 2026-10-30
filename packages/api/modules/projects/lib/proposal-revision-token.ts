import { createHash } from "node:crypto";
import {
	signToken,
	type VerifyResult,
	verifyToken,
} from "@repo/auth/lib/signed-token";
import { sectionFingerprint } from "@repo/utils/proposal-artifact/preservation";

/**
 * The revision token of a finding-driven revision (Fizzy #2946).
 *
 * `projects.proposalArtifact.reviseSection` signs one with the candidate it
 * returns; the accept that saves that candidate as Resolved presents it to
 * `projects.documents.update`. The server then knows the saved section is the
 * one it produced for this user, document, run and finding, from this base,
 * against the answer the revision started from, so a hand edit cannot be
 * saved as Resolved.
 *
 * Signed with `BETTER_AUTH_SECRET` through the same `signToken` the
 * invitation, email-change and acting-grant tokens use; no new secret. A
 * `purpose` inside the signed payload keeps it from being read as, or
 * confused with, any other token that secret signs. The payload is readable
 * by the holder: it carries ids, a version and a hash, never text.
 */
const REVISION_TOKEN_PURPOSE = "fabric-proposal-revision";
/** Long enough to review a candidate, short enough to stay near its base. */
const REVISION_TOKEN_TTL_SECONDS = 30 * 60;

export type RevisionTokenPayload = {
	userId: string;
	documentId: string;
	runId: string;
	findingId: string;
	/** The document version the revision read. */
	baseVersion: number;
	/** The answer the revision started from, or null when there was none. */
	response: { id: string; version: number } | null;
	sectionKey: string;
	/** {@link revisionSectionFingerprint} of the candidate section. */
	sectionFingerprint: string;
};

type SignedRevisionToken = RevisionTokenPayload & {
	purpose: typeof REVISION_TOKEN_PURPOSE;
};

/**
 * What a revision token signs for the section `sectionKey` of `body`: a
 * SHA-256 of its preservation fingerprint (heading, prose hash, link and
 * image destinations, diagrams), which the editor's re-serialisation of the
 * same section keeps. Hashed because the fingerprint holds the section's
 * URLs and heading text. Undefined when `body` has no such section.
 */
export function revisionSectionFingerprint(
	body: string,
	sectionKey: string,
): string | undefined {
	const fingerprint = sectionFingerprint(body, sectionKey);
	return fingerprint === undefined
		? undefined
		: createHash("sha256").update(fingerprint).digest("hex");
}

export function signRevisionToken(payload: RevisionTokenPayload): string {
	return signToken<SignedRevisionToken>(
		{
			purpose: REVISION_TOKEN_PURPOSE,
			userId: payload.userId,
			documentId: payload.documentId,
			runId: payload.runId,
			findingId: payload.findingId,
			baseVersion: payload.baseVersion,
			response: payload.response
				? { id: payload.response.id, version: payload.response.version }
				: null,
			sectionKey: payload.sectionKey,
			sectionFingerprint: payload.sectionFingerprint,
		},
		{ ttlSec: REVISION_TOKEN_TTL_SECONDS },
	);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isVersion(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function readResponse(
	value: unknown,
): { ok: true; response: RevisionTokenPayload["response"] } | { ok: false } {
	if (value === null) {
		return { ok: true, response: null };
	}
	if (typeof value !== "object") {
		return { ok: false };
	}
	const { id, version } = value as Record<string, unknown>;
	return isNonEmptyString(id) && isVersion(version)
		? { ok: true, response: { id, version } }
		: { ok: false };
}

/**
 * The payload of a token this server signed for a revision, or null when the
 * token is malformed, forged, tampered with, expired, signed for another
 * purpose, or the signing secret is not configured.
 */
export function verifyRevisionToken(
	token: string,
): RevisionTokenPayload | null {
	let verified: VerifyResult<unknown>;
	try {
		verified = verifyToken<unknown>(token);
	} catch {
		// Nothing can be verified without the secret, so nothing is accepted.
		return null;
	}
	if (!verified.ok) {
		return null;
	}
	const value = verified.payload;
	if (typeof value !== "object" || value === null) {
		return null;
	}
	const payload = value as Record<string, unknown>;
	const response = readResponse(payload.response);
	if (
		payload.purpose !== REVISION_TOKEN_PURPOSE ||
		!isNonEmptyString(payload.userId) ||
		!isNonEmptyString(payload.documentId) ||
		!isNonEmptyString(payload.runId) ||
		!isNonEmptyString(payload.findingId) ||
		!isVersion(payload.baseVersion) ||
		!response.ok ||
		!isNonEmptyString(payload.sectionKey) ||
		!isNonEmptyString(payload.sectionFingerprint)
	) {
		return null;
	}
	return {
		userId: payload.userId,
		documentId: payload.documentId,
		runId: payload.runId,
		findingId: payload.findingId,
		baseVersion: payload.baseVersion,
		response: response.response,
		sectionKey: payload.sectionKey,
		sectionFingerprint: payload.sectionFingerprint,
	};
}
