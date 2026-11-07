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
	organization: vi.fn(),
	snapshot: vi.fn(),
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
vi.mock("../../projects/lib/delivery-snapshot", () => ({
	getProjectDeliverySnapshot: m.snapshot,
}));

import { registerProjectDeliveryRoutes } from "../project-delivery";

const actor: ExternalApiContext = {
	keyType: "organization",
	keyId: "example-key",
	keyPrefix: "org_example",
	userId: "example-user",
	organizationId: "example-org",
	scopes: ["projects:read"],
};
function request(context = actor) {
	const app = new Hono<{ Variables: ExternalApiVariables }>();
	app.use("*", async (c, next) => {
		c.set("externalApiContext", context);
		await next();
	});
	registerProjectDeliveryRoutes(app);
	return app.request("/projects/example-project/delivery");
}
beforeEach(() => {
	vi.clearAllMocks();
	m.access.mockResolvedValue(true);
	m.permissions.mockResolvedValue({
		organizationId: "example-org",
		permissions: [Permissions.PROJECT_READ],
	});
	m.snapshot.mockResolvedValue({ version: 1, projectId: "example-project" });
});
describe("project delivery HTTP contract", () => {
	it("preserves unavailable evidence sections rather than converting them into empty permissionless lists", async () => {
		const sections = {
			decisions: { available: false, items: [] },
			documents: { available: false, items: [] },
		};
		m.snapshot.mockResolvedValue({ version: 1, ...sections });
		const response = await request();
		expect(await response.json()).toMatchObject({ data: sections });
	});
	it("forwards only current resolved actor and prevents caching", async () => {
		const response = await request();
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("private, no-store");
		expect(m.snapshot).toHaveBeenCalledWith(
			{ userId: "example-user", organizationId: "example-org" },
			{ projectId: "example-project" },
		);
	});
	it("distinguishes missing key scope from current permission revocation, wildcard included", async () => {
		expect((await request({ ...actor, scopes: [] })).status).toBe(403);
		expect(m.snapshot).not.toHaveBeenCalled();
		m.permissions.mockResolvedValue({
			organizationId: "example-org",
			permissions: [],
		});
		expect((await request({ ...actor, scopes: ["*"] })).status).toBe(403);
		expect(m.snapshot).not.toHaveBeenCalled();
	});
	it("refuses a project-bound credential naming another project and a hidden project", async () => {
		expect(
			(await request({ ...actor, boundProjectId: "other-project" }))
				.status,
		).toBe(404);
		m.access.mockResolvedValue(false);
		expect((await request()).status).toBe(404);
		expect(m.snapshot).not.toHaveBeenCalled();
	});
});
