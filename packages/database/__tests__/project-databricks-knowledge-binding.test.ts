/**
 * Project-level Databricks knowledge binding — query-layer unit tests.
 *
 * Mocks at the Prisma client boundary. The load-bearing assertions:
 *  - the runtime loader scopes the PROJECT lookup with the org-only filter in
 *    org context (never the generic { organizationId, userId } XOR, which
 *    would break org projects owned by another member);
 *  - the save transaction validates the integration against the PROJECT's
 *    tenant (exists, active, DATABRICKS_VECTOR_SEARCH) — RLS validates the
 *    project, not the integration, so this check is the only thing stopping
 *    a personal integration from being bound to an org project;
 *  - the RLS/tenant-db registrations for the new table actually exist (the
 *    generic coverage guards don't fire for a columnless project-scoped
 *    child, so pin them here).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	projectFindFirst,
	projectFindUnique,
	integrationFindFirst,
	upsert,
	deleteMock,
	MockPrismaKnownError,
} = vi.hoisted(() => {
	class MockPrismaKnownError extends Error {
		code: string;
		constructor(code: string) {
			super(`prisma error ${code}`);
			this.code = code;
		}
	}
	return {
		projectFindFirst: vi.fn(),
		projectFindUnique: vi.fn(),
		integrationFindFirst: vi.fn(),
		upsert: vi.fn(),
		deleteMock: vi.fn(),
		MockPrismaKnownError,
	};
});

vi.mock("../prisma/client", () => {
	const tx = {
		project: { findUnique: projectFindUnique },
		workflowIntegration: { findFirst: integrationFindFirst },
		projectDatabricksKnowledgeBinding: { upsert },
	};
	return {
		db: {
			project: { findFirst: projectFindFirst },
			workflowIntegration: { findFirst: integrationFindFirst },
			projectDatabricksKnowledgeBinding: { upsert, delete: deleteMock },
			$transaction: async (fn: (t: typeof tx) => Promise<unknown>) =>
				fn(tx),
		},
		Prisma: { PrismaClientKnownRequestError: MockPrismaKnownError },
	};
});

import {
	deleteProjectDatabricksKnowledgeBinding,
	InvalidDatabricksKnowledgeIntegrationError,
	loadProjectDatabricksKnowledgeBinding,
	saveProjectDatabricksKnowledgeBinding,
} from "../prisma/queries/projects/databricks-knowledge-binding";

beforeEach(() => {
	vi.clearAllMocks();
});

describe("loadProjectDatabricksKnowledgeBinding — tenant scoping", () => {
	it("org context filters the project by organizationId ONLY (no userId)", async () => {
		projectFindFirst.mockResolvedValue(null);

		await loadProjectDatabricksKnowledgeBinding({
			projectId: "proj_1",
			userId: "member_2",
			organizationId: "org_1",
		});

		const where = projectFindFirst.mock.calls[0][0].where;
		expect(where).toEqual({ id: "proj_1", organizationId: "org_1" });
		expect(where).not.toHaveProperty("userId");
	});

	it("personal context filters by userId AND organizationId: null", async () => {
		projectFindFirst.mockResolvedValue(null);

		await loadProjectDatabricksKnowledgeBinding({
			projectId: "proj_1",
			userId: "user_1",
		});

		expect(projectFindFirst.mock.calls[0][0].where).toEqual({
			id: "proj_1",
			userId: "user_1",
			organizationId: null,
		});
	});

	it("returns the runtime binding shape for an enabled, active binding", async () => {
		projectFindFirst.mockResolvedValue({
			databricksKnowledgeBinding: {
				integrationId: "int_1",
				isEnabled: true,
				allowedResources: {
					schema: "cat.schema",
					indexes: ["cat.schema.idx_a", "cat.schema.idx_b"],
				},
				integration: {
					provider: "DATABRICKS_VECTOR_SEARCH",
					isActive: true,
				},
			},
		});

		await expect(
			loadProjectDatabricksKnowledgeBinding({
				projectId: "proj_1",
				userId: "user_1",
				organizationId: "org_1",
			}),
		).resolves.toEqual({
			integrationId: "int_1",
			schema: "cat.schema",
			indexNames: ["cat.schema.idx_a", "cat.schema.idx_b"],
		});
	});

	it.each([
		[
			"disabled binding",
			{
				isEnabled: false,
				integration: {
					provider: "DATABRICKS_VECTOR_SEARCH",
					isActive: true,
				},
				allowedResources: { schema: "s", indexes: ["i"] },
			},
		],
		[
			"inactive integration",
			{
				isEnabled: true,
				integration: {
					provider: "DATABRICKS_VECTOR_SEARCH",
					isActive: false,
				},
				allowedResources: { schema: "s", indexes: ["i"] },
			},
		],
		[
			"integration whose provider is no longer Databricks",
			{
				isEnabled: true,
				integration: { provider: "LINEAR", isActive: true },
				allowedResources: { schema: "s", indexes: ["i"] },
			},
		],
		[
			"binding with no selected indexes",
			{
				isEnabled: true,
				integration: {
					provider: "DATABRICKS_VECTOR_SEARCH",
					isActive: true,
				},
				allowedResources: { schema: "s", indexes: [] },
			},
		],
		[
			"malformed allowedResources",
			{
				isEnabled: true,
				integration: {
					provider: "DATABRICKS_VECTOR_SEARCH",
					isActive: true,
				},
				allowedResources: "not-an-object",
			},
		],
	])("returns null for a %s", async (_label, binding) => {
		projectFindFirst.mockResolvedValue({
			databricksKnowledgeBinding: {
				integrationId: "int_1",
				...binding,
			},
		});

		await expect(
			loadProjectDatabricksKnowledgeBinding({
				projectId: "proj_1",
				userId: "user_1",
			}),
		).resolves.toBeNull();
	});

	it("returns null for a project outside the caller's tenant", async () => {
		projectFindFirst.mockResolvedValue(null);

		await expect(
			loadProjectDatabricksKnowledgeBinding({
				projectId: "proj_other_tenant",
				userId: "user_1",
				organizationId: "org_1",
			}),
		).resolves.toBeNull();
	});
});

describe("saveProjectDatabricksKnowledgeBinding — write-time validation", () => {
	const baseInput = {
		projectId: "proj_1",
		integrationId: "int_1",
		schema: "cat.schema",
		indexNames: ["cat.schema.idx_a"],
		createdBy: "user_1",
	};

	it("validates the integration against the PROJECT's tenant (org project)", async () => {
		projectFindUnique.mockResolvedValue({
			userId: "owner_1",
			organizationId: "org_1",
		});
		integrationFindFirst.mockResolvedValue({
			id: "int_1",
			provider: "DATABRICKS_VECTOR_SEARCH",
			isActive: true,
		});
		upsert.mockResolvedValue({ id: "bind_1" });

		await saveProjectDatabricksKnowledgeBinding(baseInput);

		expect(integrationFindFirst.mock.calls[0][0].where).toEqual({
			id: "int_1",
			organizationId: "org_1",
		});
	});

	it("validates against the owner's personal tenant for a personal project", async () => {
		projectFindUnique.mockResolvedValue({
			userId: "owner_1",
			organizationId: null,
		});
		integrationFindFirst.mockResolvedValue({
			id: "int_1",
			provider: "DATABRICKS_VECTOR_SEARCH",
			isActive: true,
		});
		upsert.mockResolvedValue({ id: "bind_1" });

		await saveProjectDatabricksKnowledgeBinding(baseInput);

		expect(integrationFindFirst.mock.calls[0][0].where).toEqual({
			id: "int_1",
			userId: "owner_1",
			organizationId: null,
		});
	});

	it("rejects an integrationId outside the project's tenant", async () => {
		projectFindUnique.mockResolvedValue({
			userId: "owner_1",
			organizationId: "org_1",
		});
		// Tenant-scoped lookup finds nothing — e.g. a PERSONAL integration id
		// being bound to an ORG project.
		integrationFindFirst.mockResolvedValue(null);

		await expect(
			saveProjectDatabricksKnowledgeBinding(baseInput),
		).rejects.toBeInstanceOf(InvalidDatabricksKnowledgeIntegrationError);
		expect(upsert).not.toHaveBeenCalled();
	});

	it("rejects an inactive integration", async () => {
		projectFindUnique.mockResolvedValue({
			userId: "owner_1",
			organizationId: "org_1",
		});
		integrationFindFirst.mockResolvedValue({
			id: "int_1",
			provider: "DATABRICKS_VECTOR_SEARCH",
			isActive: false,
		});

		await expect(
			saveProjectDatabricksKnowledgeBinding(baseInput),
		).rejects.toBeInstanceOf(InvalidDatabricksKnowledgeIntegrationError);
		expect(upsert).not.toHaveBeenCalled();
	});

	it("rejects a wrong-provider integration (e.g. LINEAR)", async () => {
		projectFindUnique.mockResolvedValue({
			userId: "owner_1",
			organizationId: "org_1",
		});
		integrationFindFirst.mockResolvedValue({
			id: "int_1",
			provider: "LINEAR",
			isActive: true,
		});

		await expect(
			saveProjectDatabricksKnowledgeBinding(baseInput),
		).rejects.toThrow(/LINEAR/);
		expect(upsert).not.toHaveBeenCalled();
	});

	it("upserts with the caller recorded as createdBy", async () => {
		projectFindUnique.mockResolvedValue({
			userId: "owner_1",
			organizationId: "org_1",
		});
		integrationFindFirst.mockResolvedValue({
			id: "int_1",
			provider: "DATABRICKS_VECTOR_SEARCH",
			isActive: true,
		});
		upsert.mockResolvedValue({ id: "bind_1" });

		await saveProjectDatabricksKnowledgeBinding(baseInput);

		const args = upsert.mock.calls[0][0];
		expect(args.where).toEqual({ projectId: "proj_1" });
		expect(args.create.createdBy).toBe("user_1");
		expect(args.create.allowedResources).toEqual({
			schema: "cat.schema",
			indexes: ["cat.schema.idx_a"],
		});
	});
});

describe("deleteProjectDatabricksKnowledgeBinding — idempotency", () => {
	it("returns the deleted row on success", async () => {
		deleteMock.mockResolvedValue({ id: "bind_1", integrationId: "int_1" });

		await expect(
			deleteProjectDatabricksKnowledgeBinding({ projectId: "proj_1" }),
		).resolves.toEqual({ id: "bind_1", integrationId: "int_1" });
	});

	it("treats a concurrent-delete P2025 as already-deleted (null), not an error", async () => {
		deleteMock.mockRejectedValue(new MockPrismaKnownError("P2025"));

		await expect(
			deleteProjectDatabricksKnowledgeBinding({ projectId: "proj_1" }),
		).resolves.toBeNull();
	});

	it("re-throws non-P2025 errors", async () => {
		deleteMock.mockRejectedValue(new MockPrismaKnownError("P2002"));

		await expect(
			deleteProjectDatabricksKnowledgeBinding({ projectId: "proj_1" }),
		).rejects.toThrow(/P2002/);
	});
});

describe("RLS / tenant-db registration", () => {
	// The generic rls-coverage guard only fires for tables carrying an
	// organizationId column; this table is a columnless project-scoped child,
	// so pin its two registrations explicitly.
	it("registers the table as project_scoped in apply-rls-direct.ts", () => {
		const applySrc = readFileSync(
			resolve(__dirname, "../scripts/apply-rls-direct.ts"),
			"utf-8",
		);
		expect(applySrc).toMatch(
			/name:\s*"project_databricks_knowledge_binding",\s*policy:\s*"project_scoped"/,
		);
	});

	it("registers the model in tenant-db PROJECT_SCOPED_TABLES", () => {
		const tenantDbSrc = readFileSync(
			resolve(__dirname, "../src/tenant-db.ts"),
			"utf-8",
		);
		expect(tenantDbSrc).toMatch(
			/ProjectDatabricksKnowledgeBinding:\s*"projectId"/,
		);
	});
});
