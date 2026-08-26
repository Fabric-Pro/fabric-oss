import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildInvitationToken,
	parseInvitationToken,
} from "../invitation-token";
import { signToken } from "../signed-token";

describe("invitation token", () => {
	const original = { ...process.env };
	beforeEach(() => {
		process.env = {
			...original,
			BETTER_AUTH_SECRET: "test-secret-32-chars-or-longer-aaaaaa",
		};
	});
	afterEach(() => {
		process.env = { ...original };
	});

	it("round-trips invitationId + email", () => {
		const tok = buildInvitationToken({
			invitationId: "i1",
			email: "a@b.com",
		});
		const v = parseInvitationToken(tok);
		expect(v.ok).toBe(true);
		if (v.ok) {
			expect(v.payload).toMatchObject({
				invitationId: "i1",
				email: "a@b.com",
			});
		}
	});

	it("rejects tampered email (payload mutation)", () => {
		const tok = buildInvitationToken({
			invitationId: "i1",
			email: "a@b.com",
		});
		const [head, sig] = tok.split(".");
		// Corrupt the last two chars of the base64url-encoded JSON head
		const tampered = `${head.slice(0, -2)}xx.${sig}`;
		expect(parseInvitationToken(tampered).ok).toBe(false);
	});

	it("rejects tampered signature", () => {
		const tok = buildInvitationToken({
			invitationId: "i1",
			email: "a@b.com",
		});
		const [head] = tok.split(".");
		expect(parseInvitationToken(`${head}.deadbeef`).ok).toBe(false);
	});

	it("rejects expired token (ttlSec -1)", () => {
		// Build an already-expired token using signToken directly
		const expiredTok = signToken<{ invitationId: string; email: string }>(
			{ invitationId: "i1", email: "a@b.com" },
			{ ttlSec: -1 },
		);
		const v = parseInvitationToken(expiredTok);
		expect(v.ok).toBe(false);
		if (!v.ok) {
			expect(v.reason).toBe("expired");
		}
	});

	it("rejects token with missing parts (format error)", () => {
		expect(parseInvitationToken("notavalidtoken").ok).toBe(false);
	});
});
