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
	mintParlumeActingGrantForTurn,
	PARLUME_GRANT_SCOPES,
	PARLUME_READ_ONLY_GRANT_SCOPES,
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

describe("a grant limited to a project", () => {
	const project = "project-meeting";

	it("carries its scopes and project to the gateway's check", () => {
		const grant = mintActingGrant({
			...subject,
			scopes: ["features:read", "features:write"],
			projectId: project,
		});

		expect(checkActingGrant(grant, subject)).toEqual({
			ok: true,
			scopes: ["features:read", "features:write"],
			projectId: project,
		});
	});

	it("leaves a chat grant exactly as it was: no scopes, no project", () => {
		expect(checkActingGrant(mintActingGrant(subject), subject)).toEqual({
			ok: true,
		});
	});

	it("drops scopes minted without a project, so a grant never carries one alone", () => {
		const grant = mintActingGrant({
			...subject,
			scopes: ["features:read"],
		});

		expect(checkActingGrant(grant, subject)).toEqual({ ok: true });
	});

	it.each([
		["scopes without a project", { scopes: ["features:read"] }],
		["a project without scopes", { projectId: project }],
		["scopes that are not strings", { scopes: [1], projectId: project }],
		["an empty project", { scopes: ["features:read"], projectId: "" }],
	])("refuses a signed grant with %s", (_name, extra) => {
		const grant = resign({
			p: {
				purpose: "fabric-agent-acting-grant",
				userId: USER,
				organizationId: ORGANIZATION,
				conversationId: null,
				...extra,
			},
			exp: Math.floor(Date.now() / 1000) + 3_600,
		});

		expect(checkActingGrant(grant, subject)).toEqual({
			ok: false,
			reason: "invalid",
		});
	});

	it("refuses a grant whose scopes were changed after signing", () => {
		const grant = mintActingGrant({
			...subject,
			scopes: ["features:read"],
			projectId: project,
		});
		const [head, signature] = grant.split(".");
		const body = JSON.parse(Buffer.from(head, "base64url").toString());
		body.p.scopes = ["projects:write"];
		const tampered = `${Buffer.from(JSON.stringify(body)).toString("base64url")}.${signature}`;

		expect(checkActingGrant(tampered, subject)).toEqual({
			ok: false,
			reason: "invalid",
		});
	});

	it("is for the same user and organization as any other grant", () => {
		const grant = mintActingGrant({
			...subject,
			scopes: ["features:read"],
			projectId: project,
		});

		expect(
			checkActingGrant(grant, {
				...subject,
				organizationId: "other-org",
			}),
		).toEqual({ ok: false, reason: "mismatch" });
	});
});

describe("mintParlumeActingGrantForTurn", () => {
	it("mints the meeting's portal scopes for the meeting's project", () => {
		const grant = mintParlumeActingGrantForTurn({
			...subject,
			projectId: "project-meeting",
			readOnly: false,
		});

		expect(checkActingGrant(grant, subject)).toEqual({
			ok: true,
			scopes: [...PARLUME_GRANT_SCOPES],
			projectId: "project-meeting",
		});
		expect(PARLUME_GRANT_SCOPES).toEqual(
			expect.arrayContaining([
				"features:write",
				"instructions:write",
				"workspaces:read",
				"frames:write",
			]),
		);
		expect(PARLUME_GRANT_SCOPES).toEqual(
			expect.arrayContaining(["orgs:read", "chats:read", "mcp:read"]),
		);
	});

	it("mints a read-only meeting's grant without the portal writes", () => {
		const grant = mintParlumeActingGrantForTurn({
			...subject,
			projectId: "project-meeting",
			readOnly: true,
		});

		const checked = checkActingGrant(grant, subject);
		expect(checked).toEqual({
			ok: true,
			scopes: [...PARLUME_READ_ONLY_GRANT_SCOPES],
			projectId: "project-meeting",
		});
		expect(PARLUME_READ_ONLY_GRANT_SCOPES).toEqual(
			expect.arrayContaining(["projects:read", "features:read"]),
		);
		for (const scope of PARLUME_READ_ONLY_GRANT_SCOPES) {
			expect(scope).not.toMatch(/:write$/);
		}
	});

	it("never mints a write to organizations, chats or connected servers, an authority scope or a wildcard", () => {
		for (const scope of PARLUME_GRANT_SCOPES) {
			expect(scope).not.toMatch(
				/^(?:orgs|chats|mcp):write$|^authority:|^\*$/,
			);
		}
	});

	it("mints nothing, rather than failing the turn, when it cannot sign", () => {
		vi.stubEnv("BETTER_AUTH_SECRET", "");
		const log = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);

		expect(
			mintParlumeActingGrantForTurn({
				...subject,
				projectId: "p",
				readOnly: false,
			}),
		).toBeUndefined();
		expect(log).toHaveBeenCalled();
		log.mockRestore();
	});
});
