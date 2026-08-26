import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks for every collaborator the sync activity orchestrates -------------
// Only the IO functions are stubbed; the pure `parseRepoUrl` stays REAL so the
// org/project extraction is exercised against the actual URL grammar.
vi.mock("@repo/database", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@repo/database")>();
	return {
		...actual,
		getProjectReposForPipelineSync: vi.fn(),
		getPipelineSyncCursor: vi.fn(),
		advancePipelineSyncState: vi.fn(),
		recordPipelineSyncFailure: vi.fn(),
		openBugsForFailedCases: vi.fn(),
	};
});
vi.mock("@repo/integrations", () => ({
	resolveFreshRepoToken: vi.fn(),
}));
// The observability requirement is "fetch errors are logged for support
// diagnosis", so the log line is part of the contract and has to be observable.
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../fetchers/ado-client", () => ({
	createAdoPatClient: vi.fn(() => ({ get: vi.fn() })),
}));
vi.mock("../fetchers/azure-devops-fetcher", () => ({
	fetchAzureDevOpsRuns: vi.fn(),
}));
vi.mock("../fetchers/github-client", () => ({
	createGithubTokenClient: vi.fn(() => ({
		get: vi.fn(),
		getArtifactZip: vi.fn(),
	})),
}));
vi.mock("../fetchers/github-actions-fetcher", () => ({
	fetchGithubActionsRuns: vi.fn(),
}));
vi.mock("../fetchers/gitlab-client", () => ({
	createGitlabTokenClient: vi.fn(() => ({ get: vi.fn() })),
	gitlabApiBaseFromRepoUrl: vi.fn(() => "https://gitlab.com/api/v4"),
}));
vi.mock("../fetchers/gitlab-ci-fetcher", () => ({
	fetchGitlabCiRuns: vi.fn(),
}));
vi.mock("../ingest-pipeline-results", () => ({
	ingestNormalizedRuns: vi.fn(),
}));

import {
	advancePipelineSyncState,
	getPipelineSyncCursor,
	getProjectReposForPipelineSync,
	openBugsForFailedCases,
	type ProjectRepoForCodeSearch,
	recordPipelineSyncFailure,
} from "@repo/database";
import { resolveFreshRepoToken } from "@repo/integrations";
import { logger } from "@repo/logs";
import { fetchAzureDevOpsRuns } from "../fetchers/azure-devops-fetcher";
import { fetchGithubActionsRuns } from "../fetchers/github-actions-fetcher";
import { fetchGitlabCiRuns } from "../fetchers/gitlab-ci-fetcher";
import { ProviderHttpError } from "../fetchers/provider-http-error";
import { ingestNormalizedRuns } from "../ingest-pipeline-results";
import {
	classificationForKind,
	type SyncFailureKind,
} from "../sync-failure-classification";
import { syncPipelineResultsForProject } from "../sync-pipeline-results";

const mocked = {
	repos: vi.mocked(getProjectReposForPipelineSync),
	cursor: vi.mocked(getPipelineSyncCursor),
	advance: vi.mocked(advancePipelineSyncState),
	fail: vi.mocked(recordPipelineSyncFailure),
	rca: vi.mocked(openBugsForFailedCases),
	token: vi.mocked(resolveFreshRepoToken),
	fetch: vi.mocked(fetchAzureDevOpsRuns),
	ghFetch: vi.mocked(fetchGithubActionsRuns),
	glFetch: vi.mocked(fetchGitlabCiRuns),
	ingest: vi.mocked(ingestNormalizedRuns),
};

/** A connected ADO repo integration row (as getProjectReposForPipelineSync shapes it). */
function adoRepo(
	overrides: Partial<ProjectRepoForCodeSearch> = {},
): ProjectRepoForCodeSearch {
	return {
		integrationId: "int-1",
		provider: "AZURE_DEVOPS",
		owner: "example-org",
		repo: "Test-Repo",
		branch: "main",
		repositoryUrl:
			"https://dev.azure.com/example-org/Fabric/_git/Test-Repo",
		encryptedAccessToken: null,
		encryptedRefreshToken: null,
		tokenExpiresAt: null,
		updatedAt: new Date(),
		encryptedPat: "enc",
		azureOrganization: "example-org",
		authMethod: "PAT",
		...overrides,
	};
}

const BASE = {
	projectId: "p1",
	organizationId: null,
	userId: "u1",
};

function goodIngest(overrides: Record<string, unknown> = {}) {
	return {
		documentsMarkedForDeploy: 0,
		ingestedRuns: 1,
		skippedRuns: 0,
		matched: 5,
		unmatched: 0,
		touchedCaseIds: ["c1"],
		findingsCreated: 0,
		findingsUpdated: 0,
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mocked.token.mockResolvedValue({
		token: "pat-123",
		authMethod: "PAT",
		provider: "AZURE_DEVOPS",
	});
	mocked.cursor.mockResolvedValue(null);
	mocked.fetch.mockResolvedValue({ runs: [], newCursor: 2 });
	mocked.ghFetch.mockResolvedValue({ runs: [], newCursor: 2 });
	mocked.glFetch.mockResolvedValue({ runs: [], newCursor: 2 });
	mocked.ingest.mockResolvedValue(goodIngest());
	mocked.advance.mockResolvedValue(undefined as never);
	// Default: not a repeat of a prior identical failure, and the write landed
	// (no newer attempt superseded it). Tests that need the repeat or
	// superseded paths override this explicitly.
	mocked.fail.mockResolvedValue({ repeat: false, applied: true });
	mocked.rca.mockResolvedValue(1);
});

describe("syncPipelineResultsForProject", () => {
	it("parses org/project from the repo URL and fetches with the ADO project name", async () => {
		mocked.repos.mockResolvedValue([adoRepo()]);
		await syncPipelineResultsForProject({ ...BASE });
		expect(mocked.fetch).toHaveBeenCalledTimes(1);
		expect(mocked.fetch.mock.calls[0][1]).toMatchObject({
			project: "Fabric",
			sinceRunId: null,
		});
	});

	it("reads and parses the stored cursor into sinceRunId", async () => {
		mocked.repos.mockResolvedValue([adoRepo()]);
		mocked.cursor.mockResolvedValue({ lastRunExternalId: "5" });
		await syncPipelineResultsForProject({ ...BASE });
		expect(mocked.fetch.mock.calls[0][1]).toMatchObject({ sinceRunId: 5 });
	});

	it("uses separate cursors for repositories in the same ADO project", async () => {
		mocked.repos.mockResolvedValue([
			adoRepo(),
			adoRepo({
				integrationId: "int-2",
				repo: "Api-Repo",
				repositoryUrl:
					"https://dev.azure.com/example-org/Fabric/_git/Api-Repo",
			}),
		]);

		await syncPipelineResultsForProject({ ...BASE });

		expect(mocked.cursor).toHaveBeenCalledWith(
			expect.objectContaining({ pipelineKey: "Fabric/Test-Repo" }),
		);
		expect(mocked.cursor).toHaveBeenCalledWith(
			expect.objectContaining({ pipelineKey: "Fabric/Api-Repo" }),
		);
	});

	it("advances the cursor to the new high-watermark on success", async () => {
		mocked.repos.mockResolvedValue([adoRepo()]);
		mocked.fetch.mockResolvedValue({ runs: [], newCursor: 7 });
		const res = await syncPipelineResultsForProject({ ...BASE });
		expect(mocked.advance).toHaveBeenCalledTimes(1);
		expect(mocked.advance.mock.calls[0][0]).toMatchObject({
			provider: "azure-devops",
			pipelineKey: "Fabric/Test-Repo",
			lastRunExternalId: "7",
		});
		expect(res.ingestedRuns).toBe(1);
		expect(res.errors).toHaveLength(0);
	});

	it("keeps the prior cursor when the fetch surfaced nothing new", async () => {
		mocked.repos.mockResolvedValue([adoRepo()]);
		mocked.cursor.mockResolvedValue({ lastRunExternalId: "9" });
		mocked.fetch.mockResolvedValue({ runs: [], newCursor: null });
		await syncPipelineResultsForProject({ ...BASE });
		expect(mocked.advance.mock.calls[0][0]).toMatchObject({
			lastRunExternalId: "9",
		});
	});

	it("records a sync failure WITHOUT advancing the cursor when the fetch throws", async () => {
		mocked.repos.mockResolvedValue([adoRepo()]);
		mocked.fetch.mockRejectedValue(new Error("ADO 500"));
		const res = await syncPipelineResultsForProject({ ...BASE });
		expect(mocked.fail).toHaveBeenCalledTimes(1);
		expect(mocked.advance).not.toHaveBeenCalled();
		// Card #2383, finding 4: a plain `Error` classifies UNKNOWN — ours, not
		// the customer's — so the CUSTOMER-FACING result carries the generic
		// sanitized sentence, never the raw exception message (which could carry
		// anything: config, an endpoint, even ciphertext). The raw "ADO 500" text
		// still reaches the structured logger — pinned separately below.
		expect(mocked.fail.mock.calls[0][0]).toMatchObject({ kind: "UNKNOWN" });
		expect(res.errors).toEqual([
			{
				source: "https://dev.azure.com/example-org/Fabric/_git/Test-Repo",
				error: "Fabric hit an internal error syncing this pipeline. The error has been recorded — no action is needed from you.",
			},
		]);
		expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
			"qa.pipeline.sync.source_failed",
			expect.objectContaining({ error: "ADO 500", kind: "UNKNOWN" }),
		);
	});

	it("records a failure and never fetches when no credential resolves", async () => {
		mocked.repos.mockResolvedValue([adoRepo()]);
		mocked.token.mockResolvedValue({
			token: null,
			authMethod: null,
			provider: null,
		});
		const res = await syncPipelineResultsForProject({ ...BASE });
		expect(mocked.fetch).not.toHaveBeenCalled();
		expect(mocked.fail).toHaveBeenCalledTimes(1);
		expect(res.sourcesAttempted).toBe(0);
		expect(res.errors[0].error).toMatch(/credential/i);
		// The failure is recorded under the SAME sync-state key a success uses —
		// for ADO that's the project segment ("Fabric"), NOT owner/repo — so the
		// failure row correlates with the cursor row and clears on a later success.
		expect(mocked.fail.mock.calls[0][0]).toMatchObject({
			provider: "azure-devops",
			pipelineKey: "Fabric/Test-Repo",
			kind: "CREDENTIAL_MISSING",
		});

		// ...and it reaches the structured logger, not just the sync-state row.
		// Persisting only to the row meant diagnosing a customer's silent sync
		// required reading their screen or their database.
		//
		// Level is `warn`, not `error` (card #2383): a cleanly-resolved-but-absent
		// credential is the customer's problem, expected to recur every 15
		// minutes until they reconnect, and reconnecting IS the fix — the exact
		// state this change stops paging engineers for.
		expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
			"qa.pipeline.sync.source_failed",
			expect.objectContaining({
				projectId: BASE.projectId,
				provider: "azure-devops",
				pipelineKey: "Fabric/Test-Repo",
				error: expect.stringMatching(/credential/i),
				kind: "CREDENTIAL_MISSING",
			}),
		);
		expect(vi.mocked(logger.error)).not.toHaveBeenCalled();
	});

	// Card #2383, finding 1: a decrypt fault (lost/rotated encryption key,
	// corrupted ciphertext) is a PLATFORM fault affecting every tenant's stored
	// credential at once — reconnecting a repository cannot fix it. It must
	// classify UNKNOWN, not CREDENTIAL_MISSING, or a decryption outage would
	// read as "every customer's credential went missing at once" and tell each
	// of them to reconnect for a problem that is entirely ours.
	it("classifies a stored-but-undecryptable credential (credentialFault: DECRYPT_FAILED) as UNKNOWN, not CREDENTIAL_MISSING", async () => {
		mocked.repos.mockResolvedValue([adoRepo()]);
		mocked.token.mockResolvedValue({
			token: null,
			authMethod: null,
			provider: null,
			credentialFault: "DECRYPT_FAILED",
		});
		const res = await syncPipelineResultsForProject({ ...BASE });

		expect(mocked.fetch).not.toHaveBeenCalled();
		expect(mocked.fail.mock.calls[0][0]).toMatchObject({
			kind: "UNKNOWN",
		});
		// Customer-facing result is the generic sanitized sentence.
		expect(res.errors[0].error).toMatch(/see server logs/i);
		expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
			"qa.pipeline.sync.source_failed",
			expect.objectContaining({
				kind: "UNKNOWN",
				error: expect.stringContaining("could not be decrypted"),
			}),
		);
		expect(vi.mocked(logger.warn)).not.toHaveBeenCalled();
		// And `reconnectFixes` must stay false for the persisted kind —
		// reconnecting cannot fix a broken encryption key.
		expect(
			classificationForKind(
				mocked.fail.mock.calls[0][0].kind as SyncFailureKind,
			).reconnectFixes,
		).toBe(false);
	});

	it("still classifies an ABSENT credential (no credentialFault) as CREDENTIAL_MISSING", async () => {
		mocked.repos.mockResolvedValue([adoRepo()]);
		mocked.token.mockResolvedValue({
			token: null,
			authMethod: null,
			provider: null,
			credentialFault: "ABSENT",
		});
		const res = await syncPipelineResultsForProject({ ...BASE });

		expect(mocked.fail.mock.calls[0][0]).toMatchObject({
			kind: "CREDENTIAL_MISSING",
		});
		expect(res.errors[0].error).toMatch(/credential/i);
		expect(vi.mocked(logger.warn)).toHaveBeenCalled();
		expect(vi.mocked(logger.error)).not.toHaveBeenCalled();
	});

	it("logs every per-source failure, not only the credential one", async () => {
		// All three failure paths (no plan, no credential, fetch threw) go through
		// one helper precisely so a recorded row can never exist without a log
		// line. This pins the fetch-threw path, the one a support case starts from.
		//
		// Still `error` under the card #2383 classification, unlike the
		// no-credential test above: a bare `Error` is not a `ProviderHttpError`,
		// so it classifies UNKNOWN — a fault of OURS (ingest, a fetcher bug, an
		// unhandled provider shape), not an expected customer-side state — and
		// UNKNOWN never steps down, repeat or not.
		mocked.repos.mockResolvedValue([adoRepo()]);
		mocked.token.mockResolvedValue({
			token: "t",
			authMethod: "PAT",
			provider: "AZURE_DEVOPS",
		});
		mocked.cursor.mockResolvedValue(null as never);
		mocked.fetch.mockRejectedValue(new Error("ADO exploded"));

		await syncPipelineResultsForProject({ ...BASE });

		expect(mocked.fail).toHaveBeenCalledTimes(1);
		expect(mocked.fail.mock.calls[0][0]).toMatchObject({
			kind: "UNKNOWN",
		});
		expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
			"qa.pipeline.sync.source_failed",
			expect.objectContaining({ error: "ADO exploded", kind: "UNKNOWN" }),
		);
	});

	it("opens bugs only when the project opted in AND a user is attributed", async () => {
		mocked.repos.mockResolvedValue([adoRepo()]);

		// Opted in + user present → RCA runs.
		const withRca = await syncPipelineResultsForProject({
			...BASE,
			autoCreateBugsFromFailures: true,
		});
		expect(mocked.rca).toHaveBeenCalledTimes(1);
		expect(withRca.bugsOpened).toBe(1);

		// Opted in but no user → RCA skipped (can't attribute the bug).
		vi.clearAllMocks();
		mocked.repos.mockResolvedValue([adoRepo()]);
		mocked.token.mockResolvedValue({
			token: "pat",
			authMethod: "PAT",
			provider: "AZURE_DEVOPS",
		});
		mocked.cursor.mockResolvedValue(null);
		mocked.fetch.mockResolvedValue({ runs: [], newCursor: 2 });
		mocked.ingest.mockResolvedValue(goodIngest());
		await syncPipelineResultsForProject({
			...BASE,
			userId: null,
			autoCreateBugsFromFailures: true,
		});
		expect(mocked.rca).not.toHaveBeenCalled();
	});

	it("does not open bugs when the project has not opted in", async () => {
		mocked.repos.mockResolvedValue([adoRepo()]);
		await syncPipelineResultsForProject({
			...BASE,
			autoCreateBugsFromFailures: false,
		});
		expect(mocked.rca).not.toHaveBeenCalled();
	});

	it("surfaces an unsupported provider as a source error, not a silent drop (FR6)", async () => {
		// A provider outside the supported set (a hypothetical future one) must be
		// reported, never dropped. Cast past the enum to exercise the default branch.
		mocked.repos.mockResolvedValue([
			adoRepo({
				provider: "BITBUCKET" as never,
				repositoryUrl: "https://bitbucket.org/acme/store",
			}),
		]);
		const res = await syncPipelineResultsForProject({ ...BASE });
		expect(mocked.fetch).not.toHaveBeenCalled();
		expect(mocked.ghFetch).not.toHaveBeenCalled();
		expect(mocked.glFetch).not.toHaveBeenCalled();
		expect(mocked.fail).toHaveBeenCalledTimes(1);
		expect(res.sourcesAttempted).toBe(0);
		expect(res.errors[0].error).toMatch(/aren't supported/i);
	});

	it("dispatches a GitHub source to the GitHub Actions fetcher", async () => {
		mocked.repos.mockResolvedValue([
			adoRepo({
				provider: "GITHUB",
				owner: "acme",
				repo: "store",
				branch: "main",
				repositoryUrl: "https://github.com/acme/store",
			}),
		]);
		mocked.ghFetch.mockResolvedValue({ runs: [], newCursor: 42 });
		const res = await syncPipelineResultsForProject({ ...BASE });
		// The ADO fetcher is NOT called for a GitHub source; the GitHub one is.
		expect(mocked.fetch).not.toHaveBeenCalled();
		expect(mocked.ghFetch).toHaveBeenCalledTimes(1);
		expect(mocked.ghFetch.mock.calls[0][1]).toMatchObject({
			owner: "acme",
			repo: "store",
			branch: "main",
			sinceRunId: null,
		});
		expect(res.sourcesAttempted).toBe(1);
		expect(res.errors).toHaveLength(0);
		expect(mocked.advance.mock.calls[0][0]).toMatchObject({
			provider: "github-actions",
			pipelineKey: "acme/store",
			lastRunExternalId: "42",
		});
	});

	it("dispatches a GitLab source to the GitLab CI fetcher", async () => {
		mocked.repos.mockResolvedValue([
			adoRepo({
				provider: "GITLAB",
				owner: "acme",
				repo: "store",
				branch: "main",
				repositoryUrl: "https://gitlab.com/acme/store",
			}),
		]);
		mocked.glFetch.mockResolvedValue({ runs: [], newCursor: 99 });
		const res = await syncPipelineResultsForProject({ ...BASE });
		expect(mocked.fetch).not.toHaveBeenCalled();
		expect(mocked.glFetch).toHaveBeenCalledTimes(1);
		expect(mocked.glFetch.mock.calls[0][1]).toMatchObject({
			projectPath: "acme/store",
			ref: "main",
			sincePipelineId: null,
		});
		expect(res.sourcesAttempted).toBe(1);
		expect(mocked.advance.mock.calls[0][0]).toMatchObject({
			provider: "gitlab-ci",
			pipelineKey: "acme/store",
			lastRunExternalId: "99",
		});
	});

	it("reports an unparseable ADO URL as a source error, not a crash", async () => {
		mocked.repos.mockResolvedValue([
			adoRepo({ repositoryUrl: "https://dev.azure.com/onlyorg" }),
		]);
		const res = await syncPipelineResultsForProject({ ...BASE });
		expect(mocked.fetch).not.toHaveBeenCalled();
		expect(res.errors[0].error).toMatch(/org\/project/i);
	});

	it("isolates a failing source so the others still sync", async () => {
		mocked.repos.mockResolvedValue([
			adoRepo({
				integrationId: "int-bad",
				repositoryUrl:
					"https://dev.azure.com/example-org/Bad/_git/Repo",
			}),
			adoRepo({
				integrationId: "int-good",
				repositoryUrl:
					"https://dev.azure.com/example-org/Good/_git/Repo",
			}),
		]);
		// First fetch throws, second succeeds.
		mocked.fetch
			.mockRejectedValueOnce(new Error("boom"))
			.mockResolvedValueOnce({ runs: [], newCursor: 3 });
		const res = await syncPipelineResultsForProject({ ...BASE });
		expect(res.errors).toHaveLength(1);
		expect(res.ingestedRuns).toBe(1);
		expect(mocked.advance).toHaveBeenCalledTimes(1);
		expect(mocked.advance.mock.calls[0][0]).toMatchObject({
			pipelineKey: "Good/Test-Repo",
		});
	});

	it("does NOT advance the cursor when RCA throws, so a retry re-attempts it", async () => {
		mocked.repos.mockResolvedValue([adoRepo()]);
		mocked.rca.mockRejectedValue(new Error("createStory boom"));
		const res = await syncPipelineResultsForProject({
			...BASE,
			autoCreateBugsFromFailures: true,
		});
		// RCA runs before the advance; its failure records a sync failure and
		// leaves the cursor un-advanced so the next run re-fetches + re-RCAs.
		expect(mocked.rca).toHaveBeenCalledTimes(1);
		expect(mocked.advance).not.toHaveBeenCalled();
		expect(mocked.fail).toHaveBeenCalledTimes(1);
		// Card #2383, finding 4: an RCA exception is a plain `Error` → UNKNOWN →
		// the CUSTOMER-FACING result is the generic sanitized sentence, not the
		// raw "createStory boom" text (an internal exception's message is never
		// assumed customer-safe). The raw message still reaches the logger.
		expect(res.errors[0].error).toBe(
			"Fabric hit an internal error syncing this pipeline. The error has been recorded — no action is needed from you.",
		);
		expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
			"qa.pipeline.sync.source_failed",
			expect.objectContaining({
				error: expect.stringContaining("createStory boom"),
				kind: "UNKNOWN",
			}),
		);
	});

	describe("failure classification and log level (card #2383)", () => {
		it("logs a 401 (UNAUTHENTICATED) as CREDENTIAL_REJECTED at warn, not error", async () => {
			mocked.repos.mockResolvedValue([adoRepo()]);
			mocked.fetch.mockRejectedValue(
				new ProviderHttpError({
					message:
						"Azure DevOps rejected the credential as invalid or expired.",
					kind: "UNAUTHENTICATED",
					status: 401,
					providerDetail: null,
				}),
			);

			await syncPipelineResultsForProject({ ...BASE });

			expect(mocked.fail.mock.calls[0][0]).toMatchObject({
				kind: "CREDENTIAL_REJECTED",
			});
			expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
				"qa.pipeline.sync.source_failed",
				expect.objectContaining({
					kind: "CREDENTIAL_REJECTED",
					status: 401,
				}),
			);
			expect(vi.mocked(logger.error)).not.toHaveBeenCalled();
		});

		it("logs a 403 (FORBIDDEN) as PERMISSION_MISSING at warn, not error", async () => {
			mocked.repos.mockResolvedValue([adoRepo()]);
			mocked.fetch.mockRejectedValue(
				new ProviderHttpError({
					message: "Azure DevOps refused the resource.",
					kind: "FORBIDDEN",
					status: 403,
					providerDetail: null,
				}),
			);

			await syncPipelineResultsForProject({ ...BASE });

			expect(mocked.fail.mock.calls[0][0]).toMatchObject({
				kind: "PERMISSION_MISSING",
			});
			expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
				"qa.pipeline.sync.source_failed",
				expect.objectContaining({
					kind: "PERMISSION_MISSING",
					status: 403,
				}),
			);
			expect(vi.mocked(logger.error)).not.toHaveBeenCalled();
		});

		it("classifies a resolveFreshRepoToken THROW as UNKNOWN/error, distinct from a clean absent token", async () => {
			// The latent bug this fixes: the old `catch { token = null }` could not
			// distinguish "resolution ran fine and found nothing" (the customer's
			// problem — CREDENTIAL_MISSING/warn) from "resolution itself blew up"
			// (a decryption fault, a DB error — OURS — must stay UNKNOWN/error).
			mocked.repos.mockResolvedValue([adoRepo()]);
			mocked.token.mockRejectedValue(
				new Error("decrypt failed: bad key"),
			);

			const res = await syncPipelineResultsForProject({ ...BASE });

			expect(mocked.fetch).not.toHaveBeenCalled();
			expect(mocked.fail.mock.calls[0][0]).toMatchObject({
				kind: "UNKNOWN",
			});
			// The thrown error's own message is kept (for diagnosis)...
			expect(res.errors[0].error).toMatch(/see server logs/i);
			expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
				"qa.pipeline.sync.source_failed",
				expect.objectContaining({
					kind: "UNKNOWN",
					error: expect.stringContaining("decrypt failed: bad key"),
				}),
			);
			// ...but never the token itself — nothing here ever held one.
			expect(
				vi.mocked(logger.error).mock.calls[0][1].error,
			).not.toContain("pat-123");
			expect(vi.mocked(logger.warn)).not.toHaveBeenCalled();
		});

		// Card #2383, finding 4: the sanitization rule applies to EVERY UNKNOWN
		// path, not just the ones this PR introduced — including a
		// `ProviderHttpError` whose `kind: "OTHER"` + non-404 status classifies
		// UNKNOWN (a provider 5xx, say). Its `providerDetail` is the provider's
		// own raw response body; even though `provider-http-error.ts` already
		// scrubs secrets from it, it must still never reach `lastErrorDetail` —
		// that's what the banner's "Show what the provider returned" toggle
		// reveals, and this failure is classified as OURS to investigate, not a
		// diagnostic for the customer.
		it("sanitizes BOTH lastError and lastErrorDetail for a provider 5xx that classifies UNKNOWN", async () => {
			mocked.repos.mockResolvedValue([adoRepo()]);
			mocked.fetch.mockRejectedValue(
				new ProviderHttpError({
					message: "Azure DevOps returned HTTP 500.",
					kind: "OTHER",
					status: 500,
					providerDetail:
						'{"error":"internal server misconfiguration XYZ"}',
				}),
			);

			await syncPipelineResultsForProject({ ...BASE });

			expect(mocked.fail.mock.calls[0][0]).toMatchObject({
				kind: "UNKNOWN",
				error: "Fabric hit an internal error syncing this pipeline. The error has been recorded — no action is needed from you.",
				errorDetail: null,
			});
			// The raw message AND raw provider body still reach the logger.
			expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
				"qa.pipeline.sync.source_failed",
				expect.objectContaining({
					kind: "UNKNOWN",
					error: "Azure DevOps returned HTTP 500.",
				}),
			);
		});

		it("steps an identical repeat failure down to info, without suppressing the row", async () => {
			mocked.repos.mockResolvedValue([adoRepo()]);
			mocked.fetch.mockRejectedValue(
				new ProviderHttpError({
					message:
						"Azure DevOps rejected the credential as invalid or expired.",
					kind: "UNAUTHENTICATED",
					status: 401,
					providerDetail: null,
				}),
			);
			// Simulates `recordPipelineSyncFailure` finding the PRIOR row already
			// FAILED with the same kind — i.e. this is the second (or later)
			// identical failure in a row, not a new one.
			mocked.fail.mockResolvedValue({ repeat: true, applied: true });

			await syncPipelineResultsForProject({ ...BASE });

			expect(mocked.fail).toHaveBeenCalledTimes(1);
			expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
				"qa.pipeline.sync.source_failed",
				expect.objectContaining({ kind: "CREDENTIAL_REJECTED" }),
			);
			expect(vi.mocked(logger.warn)).not.toHaveBeenCalled();
			expect(vi.mocked(logger.error)).not.toHaveBeenCalled();
		});

		it("never suppresses an UNKNOWN (our-fault) failure, even on an identical repeat", async () => {
			mocked.repos.mockResolvedValue([adoRepo()]);
			mocked.fetch.mockRejectedValue(new Error("ADO exploded again"));
			// Even though `recordPipelineSyncFailure` reports this as a repeat of
			// the same UNKNOWN kind, a genuine service fault must stay at `error`
			// on every cycle — suppressing it would hide a real outage.
			mocked.fail.mockResolvedValue({ repeat: true, applied: true });

			await syncPipelineResultsForProject({ ...BASE });

			expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
				"qa.pipeline.sync.source_failed",
				expect.objectContaining({ kind: "UNKNOWN" }),
			);
			expect(vi.mocked(logger.info)).not.toHaveBeenCalled();
			expect(vi.mocked(logger.warn)).not.toHaveBeenCalled();
		});
	});

	describe("monotonic attempt guard", () => {
		it("stamps ONE attemptStartedAt across every write the invocation makes", async () => {
			mocked.repos.mockResolvedValue([
				adoRepo({ integrationId: "int-1" }),
				adoRepo({
					integrationId: "int-2",
					repo: "Other-Repo",
					repositoryUrl:
						"https://dev.azure.com/example-org/Fabric/_git/Other-Repo",
				}),
			]);

			await syncPipelineResultsForProject({ ...BASE });

			expect(mocked.advance).toHaveBeenCalledTimes(2);
			const stamps = mocked.advance.mock.calls.map(
				(call) => call[0].attemptStartedAt,
			);
			expect(stamps[0]).toBeInstanceOf(Date);
			// One identity per ATTEMPT, not per source: the guard answers "which
			// attempt won", never "which source finished first".
			expect(stamps[0]).toBe(stamps[1]);
		});

		it("passes attemptStartedAt to the failure write too, so both writers order against the same token", async () => {
			mocked.repos.mockResolvedValue([adoRepo()]);
			mocked.fetch.mockRejectedValue(new Error("ADO 500"));

			await syncPipelineResultsForProject({ ...BASE });

			expect(
				mocked.fail.mock.calls[0][0].attemptStartedAt,
			).toBeInstanceOf(Date);
		});

		it("levels a SUPERSEDED failure write down to info and marks it stale, without dropping the row", async () => {
			// `applied: false` means a NEWER attempt already wrote this row —
			// this attempt's failure is stale, so it must not read as a fresh
			// transition into failure at `warn`.
			mocked.repos.mockResolvedValue([adoRepo()]);
			mocked.fetch.mockRejectedValue(
				new ProviderHttpError({
					message: "Azure DevOps rejected the credential.",
					kind: "UNAUTHENTICATED",
					status: 401,
					providerDetail: null,
				}),
			);
			mocked.fail.mockResolvedValue({ repeat: false, applied: false });

			await syncPipelineResultsForProject({ ...BASE });

			expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
				"qa.pipeline.sync.source_failed",
				expect.objectContaining({
					kind: "CREDENTIAL_REJECTED",
					stale: true,
				}),
			);
			expect(vi.mocked(logger.warn)).not.toHaveBeenCalled();
			expect(vi.mocked(logger.error)).not.toHaveBeenCalled();
		});

		it("still logs a SUPERSEDED UNKNOWN failure at error — a real fault happened during this attempt", async () => {
			mocked.repos.mockResolvedValue([adoRepo()]);
			mocked.fetch.mockRejectedValue(new Error("ADO exploded"));
			mocked.fail.mockResolvedValue({ repeat: false, applied: false });

			await syncPipelineResultsForProject({ ...BASE });

			expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
				"qa.pipeline.sync.source_failed",
				expect.objectContaining({ kind: "UNKNOWN", stale: true }),
			);
			expect(vi.mocked(logger.info)).not.toHaveBeenCalled();
		});

		it("omits the stale marker entirely when the write landed", async () => {
			mocked.repos.mockResolvedValue([adoRepo()]);
			mocked.fetch.mockRejectedValue(new Error("ADO exploded"));

			await syncPipelineResultsForProject({ ...BASE });

			const logged = vi.mocked(logger.error).mock.calls[0][1] as Record<
				string,
				unknown
			>;
			expect(logged).not.toHaveProperty("stale");
		});
	});

	describe("platform refresh fault is never blamed on the customer", () => {
		const rejected401 = () =>
			new ProviderHttpError({
				message: "Azure DevOps rejected the credential.",
				kind: "UNAUTHENTICATED",
				status: 401,
				providerDetail: null,
			});

		it("classifies a 401 after a MISSING_CLIENT_CREDENTIALS refresh as UNKNOWN, not CREDENTIAL_REJECTED", async () => {
			// The inversion this closes: losing the deployment's OAuth client
			// credentials makes every expired integration's refresh fail, the
			// resolver falls back to the dead stored token, the provider says
			// 401 — and blaming the customer would downgrade a platform-wide
			// outage to a per-tenant warning on every one of them at once.
			mocked.repos.mockResolvedValue([adoRepo()]);
			mocked.token.mockResolvedValue({
				token: "expired-but-returned",
				authMethod: "OAUTH",
				provider: "GITHUB",
				stale: true,
				refreshFault: "MISSING_CLIENT_CREDENTIALS",
			});
			mocked.fetch.mockRejectedValue(rejected401());

			await syncPipelineResultsForProject({ ...BASE });

			expect(mocked.fail.mock.calls[0][0]).toMatchObject({
				kind: "UNKNOWN",
			});
			expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
				"qa.pipeline.sync.source_failed",
				expect.objectContaining({
					kind: "UNKNOWN",
					refreshFault: "MISSING_CLIENT_CREDENTIALS",
					staleToken: true,
				}),
			);
			expect(vi.mocked(logger.warn)).not.toHaveBeenCalled();
		});

		it("keeps a 401 as CREDENTIAL_REJECTED when the refresh failed for a GRANT reason (no platform fault)", async () => {
			// A revoked/expired grant produces no `refreshFault`, and this 401 IS
			// the customer's to fix — the reconnect signal must survive.
			mocked.repos.mockResolvedValue([adoRepo()]);
			mocked.token.mockResolvedValue({
				token: "expired-but-returned",
				authMethod: "OAUTH",
				provider: "GITHUB",
				stale: true,
			});
			mocked.fetch.mockRejectedValue(rejected401());

			await syncPipelineResultsForProject({ ...BASE });

			expect(mocked.fail.mock.calls[0][0]).toMatchObject({
				kind: "CREDENTIAL_REJECTED",
			});
			expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
				"qa.pipeline.sync.source_failed",
				expect.objectContaining({
					kind: "CREDENTIAL_REJECTED",
					staleToken: true,
				}),
			);
			expect(vi.mocked(logger.error)).not.toHaveBeenCalled();
		});

		it("does NOT upgrade a 403 — an authenticated-but-refused resource is not explained by a failed refresh", async () => {
			mocked.repos.mockResolvedValue([adoRepo()]);
			mocked.token.mockResolvedValue({
				token: "t",
				authMethod: "OAUTH",
				provider: "GITHUB",
				refreshFault: "PROVIDER_UNAVAILABLE",
			});
			mocked.fetch.mockRejectedValue(
				new ProviderHttpError({
					message: "Azure DevOps refused the resource.",
					kind: "FORBIDDEN",
					status: 403,
					providerDetail: null,
				}),
			);

			await syncPipelineResultsForProject({ ...BASE });

			expect(mocked.fail.mock.calls[0][0]).toMatchObject({
				kind: "PERMISSION_MISSING",
			});
		});

		it("classifies a refresh fault with NO usable token left as UNKNOWN, not CREDENTIAL_MISSING", async () => {
			mocked.repos.mockResolvedValue([adoRepo()]);
			mocked.token.mockResolvedValue({
				token: null,
				authMethod: null,
				provider: null,
				credentialFault: "ABSENT",
				refreshFault: "INTERNAL",
			});

			const res = await syncPipelineResultsForProject({ ...BASE });

			expect(mocked.fetch).not.toHaveBeenCalled();
			expect(mocked.fail.mock.calls[0][0]).toMatchObject({
				kind: "UNKNOWN",
			});
			expect(res.errors[0].error).toMatch(/see server logs/i);
			expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
				"qa.pipeline.sync.source_failed",
				expect.objectContaining({ refreshFault: "INTERNAL" }),
			);
		});
	});
});
