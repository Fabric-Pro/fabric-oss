/**
 * Predicates of the exact-identity credential helper.
 *
 * `fetchCredentialsByIdAndProviderInTenant` is what stops a runtime path from
 * executing an integration other than the one the user selected. Its query has
 * to pin the row on four things at once — id, provider, active, tenant — and
 * the tenant clause has to stay member-wide in an organization while staying
 * owner-scoped in personal context.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { findFirstMock, memberFindFirstMock, decryptApiKeyMock } = vi.hoisted(
	() => ({
		findFirstMock: vi.fn(),
		memberFindFirstMock: vi.fn(),
		decryptApiKeyMock: vi.fn(),
	}),
);

vi.mock("../prisma/client", () => ({
	db: {
		workflowIntegration: { findFirst: findFirstMock },
		member: { findFirst: memberFindFirstMock },
	},
}));

vi.mock("@repo/utils", () => ({ decryptApiKey: decryptApiKeyMock }));

const {
	fetchCredentialsByIdAndProviderInTenant,
	fetchCredentialsByIdInTenant,
} = await import("../prisma/queries/workflows/credential-fetcher");

beforeEach(() => {
	findFirstMock.mockReset();
	findFirstMock.mockResolvedValue(null);
	// Default: the caller IS a member of whatever org they claim — the
	// membership gate below has its own describe with this default removed.
	memberFindFirstMock.mockReset();
	memberFindFirstMock.mockResolvedValue({ id: "member-row-1" });
	decryptApiKeyMock.mockReset();
	decryptApiKeyMock.mockImplementation((value: string) => value);
});

describe("fetchCredentialsByIdAndProviderInTenant predicates", () => {
	// Test item 7
	it("pins id, provider and active state, and scopes org lookups to the org", async () => {
		await fetchCredentialsByIdAndProviderInTenant(
			"int-1",
			"DATABRICKS_VECTOR_SEARCH",
			"member-b",
			"org-1",
		);

		expect(findFirstMock).toHaveBeenCalledWith({
			where: {
				id: "int-1",
				provider: "DATABRICKS_VECTOR_SEARCH",
				isActive: true,
				organizationId: "org-1",
			},
		});
	});

	// Test item 7: personal context is owner-scoped AND organizationId-null.
	it("scopes personal lookups to the owning user with a null organization", async () => {
		await fetchCredentialsByIdAndProviderInTenant(
			"int-1",
			"NHTSA_VPIC",
			"member-b",
		);

		expect(findFirstMock).toHaveBeenCalledWith({
			where: {
				id: "int-1",
				provider: "NHTSA_VPIC",
				isActive: true,
				userId: "member-b",
				organizationId: null,
			},
		});
	});

	it("does not add userId to the org predicate, keeping org integrations member-wide", async () => {
		await fetchCredentialsByIdAndProviderInTenant(
			"int-1",
			"NHTSA_VPIC",
			"member-b",
			"org-1",
		);

		const where = findFirstMock.mock.calls[0]?.[0]?.where;
		expect(where).not.toHaveProperty("userId");
	});

	it("returns null when nothing matches, rather than falling back", async () => {
		findFirstMock.mockResolvedValue(null);

		await expect(
			fetchCredentialsByIdAndProviderInTenant(
				"int-1",
				"NHTSA_VPIC",
				"u1",
				"org-1",
			),
		).resolves.toBeNull();
		expect(findFirstMock).toHaveBeenCalledTimes(1);
	});

	it("maps the matched row through the provider's credential mapper", async () => {
		findFirstMock.mockResolvedValue({
			provider: "DATABRICKS_VECTOR_SEARCH",
			credentials: JSON.stringify({
				host: "https://example.azuredatabricks.net",
				clientId: "client",
				clientSecret: "secret",
			}),
		});

		await expect(
			fetchCredentialsByIdAndProviderInTenant(
				"int-1",
				"DATABRICKS_VECTOR_SEARCH",
				"u1",
				"org-1",
			),
		).resolves.toEqual({
			DATABRICKS_HOST: "https://example.azuredatabricks.net",
			DATABRICKS_CLIENT_ID: "client",
			DATABRICKS_CLIENT_SECRET: "secret",
		});
	});
});

// Test item 11: two real same-provider rows in one tenant.
describe("selecting among several same-provider rows", () => {
	const ROWS = [
		{
			id: "databricks-a",
			provider: "DATABRICKS_VECTOR_SEARCH" as const,
			organizationId: "org-1",
			isActive: true,
			credentials: JSON.stringify({
				host: "https://a.azuredatabricks.net",
				clientId: "client-a",
				clientSecret: "secret-a",
			}),
		},
		{
			id: "databricks-b",
			provider: "DATABRICKS_VECTOR_SEARCH" as const,
			organizationId: "org-1",
			isActive: true,
			credentials: JSON.stringify({
				host: "https://b.azuredatabricks.net",
				clientId: "client-b",
				clientSecret: "secret-b",
			}),
		},
	];

	beforeEach(() => {
		// Stand in for the database: satisfy the predicate the helper builds.
		findFirstMock.mockImplementation(
			async ({ where }: { where: Record<string, unknown> }) =>
				ROWS.find(
					(row) =>
						row.id === where.id &&
						row.provider === where.provider &&
						row.isActive === where.isActive &&
						row.organizationId === where.organizationId,
				) ?? null,
		);
	});

	it("returns the credentials of the requested row, not the first same-provider row", async () => {
		await expect(
			fetchCredentialsByIdAndProviderInTenant(
				"databricks-b",
				"DATABRICKS_VECTOR_SEARCH",
				"u1",
				"org-1",
			),
		).resolves.toEqual({
			DATABRICKS_HOST: "https://b.azuredatabricks.net",
			DATABRICKS_CLIENT_ID: "client-b",
			DATABRICKS_CLIENT_SECRET: "secret-b",
		});
	});

	it("does not resolve a row belonging to a different provider", async () => {
		await expect(
			fetchCredentialsByIdAndProviderInTenant(
				"databricks-a",
				"NHTSA_VPIC",
				"u1",
				"org-1",
			),
		).resolves.toBeNull();
	});

	it("does not resolve a row belonging to a different tenant", async () => {
		await expect(
			fetchCredentialsByIdAndProviderInTenant(
				"databricks-a",
				"DATABRICKS_VECTOR_SEARCH",
				"u1",
				"org-2",
			),
		).resolves.toBeNull();
	});
});

/**
 * Regression: org-context credential access requires actual org MEMBERSHIP.
 *
 * `requireProjectPermission` promotes the host project's organizationId into
 * the request context for an external ProjectMember guest who has NO Member
 * row in that organization, and runtime paths thread that organizationId
 * into these fetchers. Without the membership gate, filtering
 * WorkflowIntegration by organizationId alone hands the org's real
 * credentials (e.g. its Databricks service principal) to a project-only
 * guest. The required outcome is `null` — the same safe silent no-op as a
 * personal-context caller — so no binding resolves credentials and no tool
 * can execute for that caller.
 */
describe("org membership gate (project-guest credential leak regression)", () => {
	const ORG_ROW = {
		id: "int-1",
		provider: "DATABRICKS_VECTOR_SEARCH" as const,
		organizationId: "org-1",
		isActive: true,
		credentials: JSON.stringify({
			host: "https://a.azuredatabricks.net",
			clientId: "client-a",
			clientSecret: "secret-a",
		}),
	};

	beforeEach(() => {
		findFirstMock.mockResolvedValue(ORG_ROW);
	});

	it("an accepted ProjectMember with NO Member row resolves null — never the org's credentials", async () => {
		// The guest has project access (ProjectMember) but no `member` row.
		memberFindFirstMock.mockResolvedValue(null);

		await expect(
			fetchCredentialsByIdInTenant("int-1", "guest-user", "org-1"),
		).resolves.toBeNull();
		// Denied BEFORE the integration row is even read.
		expect(findFirstMock).not.toHaveBeenCalled();
	});

	it("the same gate covers fetchCredentialsByIdAndProviderInTenant", async () => {
		memberFindFirstMock.mockResolvedValue(null);

		await expect(
			fetchCredentialsByIdAndProviderInTenant(
				"int-1",
				"DATABRICKS_VECTOR_SEARCH",
				"guest-user",
				"org-1",
			),
		).resolves.toBeNull();
		expect(findFirstMock).not.toHaveBeenCalled();
	});

	it("checks membership for the exact (userId, organizationId) pair", async () => {
		await fetchCredentialsByIdInTenant("int-1", "member-b", "org-1");

		expect(memberFindFirstMock).toHaveBeenCalledWith({
			where: { organizationId: "org-1", userId: "member-b" },
			select: { id: true },
		});
	});

	it("a real org member still resolves the org's credentials (member-wide access preserved)", async () => {
		await expect(
			fetchCredentialsByIdInTenant("int-1", "member-b", "org-1"),
		).resolves.toEqual({
			DATABRICKS_HOST: "https://a.azuredatabricks.net",
			DATABRICKS_CLIENT_ID: "client-a",
			DATABRICKS_CLIENT_SECRET: "secret-a",
		});
	});

	it("personal context never consults the member table", async () => {
		findFirstMock.mockResolvedValue(null);

		await fetchCredentialsByIdInTenant("int-1", "u1");

		expect(memberFindFirstMock).not.toHaveBeenCalled();
	});
});
