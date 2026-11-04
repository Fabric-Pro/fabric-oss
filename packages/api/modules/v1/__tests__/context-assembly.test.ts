import { Permissions } from "@repo/permissions";
import { ContextAssemblyError } from "@repo/rag/lib/context-continuity/contracts";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
	ExternalApiContext,
	ExternalApiVariables,
} from "../../external-api/types";

const m = vi.hoisted(() => ({
	assemble: vi.fn(),
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
vi.mock("@repo/rag/lib/context-continuity", async (original) => ({
	...(await original<Record<string, unknown>>()),
	assembleSelectedContext: m.assemble,
}));

import { registerContextAssemblyRoutes } from "../context-assembly";

const ctx: ExternalApiContext = {
	keyType: "organization",
	keyId: "example-key",
	keyPrefix: "org_example",
	userId: "example-user",
	organizationId: "example-org",
	scopes: ["projects:read", "workspaces:read"],
};
const path = "/projects/example-project/contexts/assemble";
const ref = { sourceKind: "project_context", sourceId: "example-source" };
const workspace = {
	sourceKind: "workspace_document",
	workspaceId: "example-workspace",
	documentId: "example-document",
	required: false,
};
function app(context = ctx) {
	const app = new Hono<{ Variables: ExternalApiVariables }>();
	app.use("*", async (c, next) => {
		c.set("externalApiContext", context);
		await next();
	});
	registerContextAssemblyRoutes(app);
	return app;
}
const request = (
	body: unknown = { selections: [ref] },
	context = ctx,
	query = "",
) =>
	app(context).request(path + query, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
beforeEach(() => {
	vi.resetAllMocks();
	m.access.mockResolvedValue(true);
	m.permissions.mockResolvedValue({
		organizationId: ctx.organizationId,
		permissions: [Permissions.CONTEXT_READ],
		source: "project-member",
	});
	m.assemble.mockResolvedValue({
		version: 1,
		currentRead: true,
		snapshotConsistent: false,
		sources: [],
	});
});
describe("REST context assembly transport", () => {
	it("passes only authenticated actor/host and strict source refs with no-store", async () => {
		const response = await request();
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("private, no-store");
		expect(await response.json()).toMatchObject({ data: { version: 1 } });
		expect(m.assemble).toHaveBeenCalledWith(
			{
				projectId: "example-project",
				organizationId: ctx.organizationId,
				userId: ctx.userId,
			},
			{ selections: [{ ...ref, required: true }] },
		);
	});
	it("checks projects scope before resolving or reading sources", async () => {
		const response = await request(
			{ selections: [ref] },
			{ ...ctx, scopes: ["workspaces:read"] },
		);
		expect(response.status).toBe(403);
		expect(await response.text()).toContain(
			"Missing required scope: projects:read",
		);
		expect(m.permissions).not.toHaveBeenCalled();
		expect(m.assemble).not.toHaveBeenCalled();
	});
	it("requires Workspace scope even for optional unavailable references", async () => {
		const response = await request(
			{ selections: [workspace] },
			{ ...ctx, scopes: ["projects:read"] },
		);
		expect(response.status).toBe(403);
		expect(await response.text()).toContain(
			"Missing required scope: workspaces:read",
		);
		expect(m.permissions).not.toHaveBeenCalled();
		expect(m.assemble).not.toHaveBeenCalled();
	});
	it("does not let wildcard project-bound credentials reach Workspace selections", async () => {
		const response = await request(
			{ selections: [workspace] },
			{ ...ctx, scopes: ["*"], boundProjectId: "example-project" },
		);
		expect(response.status).toBe(403);
		expect(await response.text()).toContain("Project-scoped credentials");
		expect(m.assemble).not.toHaveBeenCalled();
	});
	it("keeps project-only assembly available to matching project-bound credentials", async () => {
		expect(
			(
				await request(
					{ selections: [ref] },
					{ ...ctx, boundProjectId: "example-project" },
				)
			).status,
		).toBe(200);
	});
	it("rechecks creator current project role even for wildcard keys", async () => {
		m.permissions.mockResolvedValue({
			organizationId: ctx.organizationId,
			permissions: [],
		});
		expect(
			(await request({ selections: [ref] }, { ...ctx, scopes: ["*"] }))
				.status,
		).toBe(403);
		expect(m.assemble).not.toHaveBeenCalled();
	});
	it.each([
		{ organizationId: "another-org" },
		{ boundProjectId: "another-project" },
	])("denies foreign credential context %j", async (patch) => {
		expect(
			(await request({ selections: [ref] }, { ...ctx, ...patch })).status,
		).toBe(404);
		expect(m.assemble).not.toHaveBeenCalled();
	});
	it("honors the core current Workspace role denial after scopes pass", async () => {
		m.assemble.mockRejectedValue(new ContextAssemblyError("FORBIDDEN"));
		const response = await request({ selections: [workspace] });
		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({
			error: { code: "FORBIDDEN" },
		});
	});
	it.each([
		{ selections: [] },
		{ selections: [ref, ref] },
		{ selections: [{ ...ref, expectedRevision: "bad" }] },
		{ selections: [{ ...workspace, offset: 3 }] },
		{ selections: [ref], organizationId: "another-org" },
	])(
		"rejects malformed selection without resolving sources: %j",
		async (body) => {
			expect((await request(body)).status).toBe(400);
			expect(m.assemble).not.toHaveBeenCalled();
		},
	);
	it("rejects malformed JSON and body sizes over16KiB before source reads", async () => {
		for (const body of ["{", " ".repeat(16385)]) {
			const response = await app().request(path, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body,
			});
			expect(response.status).toBe(body === "{" ? 400 : 413);
		}
		expect(m.assemble).not.toHaveBeenCalled();
	});
	it.each([
		["STALE_REVISION", 409],
		["NOT_FOUND", 404],
		["NOT_READY", 409],
		["TOO_LARGE", 413],
	] as const)("maps required source %s safely", async (reason, status) => {
		m.assemble.mockRejectedValue(new ContextAssemblyError(reason));
		const response = await request();
		expect(response.status).toBe(status);
		expect(await response.json()).toMatchObject({
			error: { code: reason },
		});
	});
	it("sanitizes unexpected resolver and reader errors to503", async () => {
		for (const failing of [m.permissions, m.assemble]) {
			m.permissions.mockResolvedValue({
				organizationId: ctx.organizationId,
				permissions: [Permissions.CONTEXT_READ],
			});
			failing.mockRejectedValue(
				new Error("private storage credential example-secret"),
			);
			const response = await request();
			expect(response.status).toBe(503);
			expect(await response.text()).not.toContain("example-secret");
		}
	});
});
