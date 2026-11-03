import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetProjectRepoIntegration = vi.fn();
const mockUpdate = vi.fn();
const mockProjectFindUnique = vi.fn();
const mockLogRepoIntegrationActivity = vi.fn();
const mockRecordAudit = vi.fn();
const mockResolveCredentialActor = vi.fn();
const mockResolveCredential = vi.fn();
const mockVerifyRepositoryAccess = vi.fn();

vi.mock("@repo/database", async (importOriginal) => ({
	...(await importOriginal<typeof import("@repo/database")>()),
	getProjectRepoIntegration: (...args: unknown[]) =>
		mockGetProjectRepoIntegration(...args),
	db: {
		project: {
			findUnique: (...args: unknown[]) => mockProjectFindUnique(...args),
		},
		projectRepositoryIntegration: {
			update: (...args: unknown[]) => mockUpdate(...args),
		},
	},
	logRepoIntegrationActivity: (...args: unknown[]) =>
		mockLogRepoIntegrationActivity(...args),
}));

vi.mock("@repo/connectors", () => ({
	verifyRepositoryAccess: (...args: unknown[]) =>
		mockVerifyRepositoryAccess(...args),
}));

vi.mock("@repo/integrations/repo-auth", () => ({
	REPOSITORY_CREDENTIAL_KINDS: ["PAT", "OAUTH", "GITHUB_APP_USER"],
}));

vi.mock("@repo/integrations/credential-manager", () => ({
	resolveCredential: (...args: unknown[]) => mockResolveCredential(...args),
}));

vi.mock("../../../../credential-manager/lib/context", () => ({
	resolveCredentialActor: (...args: unknown[]) =>
		mockResolveCredentialActor(...args),
}));

vi.mock("../../../../../lib/audit", () => ({
	recordAuditFromRequest: (...args: unknown[]) => mockRecordAudit(...args),
}));

vi.mock("../../../../../orpc/procedures", () => {
	const builder: Record<string, unknown> = {};
	builder.use = () => builder;
	builder.route = () => builder;
	builder.input = () => builder;
	builder.output = () => builder;
	builder.handler = (fn: unknown) => ({ handler: fn });
	return {
		tenantProtectedProcedure: builder,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requireProjectPermission: () => (c: unknown) => c,
	};
});

type Handler = (input: Record<string, unknown>) => Promise<{
	integration: { id: string; status: string };
}>;

async function loadHandler(): Promise<Handler> {
	const mod = await import("../set-credential");
	const raw = (
		mod.setRepoIntegrationCredentialProcedure as unknown as {
			handler: (args: {
				input: Record<string, unknown>;
				context: unknown;
			}) => Promise<{ integration: { id: string; status: string } }>;
		}
	).handler;
	return (input) =>
		raw({
			input,
			context: {
				user: { id: "user-1", name: "User One" },
				session: { id: "session-1" },
			},
		});
}

const baseRow = {
	id: "int-1",
	status: "TOKEN_EXPIRED",
	provider: "GITHUB",
	authMethod: "OAUTH",
	repositoryUrl: "https://github.com/example-org/widgets",
	repositoryOwner: "example-org",
	repositoryName: "widgets",
};

const actor = {
	userId: "user-1",
	organizationId: "org-1",
	canManageOrganizationIntegrations: false,
};

beforeEach(() => {
	vi.clearAllMocks();
	mockProjectFindUnique.mockResolvedValue({ organizationId: "org-1" });
	mockResolveCredentialActor.mockResolvedValue(actor);
	mockGetProjectRepoIntegration.mockResolvedValue({ ...baseRow });
	mockUpdate.mockResolvedValue({ id: "int-1", status: "ACTIVE" });
	mockResolveCredential.mockResolvedValue({
		ok: true,
		value: { token: "cred-token", credential: { kind: "PAT" } },
	});
	mockVerifyRepositoryAccess.mockResolvedValue({ outcome: "accessible" });
});

describe("setRepoIntegrationCredentialProcedure", () => {
	it("resolves the credential as the caller, probes the repository, then binds it", async () => {
		const handler = await loadHandler();
		await handler({
			projectId: "p1",
			integrationId: "int-1",
			credentialId: "cred-1",
		});

		expect(mockResolveCredential).toHaveBeenCalledWith(
			expect.objectContaining({
				credentialId: "cred-1",
				actor: { type: "user", ...actor },
			}),
		);
		expect(mockVerifyRepositoryAccess).toHaveBeenCalledWith(
			expect.objectContaining({
				provider: "GITHUB",
				token: "cred-token",
				owner: "example-org",
				repo: "widgets",
			}),
		);
		expect(mockUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "int-1" },
				data: expect.objectContaining({
					credentialId: "cred-1",
					status: "ACTIVE",
					lastError: null,
				}),
			}),
		);
		expect(mockRecordAudit).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				action: "org.integration.credential_rebound",
				organizationId: "org-1",
			}),
		);
	});

	it("refuses while the credential manager is off and writes nothing", async () => {
		mockResolveCredentialActor.mockRejectedValue(
			new Error("Credential manager is not enabled"),
		);
		const handler = await loadHandler();
		await expect(
			handler({
				projectId: "p1",
				integrationId: "int-1",
				credentialId: "cred-1",
			}),
		).rejects.toThrow(/not enabled/);
		expect(mockUpdate).not.toHaveBeenCalled();
	});

	it("refuses a credential the caller may not use and writes nothing", async () => {
		mockResolveCredential.mockResolvedValue({
			ok: false,
			failure: { code: "forbidden" },
		});
		const handler = await loadHandler();
		await expect(
			handler({
				projectId: "p1",
				integrationId: "int-1",
				credentialId: "cred-1",
			}),
		).rejects.toThrow(/cannot be used/);
		expect(mockVerifyRepositoryAccess).not.toHaveBeenCalled();
		expect(mockUpdate).not.toHaveBeenCalled();
	});

	it("refuses a credential that cannot read the repository and writes nothing", async () => {
		mockVerifyRepositoryAccess.mockResolvedValue({ outcome: "forbidden" });
		const handler = await loadHandler();
		await expect(
			handler({
				projectId: "p1",
				integrationId: "int-1",
				credentialId: "cred-1",
			}),
		).rejects.toThrow(/cannot read the repository/);
		expect(mockUpdate).not.toHaveBeenCalled();
	});

	it("refuses an Azure DevOps repository", async () => {
		mockGetProjectRepoIntegration.mockResolvedValue({
			...baseRow,
			provider: "AZURE_DEVOPS",
		});
		const handler = await loadHandler();
		await expect(
			handler({
				projectId: "p1",
				integrationId: "int-1",
				credentialId: "cred-1",
			}),
		).rejects.toThrow(/Only GitHub and GitLab/);
		expect(mockUpdate).not.toHaveBeenCalled();
	});

	it("clears the choice without resolving anything", async () => {
		const handler = await loadHandler();
		await handler({
			projectId: "p1",
			integrationId: "int-1",
			credentialId: null,
		});
		expect(mockResolveCredential).not.toHaveBeenCalled();
		expect(mockUpdate).toHaveBeenCalledWith(
			expect.objectContaining({ data: { credentialId: null } }),
		);
	});
});
