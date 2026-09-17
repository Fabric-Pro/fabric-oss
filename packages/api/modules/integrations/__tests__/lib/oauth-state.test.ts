/**
 * `oauth-state` — the signed state codec.
 *
 * A state names the user and the organization an integration OAuth flow was
 * started from. Integration OAuth has no organization-less arm (ADR-018), so
 * the decoder refuses a state without one: otherwise a legacy in-flight state,
 * or one hand-built with a leaked signing key, would carry the callback past
 * the membership check into an organization-less credential write.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
	decodeOAuthState,
	encodeOAuthState,
	STATE_MAX_AGE_MS,
} from "../../lib/oauth-state";

beforeAll(() => {
	process.env.ENCRYPTION_KEY = "test-encryption-key-for-oauth-state";
});

/** Sign an arbitrary payload the way `encodeOAuthState` does, bypassing its type. */
function signRaw(payload: Record<string, unknown>): string {
	// `encodeOAuthState` spreads the payload, so unknown and undefined
	// fields pass straight through to the signed JSON.
	return encodeOAuthState(
		payload as unknown as Parameters<typeof encodeOAuthState>[0],
	);
}

describe("decodeOAuthState", () => {
	it("round-trips a state that names its user and organization", () => {
		const state = encodeOAuthState({
			userId: "user-1",
			organizationId: "org-1",
			provider: "SLACK",
		});
		expect(decodeOAuthState(state)).toMatchObject({
			userId: "user-1",
			organizationId: "org-1",
			provider: "SLACK",
		});
	});

	it("refuses a state without an organization", () => {
		const state = signRaw({
			userId: "user-1",
			organizationId: undefined,
			provider: "SLACK",
		});
		expect(decodeOAuthState(state)).toBeNull();
	});

	it("refuses a state whose organization is empty or not a string", () => {
		expect(
			decodeOAuthState(
				signRaw({
					userId: "user-1",
					organizationId: "",
					provider: "SLACK",
				}),
			),
		).toBeNull();
		expect(
			decodeOAuthState(
				signRaw({
					userId: "user-1",
					organizationId: null,
					provider: "SLACK",
				}),
			),
		).toBeNull();
		expect(
			decodeOAuthState(
				signRaw({
					userId: "user-1",
					organizationId: 42,
					provider: "SLACK",
				}),
			),
		).toBeNull();
	});

	it("refuses a state without a user", () => {
		const state = signRaw({
			organizationId: "org-1",
			provider: "SLACK",
		});
		expect(decodeOAuthState(state)).toBeNull();
	});

	it("refuses a tampered payload", () => {
		const state = encodeOAuthState({
			userId: "user-1",
			organizationId: "org-1",
			provider: "SLACK",
		});
		const [payload, signature] = state.split(".");
		const tampered = Buffer.from(
			JSON.stringify({
				...JSON.parse(
					Buffer.from(payload, "base64url").toString("utf8"),
				),
				organizationId: "org-victim",
			}),
		).toString("base64url");
		expect(decodeOAuthState(`${tampered}.${signature}`)).toBeNull();
	});

	it("refuses an expired state", () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date("2026-09-16T12:00:00Z"));
			const state = encodeOAuthState({
				userId: "user-1",
				organizationId: "org-1",
				provider: "SLACK",
			});
			expect(decodeOAuthState(state)).not.toBeNull();
			vi.setSystemTime(
				new Date(
					Date.parse("2026-09-16T12:00:00Z") +
						STATE_MAX_AGE_MS +
						1_000,
				),
			);
			expect(decodeOAuthState(state)).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});
});
