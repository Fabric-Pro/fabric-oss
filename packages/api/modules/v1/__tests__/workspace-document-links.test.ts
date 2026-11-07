import { Permissions } from "@repo/permissions";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
	ExternalApiContext,
	ExternalApiVariables,
} from "../../external-api/types";
import { WorkspaceLinkError } from "../../projects/lib/workspace-document-links/contracts";

const m = vi.hoisted(() => ({
	list: vi.fn(),
	read: vi.fn(),
	add: vi.fn(),
	remove: vi.fn(),
	access: vi.fn(),
	permissions: vi.fn(),
	organization: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	db: { organization: { findFirst: m.organization } },
	hasProjectAccess: m.access,
	canExecuteOrganizationAgents: vi.fn(),
	canReadOrganizationReports: vi.fn(),
	canRunOrganizationWorkflows: vi.fn(),
}));
vi.mock("../../users/procedures/api-keys/verify", () => ({
	verifyUserApiKey: vi.fn(),
}));
vi.mock("../../../lib/effective-project-permissions", () => ({
	resolveEffectiveProjectPermissions: m.permissions,
}));
vi.mock("../../projects/lib/workspace-document-links", async () => ({
	...(await import("../../projects/lib/workspace-document-links/contracts")),
	workspaceDocumentLinkCommands: async () => m,
}));

import { registerWorkspaceDocumentLinkRoutes } from "../workspace-document-links";

const principal: ExternalApiContext = {
	keyType: "organization",
	keyId: "example-key",
	keyPrefix: "org_example",
	userId: "example-user",
	organizationId: "example-org",
	scopes: ["projects:read", "projects:write", "workspaces:read"],
};
const actor = {
	userId: principal.userId,
	organizationId: principal.organizationId,
	projectId: "example-project",
};
const root = "/projects/example-project/contexts/workspace-documents";
const source = {
	workspaceId: "example-workspace",
	documentId: "example-document",
	expectedRevision: "a".repeat(64),
};
function app(context = principal) {
	const app = new Hono<{ Variables: ExternalApiVariables }>();
	app.use("*", async (c, next) => {
		c.set("externalApiContext", context);
		await next();
	});
	registerWorkspaceDocumentLinkRoutes(app);
	return app;
}
const post = (body: unknown = source, context = principal) =>
	app(context).request(root, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
beforeEach(() => {
	vi.resetAllMocks();
	m.access.mockResolvedValue(true);
	m.permissions.mockResolvedValue({
		organizationId: principal.organizationId,
		permissions: [
			Permissions.CONTEXT_READ,
			Permissions.CONTEXT_CREATE,
			Permissions.CONTEXT_DELETE,
		],
		source: "project-member",
	});
	m.list.mockResolvedValue({ links: [], hasMore: false });
	m.add.mockResolvedValue({ linkId: "example-link", created: true });
	m.read.mockResolvedValue({ text: "🧵" });
	m.remove.mockResolvedValue({ removed: true });
});
describe("Workspace document-link REST boundaries", () => {
	it("uses the authenticated actor and reference-only input with no-store", async () => {
		const response = await post();
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("private, no-store");
		expect(m.add).toHaveBeenCalledWith(actor, source, "api_key");
	});
	it.each(["projects:write", "workspaces:read"])(
		"requires both mutation scopes, refusing when %s is missing",
		async (missing) => {
			const response = await post(source, {
				...principal,
				scopes: principal.scopes.filter((scope) => scope !== missing),
			});
			expect(response.status).toBe(403);
			expect(m.permissions).not.toHaveBeenCalled();
			expect(m.add).not.toHaveBeenCalled();
		},
	);
	it("does not let wildcard keys bypass current project roles", async () => {
		m.permissions.mockResolvedValue({
			organizationId: principal.organizationId,
			permissions: [Permissions.CONTEXT_READ],
			source: "project-member",
		});
		expect(
			(await post(source, { ...principal, scopes: ["*"] })).status,
		).toBe(403);
		expect(m.add).not.toHaveBeenCalled();
	});
	it("does not let an organization key cross tenant boundaries", async () => {
		m.permissions.mockResolvedValue({
			organizationId: "example-other-org",
			permissions: [Permissions.CONTEXT_READ],
			source: "project-member",
		});
		expect((await app().request(root)).status).toBe(404);
		expect(m.list).not.toHaveBeenCalled();
	});
	it("restricts bound credentials to their project even with wildcard scope", async () => {
		expect(
			(
				await app({
					...principal,
					scopes: ["*"],
					boundProjectId: "example-other-project",
				}).request(root)
			).status,
		).toBe(404);
		expect(m.list).not.toHaveBeenCalled();
	});
	it("allows only explicit linked reads in a matching project connection", async () => {
		const response = await app({
			...principal,
			boundProjectId: actor.projectId,
		}).request(
			root +
				"/example-link/content?offset=1&limit=20&expectedRevision=" +
				source.expectedRevision,
		);
		expect(response.status).toBe(200);
		expect(m.read).toHaveBeenCalledWith(actor, {
			linkId: "example-link",
			offset: 1,
			limit: 20,
			expectedRevision: source.expectedRevision,
		});
	});
	it("lets an editor remove an unavailable link without Workspace scope", async () => {
		const response = await app({
			...principal,
			scopes: ["projects:write"],
		}).request(`${root}/example-link`, { method: "DELETE" });
		expect(response.status).toBe(200);
		expect(m.remove).toHaveBeenCalledWith(
			actor,
			{ linkId: "example-link" },
			"api_key",
		);
	});
	it.each([
		{},
		{ ...source, expectedRevision: "old" },
		{ ...source, userId: "example-other-user" },
		{ ...source, extractedText: "example text" },
	])(
		"refuses invalid authority/content input before mutation",
		async (input) => {
			expect((await post(input)).status).toBe(400);
			expect(m.add).not.toHaveBeenCalled();
		},
	);
	it("rejects oversized bodies before resolving or copying source content", async () => {
		expect(
			(await post({ ...source, content: "x".repeat(5000) })).status,
		).toBe(413);
		expect(m.add).not.toHaveBeenCalled();
	});
	it.each(["-1", "1.5", "Infinity", "2147483647"])(
		"refuses invalid offset %s",
		async (offset) => {
			expect(
				(await app().request(`${root}?offset=${offset}`)).status,
			).toBe(400);
			expect(m.list).not.toHaveBeenCalled();
		},
	);
	it("preserves expected refusal and redacts unexpected backend failures", async () => {
		m.add.mockRejectedValueOnce(new WorkspaceLinkError("STALE_REVISION"));
		expect((await post()).status).toBe(409);
		m.add.mockRejectedValueOnce(new Error("example private storage path"));
		const failure = await post();
		expect(failure.status).toBe(503);
		expect(failure.headers.get("cache-control")).toBe("private, no-store");
		expect(await failure.text()).not.toContain("private storage");
	});
});
