/**
 * What a per-source sync failure classifies as — and, more to the point, whose
 * fault it is (log level) and whether reconnecting the repository is a real
 * fix (the QA-tab banner's reconnect link).
 *
 * Card #2383: every per-source failure used to log at `error` unconditionally
 * on a 15-minute cron, regardless of whose problem it was. The assertions here
 * pin the two things that must never regress: `UNKNOWN` is the only `error`
 * severity, and `reconnectFixes` is true for exactly the two credential kinds —
 * never for a missing permission or an SSO requirement, which
 * `provider-http-error.ts` already explains reconnecting cannot fix.
 */

import { describe, expect, it } from "vitest";
import { ProviderHttpError } from "../fetchers/provider-http-error";
import {
	classificationForKind,
	classifySyncFailure,
	type SyncFailureKind,
} from "../sync-failure-classification";

const providerError = (
	kind:
		| "RATE_LIMITED"
		| "SSO_REQUIRED"
		| "FORBIDDEN"
		| "UNAUTHENTICATED"
		| "OTHER",
	status: number,
) =>
	new ProviderHttpError({
		message: "provider said no",
		kind,
		status,
		providerDetail: null,
	});

describe("classificationForKind", () => {
	const ALL_KINDS: SyncFailureKind[] = [
		"CREDENTIAL_MISSING",
		"CREDENTIAL_REJECTED",
		"PERMISSION_MISSING",
		"SSO_REQUIRED",
		"RATE_LIMITED",
		"NOT_FOUND",
		"MISCONFIGURED",
		"UNKNOWN",
	];

	it("returns itself as `kind` for every classification", () => {
		for (const kind of ALL_KINDS) {
			expect(classificationForKind(kind).kind).toBe(kind);
		}
	});

	it("is `warn` for every kind except UNKNOWN", () => {
		for (const kind of ALL_KINDS) {
			const expected = kind === "UNKNOWN" ? "error" : "warn";
			expect(classificationForKind(kind).severity, kind).toBe(expected);
		}
	});

	it("sets reconnectFixes ONLY for the two credential kinds", () => {
		const reconnectable = new Set<SyncFailureKind>([
			"CREDENTIAL_MISSING",
			"CREDENTIAL_REJECTED",
		]);
		for (const kind of ALL_KINDS) {
			expect(classificationForKind(kind).reconnectFixes, kind).toBe(
				reconnectable.has(kind),
			);
		}
	});

	it("never says reconnecting fixes a missing permission or SSO requirement", () => {
		// The specific regression this guards: provider-http-error.ts spends its
		// whole module doc explaining that a 403 that is not rate-limited and not
		// SSO means the credential is FINE and the resource was refused — telling
		// someone to reconnect adds nothing. Pinned explicitly, not just implied
		// by the loop above.
		expect(classificationForKind("PERMISSION_MISSING").reconnectFixes).toBe(
			false,
		);
		expect(classificationForKind("SSO_REQUIRED").reconnectFixes).toBe(
			false,
		);
	});
});

describe("classifySyncFailure", () => {
	it("maps UNAUTHENTICATED (401) to CREDENTIAL_REJECTED", () => {
		const c = classifySyncFailure(providerError("UNAUTHENTICATED", 401));
		expect(c.kind).toBe("CREDENTIAL_REJECTED");
		expect(c.severity).toBe("warn");
		expect(c.reconnectFixes).toBe(true);
	});

	it("maps FORBIDDEN (403, not rate-limited, not SSO) to PERMISSION_MISSING", () => {
		const c = classifySyncFailure(providerError("FORBIDDEN", 403));
		expect(c.kind).toBe("PERMISSION_MISSING");
		expect(c.severity).toBe("warn");
		expect(c.reconnectFixes).toBe(false);
	});

	it("maps SSO_REQUIRED (403 + x-github-sso) to SSO_REQUIRED", () => {
		const c = classifySyncFailure(providerError("SSO_REQUIRED", 403));
		expect(c.kind).toBe("SSO_REQUIRED");
		expect(c.severity).toBe("warn");
		expect(c.reconnectFixes).toBe(false);
	});

	it("maps RATE_LIMITED (429, or 403 with rate-limit headers) to RATE_LIMITED", () => {
		expect(
			classifySyncFailure(providerError("RATE_LIMITED", 429)).kind,
		).toBe("RATE_LIMITED");
		expect(
			classifySyncFailure(providerError("RATE_LIMITED", 403)).kind,
		).toBe("RATE_LIMITED");
	});

	it("maps OTHER + 404 to NOT_FOUND, warn severity", () => {
		const c = classifySyncFailure(providerError("OTHER", 404));
		expect(c.kind).toBe("NOT_FOUND");
		expect(c.severity).toBe("warn");
		expect(c.reconnectFixes).toBe(false);
	});

	it("maps OTHER + any other status to UNKNOWN, error severity", () => {
		const c = classifySyncFailure(providerError("OTHER", 500));
		expect(c.kind).toBe("UNKNOWN");
		expect(c.severity).toBe("error");
	});

	it("maps a plain Error (not a ProviderHttpError) to UNKNOWN", () => {
		const c = classifySyncFailure(new Error("ECONNRESET"));
		expect(c.kind).toBe("UNKNOWN");
		expect(c.severity).toBe("error");
	});

	it("maps a non-Error thrown value to UNKNOWN", () => {
		expect(classifySyncFailure("a bare string throw").kind).toBe("UNKNOWN");
		expect(classifySyncFailure(undefined).kind).toBe("UNKNOWN");
		expect(classifySyncFailure(null).kind).toBe("UNKNOWN");
		expect(classifySyncFailure({ some: "object" }).kind).toBe("UNKNOWN");
	});
});
