/**
 * The external agents API asks two questions of a key, not one.
 *
 * The scope check has always been there: it asks what the key was granted when
 * it was minted. `verifyOrganizationApiKey` added the second half of the tenant
 * question — whether the owner is still a member — but nothing asked what their
 * role had become. So a key minted by a member kept executing agents after its
 * owner was demoted to a read-only role that may list them and not run them
 * (Fizzy #2380, QA round two).
 *
 * These pin the role gate, and just as importantly pin where it does NOT apply:
 * on the reads, whose permissions every role holds, and on a personal key,
 * which names no organization to hold a role in.
 */

import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	verifyOrganizationApiKey: vi.fn(),
	verifyUserApiKey: vi.fn(),
	canExecuteOrganizationAgents: vi.fn(),
}));

vi.mock("@repo/database", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		verifyOrganizationApiKey: mocks.verifyOrganizationApiKey,
		canExecuteOrganizationAgents: mocks.canExecuteOrganizationAgents,
	};
});

vi.mock("../../../users/procedures/api-keys/verify", () => ({
	verifyUserApiKey: mocks.verifyUserApiKey,
}));

import type { ExternalApiVariables } from "../../types";
import { requireApiKey, requireScope } from "../api-key-auth";

const ORG_KEY = "org_aaaaaaaa_secret";
const PERSONAL_KEY = "fab_bbbbbbbb_secret";

function appRequiring(scope: string) {
	const app = new Hono<{ Variables: ExternalApiVariables }>();
	app.use("*", requireApiKey());
	app.get("/thing", requireScope(scope), (c) => c.json({ ok: true }));
	return app;
}

function call(app: Hono<{ Variables: ExternalApiVariables }>, key: string) {
	return app.request("/thing", {
		headers: { Authorization: `Bearer ${key}` },
	});
}

function orgKeyWith(scopes: string[]) {
	return {
		id: "key-1",
		organizationId: "org-123",
		createdByUserId: "user-demoted",
		scopes,
	};
}

beforeEach(() => {
	mocks.verifyOrganizationApiKey.mockReset();
	mocks.verifyUserApiKey.mockReset();
	mocks.canExecuteOrganizationAgents.mockReset().mockResolvedValue(true);
});

describe("agents:execute — the owner's current role", () => {
	it("refuses when the owner may no longer execute agents", async () => {
		mocks.verifyOrganizationApiKey.mockResolvedValue(
			orgKeyWith(["agents:execute"]),
		);
		mocks.canExecuteOrganizationAgents.mockResolvedValue(false);

		const res = await call(appRequiring("agents:execute"), ORG_KEY);

		expect(res.status).toBe(403);
		const body = await res.json();
		expect(body.error).toContain("no longer holds");
	});

	it("asks about the key's creator in the key's organization", async () => {
		mocks.verifyOrganizationApiKey.mockResolvedValue(
			orgKeyWith(["agents:execute"]),
		);

		await call(appRequiring("agents:execute"), ORG_KEY);

		expect(mocks.canExecuteOrganizationAgents).toHaveBeenCalledWith(
			"user-demoted",
			"org-123",
		);
	});

	it("refuses a WILDCARD key too", async () => {
		// `hasScope` answers true for `*`. A permission check written inside
		// the concrete-scope branch would never run for the widest keys — the
		// exact shape of the bug this gate exists to close.
		mocks.verifyOrganizationApiKey.mockResolvedValue(orgKeyWith(["*"]));
		mocks.canExecuteOrganizationAgents.mockResolvedValue(false);

		const res = await call(appRequiring("agents:execute"), ORG_KEY);

		expect(res.status).toBe(403);
	});

	it("serves a key whose owner kept the role", async () => {
		mocks.verifyOrganizationApiKey.mockResolvedValue(
			orgKeyWith(["agents:execute"]),
		);

		const res = await call(appRequiring("agents:execute"), ORG_KEY);

		expect(res.status).toBe(200);
	});

	it("keeps the missing-scope refusal distinct from the lost-role one", async () => {
		mocks.verifyOrganizationApiKey.mockResolvedValue(
			orgKeyWith(["agents:read"]),
		);

		const res = await call(appRequiring("agents:execute"), ORG_KEY);

		expect(res.status).toBe(403);
		const body = await res.json();
		expect(body.error).toContain("Missing required scope");
		expect(mocks.canExecuteOrganizationAgents).not.toHaveBeenCalled();
	});
});

describe("where the role gate deliberately does not reach", () => {
	it("does not gate agents:read — every role may list agents", async () => {
		// Not an oversight. `AGENT_READ` sits in the viewer set, so a gate here
		// could refuse nobody, and the org-wide reach of the read is not an
		// escalation: the in-app agents list filters on the organization alone,
		// so a key sees exactly what its owner sees in the browser.
		mocks.verifyOrganizationApiKey.mockResolvedValue(
			orgKeyWith(["agents:read"]),
		);
		mocks.canExecuteOrganizationAgents.mockResolvedValue(false);

		const res = await call(appRequiring("agents:read"), ORG_KEY);

		expect(res.status).toBe(200);
		expect(mocks.canExecuteOrganizationAgents).not.toHaveBeenCalled();
	});

	it("leaves a personal key alone — it names no organization", async () => {
		mocks.verifyUserApiKey.mockResolvedValue({
			valid: true,
			keyId: "key-2",
			userId: "user-99",
			scopes: ["agents:execute"],
		});

		const res = await call(appRequiring("agents:execute"), PERSONAL_KEY);

		expect(res.status).toBe(200);
		expect(mocks.canExecuteOrganizationAgents).not.toHaveBeenCalled();
	});
});
