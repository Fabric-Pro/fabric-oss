import { Permissions } from "@repo/permissions";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
	ExternalApiContext,
	ExternalApiVariables,
} from "../../external-api/types";

const m = vi.hoisted(() => ({
	visible: vi.fn(),
	access: vi.fn(),
	organization: vi.fn(),
	deleted: vi.fn(),
	project: vi.fn(),
	rows: vi.fn(),
	one: vi.fn(),
	member: vi.fn(),
	verifyOAuth: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	OAUTH_ACCESS_TOKEN_PREFIX: "fat_",
	hasProjectAccess: m.visible,
	isProjectSoftDeleted: m.deleted,
	canExecuteOrganizationAgents: vi.fn(),
	canReadOrganizationReports: vi.fn(),
	canRunOrganizationWorkflows: vi.fn(),
	verifyOAuthAccessToken: m.verifyOAuth,
	db: {
		organization: { findFirst: m.organization },
		project: { findFirst: m.project },
		userStory: { findMany: m.rows, findFirst: m.one },
		member: { findUnique: m.member },
	},
}));
vi.mock("../../users/procedures/api-keys/verify", () => ({
	verifyUserApiKey: vi.fn(),
}));
vi.mock("../../../lib/effective-project-permissions", () => ({
	resolveEffectiveProjectPermissions: m.access,
}));

import { requireApiKey } from "../../external-api/middleware/api-key-auth";
import { isDeliverySignalReadPath } from "../../external-api/project-bound";
import { registerDeliverySignalRoutes } from "../delivery-signals";

const actor: ExternalApiContext = {
	keyType: "organization",
	keyId: "example-key",
	keyPrefix: "org_example",
	userId: "example-user",
	organizationId: "example-org",
	scopes: ["projects:read", "features:read"],
};
function request(path = "signals", credential = actor) {
	const app = new Hono<{ Variables: ExternalApiVariables }>();
	app.use("*", async (c, next) => {
		c.set("externalApiContext", credential);
		await next();
	});
	registerDeliverySignalRoutes(app);
	return app.request(`/projects/example-project/delivery/${path}`);
}
const row = {
	id: "example-item",
	identifier: "US-1",
	title: "Saved source work",
	source: "SLACK",
	reporterSource: null,
	draftingStage: "DRAFT",
	createdAt: new Date("2026-11-01T00:00:00Z"),
	sourceMetadata: { secret: "not-public" },
	description: "private-source",
};
beforeEach(() => {
	vi.clearAllMocks();
	m.visible.mockResolvedValue(true);
	m.deleted.mockResolvedValue(false);
	m.access.mockResolvedValue({
		source: "project-member",
		organizationId: "example-org",
		organizationDeleted: false,
		permissions: [Permissions.PROJECT_READ, Permissions.STORY_READ],
	});
	m.project.mockResolvedValue({ organization: { slug: "example-team" } });
	m.rows.mockResolvedValue([row]);
	m.one.mockResolvedValue(row);
	m.member.mockResolvedValue(null);
	m.organization.mockResolvedValue({ id: "example-org" });
});

describe("delivery history through the real credential middleware", () => {
	function authenticated(scopes: string[], projectId = "example-project") {
		m.verifyOAuth.mockResolvedValue({
			valid: true,
			tokenId: "example-token",
			clientRowId: "example-client",
			userId: "example-user",
			organizationId: "example-org",
			projectId,
			audience: "api",
			scopes,
		});
		const app = new Hono<{ Variables: ExternalApiVariables }>().basePath(
			"/api/v1",
		);
		app.use("*", requireApiKey());
		registerDeliverySignalRoutes(app);
		return app.request(
			"/api/v1/projects/example-project/delivery/signals",
			{
				headers: { Authorization: "Bearer fat_example-test-token" },
			},
		);
	}
	it("reports missing exact scopes before a project-binding refusal", async () => {
		const response = await authenticated(
			["projects:read"],
			"example-other-project",
		);
		expect(response.status).toBe(403);
		expect((await response.json()).error.code).toBe("INSUFFICIENT_SCOPE");
		expect(m.access).not.toHaveBeenCalled();
		expect(m.rows).not.toHaveBeenCalled();
	});
	it("keeps another project opaque after sufficient scopes", async () => {
		const response = await authenticated(
			["projects:read", "features:read"],
			"example-other-project",
		);
		expect(response.status).toBe(404);
		expect((await response.json()).error.code).toBe("NOT_FOUND");
		expect(m.rows).not.toHaveBeenCalled();
	});
	it("retains the issued project and live authorization through the full read route", async () => {
		const response = await authenticated([
			"projects:read",
			"features:read",
		]);
		expect(response.status).toBe(200);
		expect((await response.json()).data.items).toHaveLength(1);
		expect(m.visible).toHaveBeenCalledWith(
			"example-project",
			"example-user",
		);
		expect(m.access).toHaveBeenCalledWith(
			"example-project",
			"example-user",
		);
	});
});
describe("delivery history HTTP", () => {
	it("distinguishes a missing workspace address from a missing or inaccessible project", async () => {
		m.project.mockResolvedValue({ organization: { slug: null } });
		const response = await request();
		expect(response.status).toBe(409);
		expect((await response.json()).error.code).toBe(
			"ORGANIZATION_ROUTE_UNAVAILABLE",
		);
		m.visible.mockResolvedValue(false);
		expect((await request()).status).toBe(404);
	});
	it("checks the selected org only inside the authorized project organization", async () => {
		const response = await request("signals?org=example-team");
		expect(response.status).toBe(200);
		expect(m.organization).toHaveBeenCalledWith({
			where: { id: "example-org", slug: "example-team" },
			select: { id: true },
		});
		m.organization.mockResolvedValue(null);
		expect((await request("signals?org=example-other-team")).status).toBe(
			404,
		);
	});
	it("keeps legacy null-organization and invisible projects opaque before any legacy refusal", async () => {
		m.access.mockResolvedValue({
			source: "owner",
			organizationId: null,
			organizationDeleted: false,
			permissions: [Permissions.PROJECT_READ, Permissions.STORY_READ],
		});
		for (const visible of [true, false]) {
			m.visible.mockResolvedValue(visible);
			const response = await request();
			expect(response.status).toBe(404);
			expect((await response.json()).error.code).toBe("NOT_FOUND");
		}
		expect(m.rows).not.toHaveBeenCalled();
	});
	it("returns the same canonical minimized metadata and forbids response caching", async () => {
		const response = await request();
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("private, no-store");
		const body = await response.json();
		expect(body.data.items[0]).toMatchObject({
			id: row.id,
			source: "SLACK",
			kind: "PROJECT_WORK_ITEM",
		});
		expect(JSON.stringify(body)).not.toMatch(
			/secret|not-public|private-source|sourceMetadata/,
		);
		const detail = await request(`signals/${row.id}`);
		expect(detail.status).toBe(200);
		expect((await detail.json()).data).toEqual(body.data.items[0]);
	});
	it.each([["projects:read"], ["features:read"], ["mcp:read"], []])(
		"requires exact read scope pairs before any project read",
		async (...scopes) => {
			const response = await request("signals", {
				...actor,
				scopes: scopes as string[],
			});
			expect(response.status).toBe(403);
			expect((await response.json()).error.code).toBe(
				"INSUFFICIENT_SCOPE",
			);
			expect(m.access).not.toHaveBeenCalled();
		},
	);
	it("checks scopes before an opaque project binding refusal", async () => {
		const bound = { ...actor, boundProjectId: "other-project" };
		expect(
			(await request("signals", { ...bound, scopes: [] })).status,
		).toBe(403);
		const response = await request("signals", bound);
		expect(response.status).toBe(404);
		expect((await response.json()).error).toEqual({
			code: "NOT_FOUND",
			message: "Project not found",
		});
		expect(m.access).not.toHaveBeenCalled();
	});
	it("keeps wildcard scope separate from current actor permission", async () => {
		m.access.mockResolvedValue({
			organizationId: "example-org",
			permissions: [],
		});
		const response = await request("signals", { ...actor, scopes: ["*"] });
		expect(response.status).toBe(403);
		expect((await response.json()).error.code).toBe(
			"INSUFFICIENT_PERMISSION",
		);
		expect(m.rows).not.toHaveBeenCalled();
	});
	it("keeps history available to a project guest while denying organization setup", async () => {
		const guest = {
			...actor,
			keyType: "personal" as const,
			organizationId: undefined,
			scopes: ["*"],
		};
		expect((await request("signals", guest)).status).toBe(200);
		const sources = await request("sources", guest);
		expect(sources.status).toBe(403);
		expect((await sources.json()).error.code).toBe(
			"INSUFFICIENT_PERMISSION",
		);
	});
	it("rejects retired personal parameters, injected actors and unknown filters without echoing values", async () => {
		for (const suffix of [
			"?personal=1",
			"?userId=private-value",
			"?source=UNKNOWN",
			"?limit=NaN",
			"?limit=51",
		]) {
			const response = await request(`signals${suffix}`);
			expect(response.status).toBe(400);
			expect(JSON.stringify(await response.json())).not.toContain(
				"private-value",
			);
		}
	});
	it("returns one generic cursor refusal and preserves organization restoration causes", async () => {
		const response = await request("signals?cursor=%21bad");
		expect(response.status).toBe(400);
		expect((await response.json()).error).toEqual({
			code: "BAD_REQUEST",
			message: "Invalid cursor. Reload project history.",
		});
		m.access.mockResolvedValue({
			organizationId: "example-org",
			organizationDeleted: true,
			permissions: [Permissions.PROJECT_READ, Permissions.STORY_READ],
		});
		const deleted = await request();
		expect(deleted.status).toBe(403);
		expect((await deleted.json()).error.code).toBe("ORGANIZATION_DELETED");
	});
	it("classifies only the implemented read paths for scope-first binding checks", () => {
		for (const suffix of ["signals", "signals/example-item", "sources"]) {
			expect(
				isDeliverySignalReadPath(
					`/api/v1/projects/example-project/delivery/${suffix}`,
					"GET",
				),
			).toBe(true);
		}
		for (const suffix of [
			"signals/example-item/mutate",
			"sources/private",
			"unknown",
		]) {
			expect(
				isDeliverySignalReadPath(
					`/api/v1/projects/example-project/delivery/${suffix}`,
					"GET",
				),
			).toBe(false);
		}
		expect(
			isDeliverySignalReadPath(
				"/api/v1/projects/example-project/delivery/signals",
				"POST",
			),
		).toBe(false);
	});
});
