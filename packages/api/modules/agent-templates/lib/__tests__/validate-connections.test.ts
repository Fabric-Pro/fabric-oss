/**
 * Tests for agent template instance connection validation.
 *
 * Covers the provider-match invariant: a knowledge connection binding
 * `{ sourceType -> integrationId }` must reference an integration row
 * whose actual `provider` matches the requested `sourceType`, not just
 * one the caller happens to have tenant access to.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.hoisted so these are initialized before the vi.mock factory below
// (which vitest hoists above the imports in this file).
const { mockDb, mockGetWorkflowIntegrationByIdInTenant } = vi.hoisted(() => ({
	mockDb: {
		workflowIntegration: {
			findFirst: vi.fn(),
		},
	},
	mockGetWorkflowIntegrationByIdInTenant: vi.fn(),
}));

// Avoid vi.importActual("@repo/database") - it loads the real Prisma
// singleton and holds open handles past test completion.
vi.mock("@repo/database", () => ({
	db: mockDb,
	getWorkflowIntegrationByIdInTenant: mockGetWorkflowIntegrationByIdInTenant,
}));

import {
	validateAllConnections,
	validateKnowledgeConnections,
} from "../validate-connections";

const USER_ID = "user-1";
const ORG_ID = "org-1";

describe("validateKnowledgeConnections", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("rejects a provider mismatch (sourceType bound to a differently-provider'd integration)", async () => {
		mockGetWorkflowIntegrationByIdInTenant.mockResolvedValue({
			id: "integration-1",
			provider: "LINEAR",
			isActive: true,
		});

		const result = await validateKnowledgeConnections(
			{ DATABRICKS_VECTOR_SEARCH: "integration-1" },
			USER_ID,
			ORG_ID,
		);

		expect(result.valid).toBe(false);
		expect(result.invalidIntegrations).toContain("integration-1");
		expect(result.errors[0]).toMatch(
			/is a LINEAR integration and cannot be used for DATABRICKS_VECTOR_SEARCH/,
		);
	});

	it("passes when the integration's provider matches the source type", async () => {
		mockGetWorkflowIntegrationByIdInTenant.mockResolvedValue({
			id: "integration-2",
			provider: "DATABRICKS_VECTOR_SEARCH",
			isActive: true,
		});

		const result = await validateKnowledgeConnections(
			{ DATABRICKS_VECTOR_SEARCH: "integration-2" },
			USER_ID,
			ORG_ID,
		);

		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
		expect(result.invalidIntegrations).toEqual([]);
	});

	it("still rejects inactive integrations before reaching the provider check", async () => {
		mockGetWorkflowIntegrationByIdInTenant.mockResolvedValue({
			id: "integration-3",
			provider: "DATABRICKS_VECTOR_SEARCH",
			isActive: false,
		});

		const result = await validateKnowledgeConnections(
			{ DATABRICKS_VECTOR_SEARCH: "integration-3" },
			USER_ID,
			ORG_ID,
		);

		expect(result.valid).toBe(false);
		expect(result.errors[0]).toMatch(/is inactive/);
	});

	it("still rejects integrations the tenant has no access to", async () => {
		mockGetWorkflowIntegrationByIdInTenant.mockResolvedValue(null);

		const result = await validateKnowledgeConnections(
			{ DATABRICKS_VECTOR_SEARCH: "integration-4" },
			USER_ID,
			ORG_ID,
		);

		expect(result.valid).toBe(false);
		expect(result.errors[0]).toMatch(/No access to integration/);
	});

	it("validates OAuth-marker connections without touching the provider-match path", async () => {
		mockDb.workflowIntegration.findFirst.mockResolvedValue({
			id: "oauth-integration-1",
		});

		const result = await validateKnowledgeConnections(
			{ NOTION: "oauth" },
			USER_ID,
			ORG_ID,
		);

		expect(result.valid).toBe(true);
		expect(mockGetWorkflowIntegrationByIdInTenant).not.toHaveBeenCalled();
	});
});

describe("validateAllConnections", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("surfaces a knowledge connection provider mismatch as an overall failure", async () => {
		mockGetWorkflowIntegrationByIdInTenant.mockResolvedValue({
			id: "integration-1",
			provider: "LINEAR",
			isActive: true,
		});

		const result = await validateAllConnections(
			{ DATABRICKS_VECTOR_SEARCH: "integration-1" },
			null,
			USER_ID,
			ORG_ID,
		);

		expect(result.valid).toBe(false);
		expect(result.invalidIntegrations).toContain("integration-1");
	});
});
