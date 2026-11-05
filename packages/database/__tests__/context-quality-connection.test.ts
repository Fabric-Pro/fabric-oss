import { computeDatabricksEvaluationPrincipalFingerprint } from "@repo/databricks";
import { beforeEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	integration: vi.fn(),
	member: vi.fn(),
	credentials: vi.fn(),
}));
vi.mock("../prisma/client", () => ({
	db: {
		workflowIntegration: { findFirst: m.integration },
		member: { findFirst: m.member },
	},
}));
vi.mock("../prisma/queries/workflows/credential-fetcher", () => ({
	fetchCredentialsByIdAndProviderInTenant: m.credentials,
}));

import { fetchContextQualityExecutionCredentials } from "../prisma/queries/projects/context-quality-connection";

const input = {
	integrationId: "example-connection",
	organizationId: "example-org",
	userId: "example-user",
	workspaceOrigin: "https://example.cloud.databricks.com",
	principalFingerprint: computeDatabricksEvaluationPrincipalFingerprint(
		"https://example.cloud.databricks.com",
		"example-principal",
	),
};
beforeEach(() => {
	vi.resetAllMocks();
	m.integration.mockResolvedValue({ userId: "example-owner" });
	m.member.mockResolvedValue({ id: "example-member" });
	m.credentials.mockResolvedValue({
		DATABRICKS_HOST: input.workspaceOrigin,
		DATABRICKS_CLIENT_ID: "example-principal",
		DATABRICKS_CLIENT_SECRET: "example-secret",
	});
});
it("requires an exact active shared platform row before decrypting credentials", async () => {
	await fetchContextQualityExecutionCredentials(input);
	expect(m.integration).toHaveBeenCalledWith(
		expect.objectContaining({
			where: {
				id: input.integrationId,
				organizationId: input.organizationId,
				provider: "DATABRICKS_PLATFORM",
				workflowId: null,
				isActive: true,
				usageScope: "ORGANIZATION_SHARED",
			},
		}),
	);
});
it("does not use a departed connection owner's grant for outbound verification", async () => {
	m.member.mockResolvedValue(null);
	expect(await fetchContextQualityExecutionCredentials(input)).toBeNull();
	expect(m.credentials).not.toHaveBeenCalled();
});
it.each(["host", "principal"])(
	"refuses %s drift before admission",
	async (kind) => {
		m.credentials.mockResolvedValue({
			DATABRICKS_HOST:
				kind === "host"
					? "https://other.cloud.databricks.com"
					: input.workspaceOrigin,
			DATABRICKS_CLIENT_ID:
				kind === "principal" ? "example-other" : "example-principal",
			DATABRICKS_CLIENT_SECRET: "example-secret",
		});
		expect(await fetchContextQualityExecutionCredentials(input)).toBeNull();
	},
);
it("checks current actor access in the same organization", async () => {
	await fetchContextQualityExecutionCredentials(input);
	expect(m.credentials).toHaveBeenCalledWith(
		input.integrationId,
		"DATABRICKS_PLATFORM",
		input.userId,
		input.organizationId,
	);
});
