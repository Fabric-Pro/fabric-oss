/**
 * The acting grant: what lets Fabric's agent runtime act for a person.
 *
 * The agent service secret is held by the worker, the agent containers and
 * internal routes, and the ids it is sent with are not secret. The grant is the
 * one thing only the web app can issue, bound to a user, an organization and a
 * conversation, with an expiry the signature covers. These tests pin what makes
 * a grant refuse: absent, forged, tampered, expired, another purpose, another
 * person, another tenant, another conversation, or no secret to check against.
 */

import { createHmac } from "node:crypto";
import { signToken } from "@repo/auth/lib/signed-token";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	checkActingGrant,
	mintActingGrant,
	mintActingGrantForTurn,
} from "../agent-service-auth";

const SECRET = "grant-test-secret-that-is-at-least-32-chars";
const USER = "user-1";
const ORGANIZATION = "example-org";
const CONVERSATION = "conversation-1";

const subject = { userId: USER, organizationId: ORGANIZATION };

beforeEach(() => {
	vi.stubEnv("BETTER_AUTH_SECRET", SECRET);
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
});

/** Re-signs a body with the real secret, as only someone holding it could. */
function resign(body: Record<string, unknown>): string {
	const head = Buffer.from(JSON.stringify(body)).toString("base64url");
	const signature = createHmac("sha256", SECRET)
		.update(head)
		.digest("base64url");
	return `${head}.${signature}`;
}

describe("checkActingGrant", () => {
	it("accepts a grant minted for this user and organization", () => {
		expect(checkActingGrant(mintActingGrant(subject), subject)).toEqual({
			ok: true,
		});
	});

	it("accepts a grant minted for a conversation when the call names the same one", () => {
		const grant = mintActingGrant({
			...subject,
			conversationId: CONVERSATION,
		});

		expect(
			checkActingGrant(grant, {
				...subject,
				conversationId: CONVERSATION,
			}),
		).toEqual({ ok: true });
	});

	it("accepts a call that names no conversation, and a grant that names none", () => {
		expect(
			checkActingGrant(
				mintActingGrant({ ...subject, conversationId: CONVERSATION }),
				subject,
			),
		).toEqual({ ok: true });
		expect(
			checkActingGrant(mintActingGrant(subject), {
				...subject,
				conversationId: CONVERSATION,
			}),
		).toEqual({ ok: true });
	});

	it.each([[undefined], [null], [""]])(
		"refuses a missing grant (%j)",
		(grant) => {
			expect(checkActingGrant(grant, subject)).toEqual({
				ok: false,
				reason: "missing",
			});
		},
	);

	it.each([
		["a string that is no token", "not-a-token"],
		["three parts", "a.b.c"],
	])("refuses %s", (_, grant) => {
		expect(checkActingGrant(grant, subject)).toEqual({
			ok: false,
			reason: "invalid",
		});
	});

	it("refuses a body with its signature taken off", () => {
		const [head] = mintActingGrant(subject).split(".");

		expect(checkActingGrant(`${head}.`, subject)).toEqual({
			ok: false,
			reason: "invalid",
		});
	});

	it("refuses a grant signed with another secret", () => {
		vi.stubEnv(
			"BETTER_AUTH_SECRET",
			"a-different-secret-that-is-32-chars-or-more",
		);
		const forged = mintActingGrant(subject);
		vi.stubEnv("BETTER_AUTH_SECRET", SECRET);

		expect(checkActingGrant(forged, subject)).toEqual({
			ok: false,
			reason: "invalid",
		});
	});

	it("refuses a body that was edited after it was signed", () => {
		const [head, signature] = mintActingGrant(subject).split(".");
		const body = JSON.parse(Buffer.from(head, "base64url").toString());
		body.p.userId = "someone-else";
		const edited = `${Buffer.from(JSON.stringify(body)).toString("base64url")}.${signature}`;

		expect(
			checkActingGrant(edited, { ...subject, userId: "someone-else" }),
		).toEqual({ ok: false, reason: "invalid" });
	});

	it("refuses an expired grant, and says it expired", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-10-14T10:00:00Z"));
		const grant = mintActingGrant(subject);

		vi.setSystemTime(new Date("2026-10-14T10:59:59Z"));
		expect(checkActingGrant(grant, subject)).toEqual({ ok: true });

		vi.setSystemTime(new Date("2026-10-14T11:00:02Z"));
		expect(checkActingGrant(grant, subject)).toEqual({
			ok: false,
			reason: "expired",
		});
	});

	it("refuses a token the same secret signed for another purpose", () => {
		const other = signToken(
			{ userId: USER, organizationId: ORGANIZATION },
			{
				ttlSec: 60,
			},
		);
		const withPurpose = signToken(
			{
				purpose: "email-change",
				userId: USER,
				organizationId: ORGANIZATION,
				conversationId: null,
			},
			{ ttlSec: 60 },
		);

		expect(checkActingGrant(other, subject)).toEqual({
			ok: false,
			reason: "invalid",
		});
		expect(checkActingGrant(withPurpose, subject)).toEqual({
			ok: false,
			reason: "invalid",
		});
	});

	it("refuses a signed body of the wrong shape", () => {
		const exp = Math.floor(Date.now() / 1000) + 60;

		expect(checkActingGrant(resign({ p: "text", exp }), subject)).toEqual({
			ok: false,
			reason: "invalid",
		});
		expect(checkActingGrant(resign({ p: null, exp }), subject)).toEqual({
			ok: false,
			reason: "invalid",
		});
	});

	it("refuses a call that acts for another user than the grant names", () => {
		expect(
			checkActingGrant(mintActingGrant(subject), {
				...subject,
				userId: "someone-else",
			}),
		).toEqual({ ok: false, reason: "mismatch" });
	});

	it("refuses a call that acts in another organization than the grant names", () => {
		expect(
			checkActingGrant(mintActingGrant(subject), {
				...subject,
				organizationId: "another-org",
			}),
		).toEqual({ ok: false, reason: "mismatch" });
	});

	it("refuses a call from another conversation than the grant names", () => {
		const grant = mintActingGrant({
			...subject,
			conversationId: CONVERSATION,
		});

		expect(
			checkActingGrant(grant, {
				...subject,
				conversationId: "conversation-2",
			}),
		).toEqual({ ok: false, reason: "mismatch" });
	});

	it("accepts nothing when there is no secret to check against", () => {
		const grant = mintActingGrant(subject);
		vi.stubEnv("BETTER_AUTH_SECRET", "");

		expect(checkActingGrant(grant, subject)).toEqual({
			ok: false,
			reason: "invalid",
		});
	});
});

describe("mintActingGrantForTurn", () => {
	it("mints a grant a gateway check accepts, for the turn's user, organization and conversation", () => {
		const grant = mintActingGrantForTurn({
			...subject,
			conversationId: CONVERSATION,
		});

		expect(grant).toBeDefined();
		expect(
			checkActingGrant(grant, {
				...subject,
				conversationId: CONVERSATION,
			}),
		).toEqual({ ok: true });
		expect(
			checkActingGrant(grant, {
				...subject,
				conversationId: "conversation-2",
			}),
		).toEqual({ ok: false, reason: "mismatch" });
	});

	it.each([[null], [undefined], [""]])(
		"mints nothing for a turn with no organization (%j)",
		(organizationId) => {
			expect(
				mintActingGrantForTurn({ userId: USER, organizationId }),
			).toBeUndefined();
		},
	);

	it("mints nothing, rather than failing the turn, when it cannot sign", () => {
		vi.stubEnv("BETTER_AUTH_SECRET", "");
		const log = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);

		expect(mintActingGrantForTurn(subject)).toBeUndefined();
		expect(log).toHaveBeenCalledTimes(1);
	});
});
