import { Permissions } from "@repo/permissions";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	evaluateAgentResultSchema,
	inspectAgentResultSchema,
} from "../../context-quality/agent-run-contracts";
import { SavedEvaluationError } from "../../context-quality/saved-contracts";
import type {
	ExternalApiContext,
	ExternalApiVariables,
} from "../../external-api/types";

const m = vi.hoisted(() => ({
	inspect: vi.fn(),
	evaluate: vi.fn(),
	access: vi.fn(),
	permissions: vi.fn(),
	organization: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	db: { organization: { findFirst: m.organization } },
	hasProjectAccess: m.access,
	canCreateOrganizationPrompts: vi.fn(),
	canCreateProjectInOrganization: vi.fn(),
	canExecuteOrganizationAgents: vi.fn(),
	canRunOrganizationWorkflows: vi.fn(),
	canUpdateOrganizationPrompts: vi.fn(),
	canUseOrganizationAiChat: vi.fn(),
	canUseOrganizationIntegrations: vi.fn(),
}));
vi.mock("../../users/procedures/api-keys/verify", () => ({
	verifyUserApiKey: vi.fn(),
}));
vi.mock("../../../lib/effective-project-permissions", () => ({
	resolveEffectiveProjectPermissions: m.permissions,
}));
vi.mock("../../context-quality/lib/agent-result", () => ({
	agentResultCommands: async () => m,
}));

import { registerAgentResultQualityRoutes } from "../agent-result-quality";

const principal: ExternalApiContext = {
	keyType: "organization",
	keyId: "example-key",
	keyPrefix: "org_example",
	userId: "example-user",
	organizationId: "example-org",
	scopes: ["projects:read", "agents:read"],
};
const actor = {
	userId: principal.userId,
	organizationId: principal.organizationId,
	projectId: "example-project",
};
const path =
	"/projects/example-project/context-quality/agent-results/example-execution";
const input = {
	expectedRevision: "a".repeat(64),
	requiredPhrases: ["Example result"],
	forbiddenPhrases: [],
};
const output = {
	status: "passed",
	origin: { executionId: "example-execution", saved: false },
};
function app(context = principal) {
	const app = new Hono<{ Variables: ExternalApiVariables }>();
	app.use("*", async (c, next) => {
		c.set("externalApiContext", context);
		await next();
	});
	registerAgentResultQualityRoutes(app);
	return app;
}
const check = (body: unknown = input, context = principal) =>
	app(context).request(`${path}/evaluate`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
beforeEach(() => {
	vi.resetAllMocks();
	m.access.mockResolvedValue(true);
	m.permissions.mockResolvedValue({
		organizationId: principal.organizationId,
		permissions: [Permissions.CONTEXT_READ],
		source: "project-member",
	});
	// Shared commands own strict input validation. Keep that contract in this
	// transport mock rather than silently accepting fields production rejects.
	m.inspect.mockImplementation(async (_actor, raw) => {
		if (!inspectAgentResultSchema.safeParse(raw).success) {
			throw new SavedEvaluationError(
				"BAD_REQUEST",
				"Select a valid agent run.",
			);
		}
		return output;
	});
	m.evaluate.mockImplementation(async (_actor, raw) => {
		if (!evaluateAgentResultSchema.safeParse(raw).success) {
			throw new SavedEvaluationError(
				"BAD_REQUEST",
				"Use bounded run expectations.",
			);
		}
		return output;
	});
});
describe("actual agent-result Quality REST boundary", () => {
	it("accepts valid non-ASCII expectations within the declared per-phrase limits", async () => {
		const body = {
			...input,
			requiredPhrases: Array.from(
				{ length: 20 },
				(_, i) => `${i}${"例".repeat(500)}`,
			),
			forbiddenPhrases: Array.from(
				{ length: 20 },
				(_, i) => `${i}${"別".repeat(500)}`,
			),
		};
		expect(Buffer.byteLength(JSON.stringify(body))).toBeGreaterThan(
			32 * 1024,
		);
		expect((await check(body)).status).toBe(200);
	});
	it("loads only the path execution under the authenticated project owner actor", async () => {
		const response = await app().request(
			`${path}?projectId=example-other-project&userId=example-other-user`,
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("private, no-store");
		expect(m.inspect).toHaveBeenCalledExactlyOnceWith(actor, {
			executionId: "example-execution",
		});
	});
	it("sends expectations and the path identity to the same server command", async () => {
		const response = await check();
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ data: output });
		expect(m.evaluate).toHaveBeenCalledExactlyOnceWith(actor, {
			...input,
			executionId: "example-execution",
		});
	});
	it.each(["projects:read", "agents:read"])(
		"requires explicit %s before project resolution on both operations",
		async (missing) => {
			const context = {
				...principal,
				scopes: principal.scopes.filter((scope) => scope !== missing),
			};
			for (const response of [
				await app(context).request(path),
				await check(input, context),
			]) {
				expect(response.status).toBe(403);
				expect(response.headers.get("cache-control")).toBe(
					"private, no-store",
				);
			}
			expect(m.permissions).not.toHaveBeenCalled();
			expect(m.inspect).not.toHaveBeenCalled();
			expect(m.evaluate).not.toHaveBeenCalled();
		},
	);
	it("wildcard scope still uses the current command's owner permission", async () => {
		m.inspect.mockRejectedValueOnce(
			new SavedEvaluationError(
				"FORBIDDEN",
				"Current access to this agent result is required.",
			),
		);
		const response = await app({ ...principal, scopes: ["*"] }).request(
			path,
		);
		expect(response.status).toBe(403);
		expect(m.inspect).toHaveBeenCalledExactlyOnceWith(actor, {
			executionId: "example-execution",
		});
	});
	it("requires the creator's current project permission independently of wildcard scope", async () => {
		m.permissions.mockResolvedValue({
			organizationId: principal.organizationId,
			permissions: [],
			source: "project-member",
		});
		expect(
			(await app({ ...principal, scopes: ["*"] }).request(path)).status,
		).toBe(403);
		expect(m.inspect).not.toHaveBeenCalled();
	});
	it("refuses a foreign project for a project-bound credential", async () => {
		expect(
			(
				await app({
					...principal,
					boundProjectId: "example-other-project",
					scopes: ["*"],
				}).request(path)
			).status,
		).toBe(404);
		expect(m.inspect).not.toHaveBeenCalled();
	});
	it("retains matching project-bound access but still calls the current owner command", async () => {
		expect(
			(
				await app({
					...principal,
					boundProjectId: actor.projectId,
				}).request(path)
			).status,
		).toBe(200);
		expect(m.inspect).toHaveBeenCalledWith(actor, {
			executionId: "example-execution",
		});
	});
	it("refuses an organization key resolving a project in another tenant", async () => {
		m.permissions.mockResolvedValue({
			organizationId: "example-other-org",
			permissions: [Permissions.CONTEXT_READ],
			source: "project-member",
		});
		expect((await app().request(path)).status).toBe(404);
		expect(m.inspect).not.toHaveBeenCalled();
	});
	it("refuses a body execution identity instead of overriding the path", async () => {
		expect(
			(await check({ ...input, executionId: "example-other-execution" }))
				.status,
		).toBe(400);
		expect(m.evaluate).not.toHaveBeenCalled();
	});
	it.each([
		{ recordedAnswer: "Fabricated answer" },
		{ userId: "example-other-user" },
		{ organizationId: "example-other-org" },
		{ projectId: "example-other-project" },
		{ retrievedSourceIds: ["example-source"] },
	])(
		"uses the strict shared contract to reject client evidence or authority",
		async (extra) => {
			const response = await check({ ...input, ...extra });
			expect(response.status).toBe(400);
			expect(response.headers.get("cache-control")).toBe(
				"private, no-store",
			);
		},
	);
	it.each([null, [], "example text"])(
		"rejects non-object check input before invoking the command",
		async (body) => {
			expect((await check(body)).status).toBe(400);
			expect(m.evaluate).not.toHaveBeenCalled();
		},
	);
	it("rejects malformed JSON with a static body-free error", async () => {
		const response = await app().request(`${path}/evaluate`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: '{"example-private-input"',
		});
		expect(response.status).toBe(400);
		expect(await response.text()).not.toContain("example-private-input");
		expect(m.evaluate).not.toHaveBeenCalled();
	});
	it("rejects oversized bodies before reaching the run command", async () => {
		expect(
			(await check({ ...input, recordedAnswer: "x".repeat(129 * 1024) }))
				.status,
		).toBe(413);
		expect(m.evaluate).not.toHaveBeenCalled();
	});
	it("preserves safe stale/permission refusals and redacts unexpected backend errors", async () => {
		m.evaluate.mockRejectedValueOnce(
			new SavedEvaluationError(
				"CONFLICT",
				"The recorded result changed. Inspect again.",
			),
		);
		expect((await check()).status).toBe(409);
		m.evaluate.mockRejectedValueOnce(
			new Error("example private provider detail"),
		);
		const response = await check();
		expect(response.status).toBe(503);
		expect(response.headers.get("cache-control")).toBe("private, no-store");
		expect(await response.json()).toEqual({
			error: {
				code: "SERVICE_UNAVAILABLE",
				message: "The agent result could not be verified.",
			},
		});
	});
});
