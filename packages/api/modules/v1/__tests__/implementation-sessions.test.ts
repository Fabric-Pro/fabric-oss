import { ORPCError } from "@orpc/client";
import { Permissions } from "@repo/permissions";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
	ExternalApiContext,
	ExternalApiVariables,
} from "../../external-api/types";

const m = vi.hoisted(() => ({
	access: vi.fn(),
	permissions: vi.fn(),
	execute: vi.fn(),
	audit: vi.fn(),
	list: vi.fn(),
	get: vi.fn(),
	start: vi.fn(),
	cancel: vi.fn(),
	followup: vi.fn(),
	messages: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	db: { organization: { findFirst: vi.fn() } },
	hasProjectAccess: m.access,
	canExecuteOrganizationAgents: m.execute,
	canReadOrganizationReports: vi.fn(),
	canRunOrganizationWorkflows: vi.fn(),
}));
vi.mock("../../users/procedures/api-keys/verify", () => ({
	verifyUserApiKey: vi.fn(),
}));
vi.mock("../../../lib/effective-project-permissions", () => ({
	resolveEffectiveProjectPermissions: m.permissions,
}));
vi.mock("../../../lib/audit", () => ({ recordAuditFromRequest: m.audit }));
vi.mock("../../coding-runs/lib/implementation-commands", () => ({
	listImplementationSessions: m.list,
	getImplementationSession: m.get,
	startImplementationSession: m.start,
	cancelImplementationSession: m.cancel,
	followUpImplementationSession: m.followup,
	getImplementationMessages: m.messages,
}));

import { registerImplementationSessionRoutes } from "../implementation-sessions";

const actor: ExternalApiContext = {
	keyType: "organization",
	keyId: "example-key",
	keyPrefix: "org_example",
	userId: "example-user",
	organizationId: "example-org",
	scopes: ["agents:read", "agents:execute"],
};
function request(path = "", method = "GET", body?: string, context = actor) {
	const app = new Hono<{ Variables: ExternalApiVariables }>();
	app.use("*", async (c, next) => {
		c.set("externalApiContext", context);
		await next();
	});
	registerImplementationSessionRoutes(app);
	return app.request(
		`/projects/example-project/implementation-sessions${path}`,
		{
			method,
			...(body
				? { body, headers: { "content-type": "application/json" } }
				: {}),
		},
	);
}
beforeEach(() => {
	vi.clearAllMocks();
	m.access.mockResolvedValue(true);
	m.permissions.mockResolvedValue({
		organizationId: "example-org",
		permissions: [
			Permissions.AGENT_READ,
			Permissions.AGENT_EXECUTE,
			Permissions.AGENT_DELETE,
		],
	});
	m.execute.mockResolvedValue(true);
	for (const fn of [
		m.list,
		m.get,
		m.start,
		m.cancel,
		m.followup,
		m.messages,
	]) {
		fn.mockResolvedValue({ status: "example-result" });
	}
});
describe("implementation-session HTTP boundary", () => {
	it.each([
		["", "GET", undefined, "list"],
		["/example-run", "GET", undefined, "get"],
		["/example-run/messages", "GET", undefined, "messages"],
		[
			"",
			"POST",
			'{"requestId":"00000000-0000-4000-8000-000000000001","storyId":"example-story","projectId":"other-project"}',
			"start",
		],
		["/example-run/cancel", "POST", undefined, "cancel"],
		[
			"/example-run/follow-up",
			"POST",
			'{"promptId":"00000000-0000-4000-8000-000000000002","message":"Continue"}',
			"followup",
		],
	] as const)(
		"routes %s %s through current project authority",
		async (path, method, body, name) => {
			const response = await request(path, method, body);
			expect(response.status).toBe(200);
			expect(response.headers.get("cache-control")).toBe(
				"private, no-store",
			);
			expect(m[name].mock.calls[0][0]).toEqual({
				userId: "example-user",
				organizationId: "example-org",
			});
			expect(m[name].mock.calls[0][1]).toMatchObject({
				projectId: "example-project",
			});
		},
	);
	it("requires declared scope and current project permission for wildcard after demotion", async () => {
		expect(
			(await request("", "POST", "{}", { ...actor, scopes: [] })).status,
		).toBe(403);
		expect(m.start).not.toHaveBeenCalled();
		m.permissions.mockResolvedValue({
			organizationId: "example-org",
			permissions: [],
		});
		expect(
			(
				await request("/example-run/cancel", "POST", undefined, {
					...actor,
					scopes: ["*"],
				})
			).status,
		).toBe(403);
		expect(
			(await request("", "POST", "{}", { ...actor, scopes: ["*"] }))
				.status,
		).toBe(403);
		expect(m.start).not.toHaveBeenCalled();
	});
	it("uses current explicit project execution grants even when the org-wide execution role is absent", async () => {
		m.execute.mockResolvedValue(false);
		expect((await request("", "POST", "{}")).status).toBe(200);
		expect(m.start).toHaveBeenCalledOnce();
		expect(m.execute).not.toHaveBeenCalled();
	});
	it("refuses hidden projects and project-bound credential escapes", async () => {
		expect(
			(
				await request("", "GET", undefined, {
					...actor,
					boundProjectId: "other-project",
				})
			).status,
		).toBe(404);
		m.access.mockResolvedValue(false);
		expect((await request()).status).toBe(404);
		expect(m.list).not.toHaveBeenCalled();
	});
	it("bounds requests and refuses invalid JSON before dispatch", async () => {
		expect((await request("", "POST", "invalid")).status).toBe(400);
		expect(
			(
				await request(
					"",
					"POST",
					JSON.stringify({ message: "x".repeat(17000) }),
				)
			).status,
		).toBe(413);
		expect(m.start).not.toHaveBeenCalled();
	});
	it("does not expose private provider failure details", async () => {
		m.start.mockRejectedValue(
			new ORPCError("INTERNAL_SERVER_ERROR", {
				message: "private runtime location",
			}),
		);
		const response = await request("", "POST", "{}");
		expect(response.status).toBe(503);
		expect(await response.text()).not.toContain("private runtime");
	});
});
