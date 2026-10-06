/**
 * GitLab steps run on the ACTING user's own GitLab connection.
 *
 * A GitLab connection is personal, so the handler never resolves it with the
 * generic member-wide credential readers (by the step's stored integration id
 * or by provider), which in an organization could hand another member's
 * credential to this run. It reads the acting user's connection through the
 * connection service and sends every request to the REST base of the
 * instance that issued it — never a hardcoded gitlab.com.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildContext, buildInput } from "./integration-handler-fixtures";

const h = vi.hoisted(() => ({
	fetchCredentialsByIdAndProviderInTenant: vi.fn(),
	fetchCredentialsByProvider: vi.fn(),
	getGitLabApiCredential: vi.fn(),
	gitlabOutboundFetch: vi.fn(),
	guardToolWriteForReadOnly: vi.fn(async () => null),
	checkIntegrationAuthority: vi.fn(async () => ({ authorized: true })),
}));

vi.mock("@repo/database", () => ({
	fetchCredentialsByIdAndProviderInTenant:
		h.fetchCredentialsByIdAndProviderInTenant,
	fetchCredentialsByProvider: h.fetchCredentialsByProvider,
}));
vi.mock("@repo/integrations/gitlab", () => ({
	getGitLabApiCredential: h.getGitLabApiCredential,
	gitlabOutboundFetch: h.gitlabOutboundFetch,
}));
vi.mock("../../../../shared/read-only-gate", () => ({
	guardToolWriteForReadOnly: h.guardToolWriteForReadOnly,
}));
vi.mock("../../authority-gate", () => ({
	checkIntegrationAuthority: h.checkIntegrationAuthority,
}));
vi.mock("../../../../shared/oauth-tool-executors", () => ({
	executeMicrosoftTeamsTool: vi.fn(),
}));

const { IntegrationHandler } = await import("../integration-handler");

/** The stored integration id a step carries: user A's connection. */
const A_INTEGRATION_ID = "wi-of-user-a";

function listIssuesStep(userId: string) {
	const input = buildInput("GITLAB", {
		inputs: { operation: "list_issues", project_id: "group/app" },
		integrationId: A_INTEGRATION_ID,
	});
	return buildContext({ ...input, userId });
}

beforeEach(() => {
	for (const mock of Object.values(h)) {
		mock.mockReset();
	}
	h.guardToolWriteForReadOnly.mockResolvedValue(null);
	h.checkIntegrationAuthority.mockResolvedValue({ authorized: true });
	h.gitlabOutboundFetch.mockResolvedValue({
		ok: true,
		status: 200,
		json: async () => [],
	});
	// What the generic readers WOULD hand back: user A's credential. The
	// handler must not ask them for a GitLab step.
	h.fetchCredentialsByIdAndProviderInTenant.mockResolvedValue({
		GITLAB_ACCESS_TOKEN: "token-of-a",
	});
	h.fetchCredentialsByProvider.mockResolvedValue({
		GITLAB_ACCESS_TOKEN: "token-of-a",
	});
});

describe("GitLab steps", () => {
	it("user B's run never gets user A's credential, by id or by provider", async () => {
		// B has no GitLab connection of their own.
		h.getGitLabApiCredential.mockResolvedValue(null);

		const result = await new IntegrationHandler().execute(
			listIssuesStep("user-b"),
		);

		expect(h.getGitLabApiCredential).toHaveBeenCalledWith(
			"user-b",
			"org-1",
		);
		expect(
			h.fetchCredentialsByIdAndProviderInTenant,
		).not.toHaveBeenCalled();
		expect(h.fetchCredentialsByProvider).not.toHaveBeenCalled();
		expect(h.gitlabOutboundFetch).not.toHaveBeenCalled();
		expect(result.handled).toBe(false);
		expect(String(result.error)).toMatch(
			/GITLAB integration not configured/,
		);
	});

	it("user B's run uses user B's own connection even when the step names A's integration", async () => {
		h.getGitLabApiCredential.mockResolvedValue({
			token: "token-of-b",
			apiBase: "https://gitlab.com/api/v4",
		});

		await new IntegrationHandler().execute(listIssuesStep("user-b"));

		const [url, init] = h.gitlabOutboundFetch.mock.calls[0] as [
			string,
			RequestInit,
		];
		expect(url).toMatch(/^https:\/\/gitlab\.com\/api\/v4\/projects\//);
		expect(init.headers).toMatchObject({
			Authorization: "Bearer token-of-b",
		});
	});

	it("get_file_contents without a ref reads the project's default branch, not main", async () => {
		h.getGitLabApiCredential.mockResolvedValue({
			token: "token-of-a",
			apiBase: "https://gitlab.example.com/api/v4",
		});
		h.gitlabOutboundFetch.mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({
				file_name: "README.md",
				file_path: "README.md",
				content: Buffer.from("x").toString("base64"),
				encoding: "base64",
				size: 1,
			}),
		});
		const input = buildInput("GITLAB", {
			inputs: {
				operation: "get_file_contents",
				project_id: "group/app",
				path: "README.md",
			},
			integrationId: A_INTEGRATION_ID,
		});

		await new IntegrationHandler().execute(
			buildContext({ ...input, userId: "user-a" }),
		);

		const [url] = h.gitlabOutboundFetch.mock.calls[0] as [string];
		expect(new URL(url).searchParams.get("ref")).toBe("HEAD");
	});

	it("user A's own run works and goes to A's own instance", async () => {
		h.getGitLabApiCredential.mockResolvedValue({
			token: "token-of-a",
			apiBase: "https://gitlab.example.com/api/v4",
		});

		const result = await new IntegrationHandler().execute(
			listIssuesStep("user-a"),
		);

		expect(result.handled).toBe(true);
		expect(h.getGitLabApiCredential).toHaveBeenCalledWith(
			"user-a",
			"org-1",
		);
		const [url, init] = h.gitlabOutboundFetch.mock.calls[0] as [
			string,
			RequestInit,
		];
		expect(url).toBe(
			"https://gitlab.example.com/api/v4/projects/group%2Fapp/issues?state=opened",
		);
		expect(init.headers).toMatchObject({
			Authorization: "Bearer token-of-a",
		});
	});
});
