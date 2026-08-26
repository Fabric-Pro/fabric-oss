/**
 * Integration tests for `listAzureDevOpsReposProcedure`.
 *
 * Mirrors the GitLab list-projects test pattern (hoisted `vi.mock` factories +
 * a `loadHandler` helper that imports the procedure after the mocks register).
 * `procedures/github/` has no `__tests__` folder, so GitLab is the template.
 *
 * Scenarios:
 *   - happy path → returns the connectors helper's grouped result verbatim.
 *   - 401 → throws BAD_REQUEST "Invalid PAT or insufficient permissions".
 *   - 403 → same invalid-PAT BAD_REQUEST.
 *   - other non-OK → BAD_REQUEST "Azure DevOps returned status N".
 *   - "no repos" → returns configured:true, empty groups (NOT a throw).
 *   - the PAT is never echoed back in the result.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mock factories for the connectors discovery helpers
// ---------------------------------------------------------------------------
const mockValidateAzureDevOpsPat = vi.fn();
const mockListAzureDevOpsProjectsAndRepos = vi.fn();

vi.mock("@repo/connectors", () => ({
	validateAzureDevOpsPat: (...args: unknown[]) =>
		mockValidateAzureDevOpsPat(...args),
	listAzureDevOpsProjectsAndRepos: (...args: unknown[]) =>
		mockListAzureDevOpsProjectsAndRepos(...args),
}));

vi.mock("../../../../../orpc/procedures", () => {
	const builder: Record<string, unknown> = {};
	builder.use = () => builder;
	builder.route = () => builder;
	builder.input = () => builder;
	builder.handler = (fn: unknown) => ({ handler: fn });
	return {
		tenantProtectedProcedure: builder,
		resolveOrganizationId: (orgId: string | null | undefined) =>
			orgId ?? null,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requirePermission: () => (c: unknown) => c,
		requireProjectPermission: () => (c: unknown) => c,
	};
});

interface ListResult {
	configured: boolean;
	organization: string | null;
	groups: unknown[];
	error: string | null;
}

type Handler = (args: {
	input: {
		organizationId?: string | null;
		pat: string;
		azureOrganization: string;
		projectId?: string;
	};
	context: { user: { id: string }; session: { id: string } };
}) => Promise<ListResult>;

async function loadHandler(): Promise<Handler> {
	const mod = await import("../list-repos");
	return (
		mod.listAzureDevOpsReposProcedure as unknown as { handler: Handler }
	).handler;
}

const baseInput = {
	organizationId: null,
	pat: "secret-pat",
	azureOrganization: "my-org",
};
const baseContext = {
	user: { id: "user-1" },
	session: { id: "session-1" },
};

beforeEach(() => {
	vi.clearAllMocks();
	mockValidateAzureDevOpsPat.mockResolvedValue({ ok: true });
});

describe("listAzureDevOpsReposProcedure", () => {
	it("returns the grouped discovery result on the happy path", async () => {
		const groups = [
			{
				owner: "ProjectA",
				repos: [
					{
						name: "web",
						projectName: "ProjectA",
						fullName:
							"https://dev.azure.com/my-org/ProjectA/_git/web",
						htmlUrl:
							"https://dev.azure.com/my-org/ProjectA/_git/web",
						isPrivate: true,
						language: null,
					},
				],
			},
		];
		mockListAzureDevOpsProjectsAndRepos.mockResolvedValue({
			configured: true,
			organization: "my-org",
			groups,
			error: null,
		});

		const handler = await loadHandler();
		const result = await handler({
			input: baseInput,
			context: baseContext,
		});

		expect(result.configured).toBe(true);
		expect(result.organization).toBe("my-org");
		expect(result.groups).toEqual(groups);
		expect(result.error).toBeNull();

		// Helper called with the org + PAT the user entered.
		expect(mockValidateAzureDevOpsPat).toHaveBeenCalledWith({
			organization: "my-org",
			pat: "secret-pat",
		});
		expect(mockListAzureDevOpsProjectsAndRepos).toHaveBeenCalledWith({
			organization: "my-org",
			pat: "secret-pat",
		});
	});

	it("throws BAD_REQUEST 'Invalid PAT or insufficient permissions' on 401", async () => {
		mockValidateAzureDevOpsPat.mockResolvedValue({
			ok: false,
			status: 401,
		});

		const handler = await loadHandler();
		await expect(
			handler({ input: baseInput, context: baseContext }),
		).rejects.toMatchObject({
			message: "Invalid PAT or insufficient permissions",
		});

		// On auth failure the listing helper is never called.
		expect(mockListAzureDevOpsProjectsAndRepos).not.toHaveBeenCalled();
	});

	it("throws the same invalid-PAT BAD_REQUEST on 403", async () => {
		mockValidateAzureDevOpsPat.mockResolvedValue({
			ok: false,
			status: 403,
		});

		const handler = await loadHandler();
		await expect(
			handler({ input: baseInput, context: baseContext }),
		).rejects.toMatchObject({
			message: "Invalid PAT or insufficient permissions",
		});
	});

	it("throws BAD_REQUEST with a sanitized status message for other non-OK", async () => {
		mockValidateAzureDevOpsPat.mockResolvedValue({
			ok: false,
			status: 500,
		});

		const handler = await loadHandler();
		await expect(
			handler({ input: baseInput, context: baseContext }),
		).rejects.toMatchObject({
			message: "Azure DevOps returned status 500",
		});
	});

	it("returns configured:true with empty groups when no repos found (not a throw)", async () => {
		mockListAzureDevOpsProjectsAndRepos.mockResolvedValue({
			configured: true,
			organization: "my-org",
			groups: [],
			error: "No repositories found in this organization.",
		});

		const handler = await loadHandler();
		const result = await handler({
			input: baseInput,
			context: baseContext,
		});

		expect(result.configured).toBe(true);
		expect(result.groups).toEqual([]);
		expect(result.error).toMatch(/No repositories found/i);
	});

	it("never echoes the PAT back in the result", async () => {
		mockListAzureDevOpsProjectsAndRepos.mockResolvedValue({
			configured: true,
			organization: "my-org",
			groups: [],
			error: null,
		});

		const handler = await loadHandler();
		const result = await handler({
			input: baseInput,
			context: baseContext,
		});

		expect(JSON.stringify(result)).not.toContain("secret-pat");
	});
});
