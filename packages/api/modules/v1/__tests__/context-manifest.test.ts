import { Permissions } from "@repo/permissions";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
	ExternalApiContext,
	ExternalApiVariables,
} from "../../external-api/types";

const m = vi.hoisted(() => ({
	read: vi.fn(),
	access: vi.fn(),
	permissions: vi.fn(),
	organization: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	db: { organization: { findFirst: m.organization } },
	hasProjectAccess: m.access,
	canExecuteOrganizationAgents: vi.fn(),
	canRunOrganizationWorkflows: vi.fn(),
}));
vi.mock("../../users/procedures/api-keys/verify", () => ({
	verifyUserApiKey: vi.fn(),
}));
vi.mock("../../../lib/effective-project-permissions", () => ({
	resolveEffectiveProjectPermissions: m.permissions,
}));
vi.mock("../../projects/lib/context-manifest-reader", async (original) => ({
	...(await original<Record<string, unknown>>()),
	readContextManifest: m.read,
}));

import { registerContextManifestRoutes } from "../context-manifest";

const ctx: ExternalApiContext = {
	keyType: "organization",
	keyId: "example-key",
	keyPrefix: "org_example",
	userId: "example-user",
	organizationId: "example-org",
	scopes: ["projects:read"],
};
const path = "/projects/example-project/contexts/manifest";
function app(context = ctx) {
	const app = new Hono<{ Variables: ExternalApiVariables }>();
	app.use("*", async (c, next) => {
		c.set("externalApiContext", context);
		await next();
	});
	registerContextManifestRoutes(app);
	return app;
}
beforeEach(() => {
	vi.resetAllMocks();
	m.access.mockResolvedValue(true);
	m.permissions.mockResolvedValue({
		organizationId: ctx.organizationId,
		permissions: [Permissions.CONTEXT_READ],
		source: "project-member",
	});
	m.read.mockResolvedValue({
		version: 1,
		sources: [],
		omissions: { sourceBodies: true },
	});
});
describe("Context manifest REST transport", () => {
	it("uses the credential's current actor/host and returns metadata with no-store", async () => {
		const response = await app().request(
			`${path}?limit=10&offset=2&includeCodeContexts=true&type=TEXT&userId=ignored`,
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("private, no-store");
		expect(await response.json()).toMatchObject({
			data: { version: 1, omissions: { sourceBodies: true } },
		});
		expect(m.read).toHaveBeenCalledWith(
			{
				projectId: "example-project",
				organizationId: ctx.organizationId,
				userId: ctx.userId,
			},
			{ limit: 10, offset: 2, includeCodeContexts: true, type: "TEXT" },
		);
	});
	it("checks scope before role/read work", async () => {
		expect(
			(await app({ ...ctx, scopes: ["workspaces:read"] }).request(path))
				.status,
		).toBe(403);
		expect(m.permissions).not.toHaveBeenCalled();
		expect(m.read).not.toHaveBeenCalled();
	});
	it("checks current CONTEXT_READ even with a wildcard key", async () => {
		m.permissions.mockResolvedValue({
			organizationId: ctx.organizationId,
			permissions: [],
		});
		expect(
			(await app({ ...ctx, scopes: ["*"] }).request(path)).status,
		).toBe(403);
		expect(m.read).not.toHaveBeenCalled();
	});
	it.each([
		"?limit=51",
		"?limit=",
		"?offset=%20",
		"?offset=1e2",
		"?offset=-1",
		"?includeCodeContexts=1",
		"?type=INVALID",
	])("refuses malformed/unbounded filter %s", async (query) => {
		const response = await app().request(path + query);
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			error: { code: "INVALID_INPUT" },
		});
		expect(m.read).not.toHaveBeenCalled();
	});
	it("keeps organization-bound keys inside their host and project-bound credentials inside their project", async () => {
		expect(
			(await app({ ...ctx, organizationId: "other-org" }).request(path))
				.status,
		).toBe(404);
		expect(
			(
				await app({ ...ctx, boundProjectId: "other-project" }).request(
					path,
				)
			).status,
		).toBe(404);
		expect(m.read).not.toHaveBeenCalled();
	});
	it("allows a project guest's authoritative host without an organization-membership branch", async () => {
		const response = await app({
			...ctx,
			keyType: "personal",
			organizationId: undefined,
		}).request(path);
		expect(response.status).toBe(200);
		expect(m.read).toHaveBeenCalledWith(
			expect.objectContaining({ organizationId: "example-org" }),
			expect.anything(),
		);
	});
	it("sanitizes unexpected SQL/provider failures", async () => {
		m.read.mockRejectedValue(new Error("private-example-connection"));
		const response = await app().request(path);
		expect(response.status).toBe(500);
		expect(await response.text()).not.toContain("private-example");
	});
});
