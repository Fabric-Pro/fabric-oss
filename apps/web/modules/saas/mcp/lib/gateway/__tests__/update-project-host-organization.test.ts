/**
 * `fabric_update_project` writes under the organization that hosts the
 * project.
 *
 * The write-permission tests mock `updateProject` wholesale, so they never ran
 * its tenant filter. Here the real `updateProject` runs; only the Prisma
 * client under it is replaced, by a single-table fake whose `update` honours
 * the `where` clause the way Postgres would: no row matching every condition,
 * no write (Prisma's P2025). A filter on the wrong organization therefore
 * fails here as it fails in production.
 *
 * Run with: pnpm --filter web test modules/saas/mcp/lib/gateway/__tests__/update-project-host-organization
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type ProjectRow = {
	id: string;
	organizationId: string | null;
	name: string;
	description: string | null;
	status: string;
};

const store = vi.hoisted(() => ({
	rows: new Map<string, ProjectRow>(),
	updateCalls: [] as Array<{ where: Record<string, unknown> }>,
}));

const mocks = vi.hoisted(() => ({
	resolveProjectAccess: vi.fn(),
	hasPermission: vi.fn(),
	isProjectSoftDeleted: vi.fn(),
	isOrganizationLive: vi.fn(),
	recordAuditFromRequest: vi.fn(),
}));

vi.mock("@repo/database/prisma/client", () => ({
	db: {
		project: {
			update: vi.fn(
				async ({
					where,
					data,
				}: {
					where: Record<string, unknown>;
					data: Partial<ProjectRow>;
				}) => {
					store.updateCalls.push({ where });
					const row = store.rows.get(where.id as string);
					const matches =
						row !== undefined &&
						Object.entries(where).every(
							([key, value]) =>
								row[key as keyof ProjectRow] === value,
						);
					if (!row || !matches) {
						throw Object.assign(
							new Error(
								"An operation failed because it depends on one or more records that were required but not found.",
							),
							{ code: "P2025" },
						);
					}
					const updated = { ...row, ...data };
					store.rows.set(row.id, updated);
					return updated;
				},
			),
		},
	},
	Prisma: {
		JsonNull: Symbol("JsonNull"),
		DbNull: Symbol("DbNull"),
		AnyNull: Symbol("AnyNull"),
	},
	ProjectMemberRole: { OWNER: "OWNER" },
}));

vi.mock("@repo/api/modules/v1/instruction-direct-repository", () => ({
	getDirectRepositoryState: vi
		.fn()
		.mockResolvedValue({ availability: "UPLOAD", readState: "DIRECT" }),
}));

vi.mock("@repo/database", async () => ({
	isProjectSoftDeleted: mocks.isProjectSoftDeleted,
	isOrganizationLive: mocks.isOrganizationLive,
	resolveProjectAccess: mocks.resolveProjectAccess,
	hasPermission: mocks.hasPermission,
	Permissions: { PROJECT_UPDATE: "project:update" },
	updateProject: (
		await vi.importActual<
			typeof import("@repo/database/prisma/queries/projects/projects")
		>("@repo/database/prisma/queries/projects/projects")
	).updateProject,
}));

vi.mock("@repo/api/lib/audit", () => ({
	recordAuditFromRequest: mocks.recordAuditFromRequest,
}));

import { INPUT_BOUNDS } from "@repo/api/lib/zod-bounds";
import {
	executePlatformTool,
	PLATFORM_TOOL_DEFINITIONS,
} from "../platform-tools";
import type { GatewaySession } from "../types";

const personalKeyInA: GatewaySession = {
	sessionId: "sess-1",
	userId: "user-1",
	organizationId: "org-a",
	userName: "Example Agent",
	email: "agent@example.com",
	role: "user",
	credential: "personal-key",
	scopes: ["*"],
	createdAt: new Date("2026-01-01T00:00:00Z"),
	expiresAt: new Date("2026-01-02T00:00:00Z"),
};

const orgKeyInA: GatewaySession = {
	...personalKeyInA,
	credential: "organization-key",
};

function seedProject(organizationId: string | null) {
	store.rows.set("proj-1", {
		id: "proj-1",
		organizationId,
		name: "Example Project",
		description: "Old description",
		status: "ACTIVE",
	});
}

function accessIn(
	organizationId: string | null,
	permissions = ["project:update"],
) {
	mocks.resolveProjectAccess.mockResolvedValue({
		organizationId,
		source: "project-member",
		isVisible: true,
		permissions,
	});
}

function text(result: { content: Array<{ text: string }> }) {
	return result.content[0].text;
}

beforeEach(() => {
	vi.clearAllMocks();
	store.rows.clear();
	store.updateCalls.length = 0;
	mocks.isProjectSoftDeleted.mockResolvedValue(false);
	mocks.isOrganizationLive.mockResolvedValue(true);
	mocks.hasPermission.mockImplementation(
		(permissions: string[], required: string) =>
			permissions.includes(required),
	);
});

describe("fabric_update_project on an organization-hosted project", () => {
	it("changes the description for a member using an org key of the hosting organization", async () => {
		seedProject("org-a");
		accessIn("org-a");

		const result = await executePlatformTool(
			"fabric_update_project",
			{ projectId: "proj-1", description: "New description" },
			orgKeyInA,
		);

		expect(result.isError).toBeUndefined();
		expect(store.rows.get("proj-1")?.description).toBe("New description");
	});

	it("writes under the hosting organization for a guest whose session sits in another one", async () => {
		seedProject("org-b");
		accessIn("org-b");

		const result = await executePlatformTool(
			"fabric_update_project",
			{ projectId: "proj-1", description: "New description" },
			personalKeyInA,
		);

		expect(result.isError).toBeUndefined();
		expect(store.updateCalls[0]?.where).toMatchObject({
			id: "proj-1",
			organizationId: "org-b",
		});
		expect(store.rows.get("proj-1")?.description).toBe("New description");
	});

	it("keeps the explicit refusal for a caller who may see the project but not edit it", async () => {
		seedProject("org-a");
		accessIn("org-a", []);

		const result = await executePlatformTool(
			"fabric_update_project",
			{ projectId: "proj-1", description: "New description" },
			orgKeyInA,
		);

		expect(text(result)).toContain("No edit permission for this project");
		expect(store.updateCalls).toHaveLength(0);
		expect(store.rows.get("proj-1")?.description).toBe("Old description");
	});
});

describe("fabric_update_project refusals the app also makes", () => {
	// The app's update refuses a project with no organization
	// (`requireProjectOrganization`); the null arm is fail-closed, not a
	// second tenant.
	it("refuses a project with no hosting organization as not found, without a write", async () => {
		seedProject(null);
		accessIn(null);

		const result = await executePlatformTool(
			"fabric_update_project",
			{ projectId: "proj-1", description: "New description" },
			personalKeyInA,
		);

		expect(text(result)).toContain("Project not found or access denied");
		expect(store.updateCalls).toHaveLength(0);
		expect(mocks.recordAuditFromRequest).not.toHaveBeenCalled();
	});

	it.each([
		[
			"a description over the app's bound",
			{ description: "x".repeat(INPUT_BOUNDS.description + 1) },
			/description must be/,
		],
		["a 256-character name", { name: "x".repeat(256) }, /name must be/],
		["an empty name", { name: "" }, /name must be/],
		["a blank name", { name: "   " }, /name must be/],
		["a non-string name", { name: 42 }, /name must be/],
		["a null name", { name: null }, /name must be/],
		[
			"a non-string description",
			{ description: 42 },
			/description must be/,
		],
		["a null description", { description: null }, /description must be/],
	])("refuses %s, without a write", async (_label, input, message) => {
		seedProject("org-a");
		accessIn("org-a");

		const result = await executePlatformTool(
			"fabric_update_project",
			{ projectId: "proj-1", ...input },
			orgKeyInA,
		);

		expect(result.isError).toBe(true);
		expect(text(result)).toMatch(message);
		expect(store.updateCalls).toHaveLength(0);
		expect(store.rows.get("proj-1")?.description).toBe("Old description");
	});

	it("accepts a name exactly at the app's bound, stored as sent", async () => {
		seedProject("org-a");
		accessIn("org-a");
		const atBound = ` ${"x".repeat(254)}`;

		const result = await executePlatformTool(
			"fabric_update_project",
			{ projectId: "proj-1", name: atBound },
			orgKeyInA,
		);

		expect(result.isError).toBeUndefined();
		expect(store.rows.get("proj-1")?.name).toBe(atBound);
	});

	it("refuses a project in the trash as not found, without a write or an audit row", async () => {
		seedProject("org-a");
		accessIn("org-a");
		mocks.isProjectSoftDeleted.mockResolvedValue(true);

		const result = await executePlatformTool(
			"fabric_update_project",
			{ projectId: "proj-1", description: "New description" },
			orgKeyInA,
		);

		expect(text(result)).toContain("Project not found or access denied");
		expect(store.updateCalls).toHaveLength(0);
		expect(mocks.recordAuditFromRequest).not.toHaveBeenCalled();
	});

	it("accepts a description exactly at the app's bound", async () => {
		seedProject("org-a");
		accessIn("org-a");
		const atBound = "x".repeat(INPUT_BOUNDS.description);

		const result = await executePlatformTool(
			"fabric_update_project",
			{ projectId: "proj-1", description: atBound },
			orgKeyInA,
		);

		expect(result.isError).toBeUndefined();
		expect(store.rows.get("proj-1")?.description).toBe(atBound);
	});
});

describe("fabric_update_project status input", () => {
	it("no longer advertises status, and still requires projectId", () => {
		const definition = PLATFORM_TOOL_DEFINITIONS.find(
			(tool) => tool.name === "fabric_update_project",
		);

		expect(definition?.inputSchema.properties).not.toHaveProperty("status");
		expect(definition?.inputSchema.required).toEqual(["projectId"]);
	});

	it.each([
		["alone", { status: "ARCHIVED" }],
		["with a description", { status: "ARCHIVED", description: "New" }],
	])(
		"refuses status from a stale client %s, without a write",
		async (_label, input) => {
			seedProject("org-a");
			accessIn("org-a");

			const result = await executePlatformTool(
				"fabric_update_project",
				{ projectId: "proj-1", ...input },
				orgKeyInA,
			);

			expect(result.isError).toBe(true);
			expect(text(result)).toMatch(/does not change a project's status/);
			expect(store.updateCalls).toHaveLength(0);
			expect(mocks.recordAuditFromRequest).not.toHaveBeenCalled();
		},
	);
});

describe("fabric_update_project audit", () => {
	it("records project.updated under the hosting organization, naming only the changed fields", async () => {
		seedProject("org-a");
		accessIn("org-a");

		await executePlatformTool(
			"fabric_update_project",
			{ projectId: "proj-1", description: "New description" },
			orgKeyInA,
		);

		expect(mocks.recordAuditFromRequest).toHaveBeenCalledTimes(1);
		const [, event] = mocks.recordAuditFromRequest.mock.calls[0];
		expect(event).toMatchObject({
			action: "project.updated",
			category: "project",
			organizationId: "org-a",
			projectId: "proj-1",
			resource: {
				type: "project",
				id: "proj-1",
				name: "Example Project",
			},
			metadata: { changedFields: ["description"], via: "mcp-gateway" },
		});
		expect(JSON.stringify(event)).not.toContain("New description");
	});

	it("names both fields when the name changes too", async () => {
		seedProject("org-a");
		accessIn("org-a");

		await executePlatformTool(
			"fabric_update_project",
			{
				projectId: "proj-1",
				name: "Renamed Project",
				description: "New description",
			},
			orgKeyInA,
		);

		const [, event] = mocks.recordAuditFromRequest.mock.calls[0];
		expect(event.metadata.changedFields).toEqual(["name", "description"]);
		expect(event.resource.name).toBe("Renamed Project");
	});

	it("records the guest's update under the hosting organization, not the session's", async () => {
		seedProject("org-b");
		accessIn("org-b");

		await executePlatformTool(
			"fabric_update_project",
			{ projectId: "proj-1", description: "New description" },
			personalKeyInA,
		);

		const [, event] = mocks.recordAuditFromRequest.mock.calls[0];
		expect(event.organizationId).toBe("org-b");
	});

	it("records nothing for a refused call", async () => {
		seedProject("org-a");
		accessIn("org-a", []);

		await executePlatformTool(
			"fabric_update_project",
			{ projectId: "proj-1", description: "New description" },
			orgKeyInA,
		);

		expect(mocks.recordAuditFromRequest).not.toHaveBeenCalled();
	});
});

describe("fabric_update_project with nothing to change", () => {
	it("refuses a call that names neither field, without a write or an audit row", async () => {
		seedProject("org-a");
		accessIn("org-a");

		const result = await executePlatformTool(
			"fabric_update_project",
			{ projectId: "proj-1" },
			orgKeyInA,
		);

		expect(result.isError).toBe(true);
		expect(text(result)).toContain("Nothing to update");
		expect(store.updateCalls).toHaveLength(0);
		expect(mocks.recordAuditFromRequest).not.toHaveBeenCalled();
	});
});

describe("fabric_update_project on a project whose organization is being deleted", () => {
	// The MCP route only checks that the SESSION's organization is live; a
	// guest's session sits in another, live one. The app's project permission
	// gate refuses a deleted hosting organization, so this tool does too.
	it("refuses a guest's personal key as not found, without a write or an audit row", async () => {
		seedProject("org-b");
		accessIn("org-b");
		mocks.isOrganizationLive.mockImplementation(
			async (organizationId: string) => organizationId !== "org-b",
		);

		const result = await executePlatformTool(
			"fabric_update_project",
			{ projectId: "proj-1", description: "New description" },
			personalKeyInA,
		);

		expect(text(result)).toContain("Project not found or access denied");
		expect(mocks.isOrganizationLive).toHaveBeenCalledWith("org-b");
		expect(store.updateCalls).toHaveLength(0);
		expect(mocks.recordAuditFromRequest).not.toHaveBeenCalled();
	});

	it("refuses even a caller without the permission as not found, never forbidden", async () => {
		seedProject("org-b");
		accessIn("org-b", []);
		mocks.isOrganizationLive.mockResolvedValue(false);

		const result = await executePlatformTool(
			"fabric_update_project",
			{ projectId: "proj-1", description: "New description" },
			personalKeyInA,
		);

		expect(text(result)).toContain("Project not found or access denied");
		expect(text(result)).not.toContain("No edit permission");
	});
});

describe("fabric_update_project when the audit row fails", () => {
	it("still reports the saved update, since the write has already happened", async () => {
		seedProject("org-a");
		accessIn("org-a");
		mocks.recordAuditFromRequest.mockImplementation(() => {
			throw new Error("audit store unavailable");
		});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		const result = await executePlatformTool(
			"fabric_update_project",
			{ projectId: "proj-1", description: "New description" },
			orgKeyInA,
		);

		expect(result.isError).toBeUndefined();
		expect(store.rows.get("proj-1")?.description).toBe("New description");
		expect(warn).toHaveBeenCalledWith(
			"[MCP Gateway] project.updated audit failed:",
			expect.objectContaining({ error: "audit store unavailable" }),
		);
		warn.mockRestore();
	});
});
