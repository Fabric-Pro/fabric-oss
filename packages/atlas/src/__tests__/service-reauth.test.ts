/**
 * Clone-path reconnect recovery + analysis-error humanization.
 *
 * Locks the contract: a `git` authentication failure during the analysis clone
 * is self-healed ONCE via a forced token re-exchange + retry; an unrecoverable
 * auth failure flags the integration reconnect-required and surfaces a clean
 * REPOSITORY_REAUTH_REQUIRED instead of the raw git error; a non-auth failure or
 * a user cancellation propagates unchanged; and a FAILED analysis error is
 * humanized (a raw auth failure → reconnect guidance; embedded URL credentials
 * are stripped).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockResolveRepoCredentials = vi.fn();
const mockFailAnalysisRun = vi.fn();
const mockMarkAnalysisAnalyzing = vi.fn();
const mockSetAnalysisStatus = vi.fn();
const mockForceReExchange = vi.fn();
const mockMarkReauth = vi.fn();
const mockClone = vi.fn();
const mockRevparse = vi.fn();
const mockShow = vi.fn();
const mockRaw = vi.fn();

vi.mock("../credentials", () => ({ ensureFreshRepoCredentials: vi.fn() }));
vi.mock("../commits", () => ({ countCommitsSince: vi.fn() }));

// The clone-auth helpers moved to `@repo/integrations`; keep the real pure
// helpers (buildAuthCloneUrl, isGitAuthError) and stub only the two async
// recovery functions the reauth path drives.
vi.mock("@repo/integrations", async (importActual) => ({
	...(await importActual<typeof import("@repo/integrations")>()),
	forceReExchangeRepoCredentials: (...a: unknown[]) =>
		mockForceReExchange(...a),
	markRepoReauthRequired: (...a: unknown[]) => mockMarkReauth(...a),
}));

vi.mock("../queries", () => ({
	resolveRepoCredentials: (...a: unknown[]) =>
		mockResolveRepoCredentials(...a),
	failAnalysisRun: (...a: unknown[]) => mockFailAnalysisRun(...a),
	markAnalysisAnalyzing: (...a: unknown[]) => mockMarkAnalysisAnalyzing(...a),
	setAnalysisStatus: (...a: unknown[]) => mockSetAnalysisStatus(...a),
}));

vi.mock("@repo/database", () => ({ recordAudit: vi.fn() }));

vi.mock("@repo/ai", () => ({
	AIProviderNotConfiguredError: class AIProviderNotConfiguredError extends Error {},
	generateObject: vi.fn(),
	getAIModelWithMetadata: vi.fn(),
	logModelUsageAsync: vi.fn(),
	streamText: vi.fn(),
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("simple-git", () => ({
	default: vi.fn(() => ({
		clone: (...a: unknown[]) => mockClone(...a),
		revparse: (...a: unknown[]) => mockRevparse(...a),
		show: (...a: unknown[]) => mockShow(...a),
		raw: (...a: unknown[]) => mockRaw(...a),
	})),
}));

import { AtlasService } from "../service";

const ctx = { userId: "user-1", organizationId: "org-1" };

const creds = {
	provider: "GITHUB",
	repositoryUrl: "https://github.com/acme/widgets",
	owner: "acme",
	repo: "widgets",
	branch: "main",
	azureOrganization: null,
	token: "stale-token",
};

const authError = new Error(
	"fatal: Authentication failed for 'https://github.com/acme/widgets/'",
);

type CloneArgs = {
	creds: typeof creds;
	clonePath: string;
	projectId: string;
	repositoryIntegrationId: string;
	abortSignal?: AbortSignal;
};

/** `cloneForAnalysis` is private; drive it directly with a focused arg set. */
function cloneForAnalysis(service: AtlasService, args: CloneArgs) {
	return (
		service as unknown as {
			cloneForAnalysis: (
				i: CloneArgs,
			) => Promise<{ commitSha: string; commitAt: Date | null }>;
		}
	).cloneForAnalysis(args);
}

const baseArgs: CloneArgs = {
	creds,
	clonePath: "/tmp/fabric-cu-test",
	projectId: "p1",
	repositoryIntegrationId: "int-1",
};

beforeEach(() => {
	vi.clearAllMocks();
	// cloneRepo's post-clone reads: empty ls-tree → early return with commit info.
	mockRevparse.mockResolvedValue("abc1234\n");
	mockShow.mockResolvedValue("2026-06-01T00:00:00Z\n");
	mockRaw.mockResolvedValue("");
	mockResolveRepoCredentials.mockResolvedValue(creds);
});

describe("cloneForAnalysis — self-heal", () => {
	it("re-exchanges the token and retries the clone once on an auth failure", async () => {
		mockClone.mockRejectedValueOnce(authError).mockResolvedValue(undefined);
		mockForceReExchange.mockResolvedValue({ refreshed: true });

		const service = new AtlasService(ctx);
		const result = await cloneForAnalysis(service, baseArgs);

		expect(mockForceReExchange).toHaveBeenCalledWith({
			integrationId: "int-1",
			userId: "user-1",
			organizationId: "org-1",
		});
		expect(mockClone).toHaveBeenCalledTimes(2);
		expect(mockMarkReauth).not.toHaveBeenCalled();
		expect(result.commitSha).toBe("abc1234");
	});

	it("flags reconnect-required + throws REPOSITORY_REAUTH_REQUIRED when re-exchange is impossible", async () => {
		mockClone.mockRejectedValue(authError);
		mockForceReExchange.mockResolvedValue({ refreshed: false });

		const service = new AtlasService(ctx);
		await expect(cloneForAnalysis(service, baseArgs)).rejects.toMatchObject(
			{
				code: "REPOSITORY_REAUTH_REQUIRED",
			},
		);

		expect(mockMarkReauth).toHaveBeenCalledWith({
			integrationId: "int-1",
			reason: expect.any(String),
		});
		// No retry clone without a freshly minted token.
		expect(mockClone).toHaveBeenCalledTimes(1);
	});

	it("flags reconnect-required when the retry still fails auth after a re-exchange", async () => {
		mockClone.mockRejectedValue(authError); // both attempts fail
		mockForceReExchange.mockResolvedValue({ refreshed: true });

		const service = new AtlasService(ctx);
		await expect(cloneForAnalysis(service, baseArgs)).rejects.toMatchObject(
			{
				code: "REPOSITORY_REAUTH_REQUIRED",
			},
		);

		expect(mockClone).toHaveBeenCalledTimes(2);
		expect(mockMarkReauth).toHaveBeenCalledTimes(1);
	});

	it("propagates a NON-auth git failure unchanged (no re-exchange, no flag)", async () => {
		mockClone.mockRejectedValue(
			new Error(
				"fatal: could not create work tree dir: No space left on device",
			),
		);

		const service = new AtlasService(ctx);
		await expect(cloneForAnalysis(service, baseArgs)).rejects.toThrow(
			"No space left on device",
		);

		expect(mockForceReExchange).not.toHaveBeenCalled();
		expect(mockMarkReauth).not.toHaveBeenCalled();
	});

	it("does NOT re-exchange a non-GitHub provider, but still flags reconnect cleanly", async () => {
		mockClone.mockRejectedValue(authError);

		const service = new AtlasService(ctx);
		await expect(
			cloneForAnalysis(service, {
				...baseArgs,
				creds: { ...creds, provider: "GITLAB" },
			}),
		).rejects.toMatchObject({ code: "REPOSITORY_REAUTH_REQUIRED" });

		expect(mockForceReExchange).not.toHaveBeenCalled();
		expect(mockMarkReauth).toHaveBeenCalledTimes(1);
	});

	it("propagates a cancellation (aborted) without attempting recovery", async () => {
		mockClone.mockRejectedValue(authError);
		const controller = new AbortController();
		controller.abort();

		const service = new AtlasService(ctx);
		await expect(
			cloneForAnalysis(service, {
				...baseArgs,
				abortSignal: controller.signal,
			}),
		).rejects.toThrow();

		expect(mockForceReExchange).not.toHaveBeenCalled();
		expect(mockMarkReauth).not.toHaveBeenCalled();
	});
});

describe("markStatus — error humanization", () => {
	it("rewrites a raw git auth failure to the reconnect guidance", async () => {
		const service = new AtlasService(ctx);
		await service.markStatus({
			analysisId: "an-1",
			status: "FAILED",
			error: "fatal: Authentication failed for 'https://github.com/acme/widgets/'",
		});

		expect(mockFailAnalysisRun).toHaveBeenCalledWith(
			"an-1",
			expect.stringContaining("Reconnect the repository in Settings"),
		);
	});

	it("strips embedded URL credentials from a non-auth error", async () => {
		const service = new AtlasService(ctx);
		await service.markStatus({
			analysisId: "an-1",
			status: "FAILED",
			error: "clone failed: https://x-access-token:ghs_SECRET@github.com/acme/widgets timed out",
		});

		const persisted = mockFailAnalysisRun.mock.calls[0]?.[1] as string;
		expect(persisted).not.toContain("ghs_SECRET");
		expect(persisted).toContain("***@github.com");
	});

	it("preserves a null error", async () => {
		const service = new AtlasService(ctx);
		await service.markStatus({
			analysisId: "an-1",
			status: "FAILED",
			error: null,
		});

		expect(mockFailAnalysisRun).toHaveBeenCalledWith("an-1", null);
	});

	it("does NOT relabel a non-git 'authentication failed' (e.g. an AI provider error)", async () => {
		const service = new AtlasService(ctx);
		// No git remote URL and no git-only credential wording — must pass through
		// unchanged, NOT be mislabelled as a repository-reconnect error.
		const aiError = "Authentication failed: invalid API key (401)";
		await service.markStatus({
			analysisId: "an-1",
			status: "FAILED",
			error: aiError,
		});

		expect(mockFailAnalysisRun).toHaveBeenCalledWith("an-1", aiError);
	});
});
