import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/utils", () => ({
	encryptApiKey: (v: string) => `enc_${v}`,
	decryptApiKey: (v: string) => v.replace("enc_", ""),
}));

vi.mock("@repo/temporal", () => ({
	triggerMcpToolIngestion: vi.fn(),
}));

const createProjectRepo = vi.fn().mockResolvedValue({ id: "pri_1" });
const updateProjectRepo = vi.fn().mockResolvedValue({ id: "pri_1" });
// Both the canonical-key and legacy-key lookups go through this one mock;
// tests that care about the distinction set a `mockImplementation` keyed off
// the `where` clause's `repositoryName`. The default (`null`) means "no row
// exists at either key", exercising the CREATE path most tests exercise.
const findFirstProjectRepo = vi.fn().mockResolvedValue(null);
const createWorkflowIntegration = vi.fn();
const enableGitLabPM = vi
	.fn()
	.mockResolvedValue({ pmWired: true, containerId: "123" });

// The repo-access probe the callback consults before deciding the row's
// status. Default "accessible" keeps the historical expectations valid.
const verifyRepositoryAccess = vi
	.fn()
	.mockResolvedValue({ outcome: "accessible" });

vi.mock("@repo/connectors", async (importOriginal) => ({
	...(await importOriginal<typeof import("@repo/connectors")>()),
	resolveDefaultBranch: vi
		.fn()
		.mockImplementation(
			async (input: { providedBranch?: string | null }) =>
				input.providedBranch ? input.providedBranch : "main",
		),
	verifyRepositoryAccess,
}));

vi.mock("../lib/enable-gitlab-pm-for-project", () => ({
	enableGitLabPMForProject: enableGitLabPM,
}));

// `handleProjectTargetCallback` awaits this, and it was UNMOCKED — so the test
// reached the real code-indexing trigger and did network I/O. That made the test
// take tens of seconds, and work still in flight when a test finished landed on
// the shared mocks during the NEXT test, inflating their call counts. Mocking it
// is what makes this file deterministic.
vi.mock("../../projects/lib/code-indexing-trigger", () => ({
	startCodeIndexingForProject: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@repo/database", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@repo/database")>();
	const mockDb: Record<string, unknown> = {
		projectRepositoryIntegration: {
			findFirst: findFirstProjectRepo,
			upsert: vi.fn(),
			update: updateProjectRepo,
			create: createProjectRepo,
		},
		workflowIntegration: {
			findFirst: vi.fn().mockResolvedValue(null),
			create: createWorkflowIntegration,
			update: vi.fn(),
		},
		mCPConfig: { findMany: vi.fn().mockResolvedValue([]) },
		dataConnection: { updateMany: vi.fn() },
	};
	// The mock transaction runs its callback against this same `db` mock —
	// good enough for these tests, which never depend on real transactional
	// isolation, only on the create/update/findFirst call sequence a real
	// transaction would also produce.
	mockDb.$transaction = vi.fn((fn: (tx: unknown) => unknown) => fn(mockDb));
	return {
		...actual,
		db: mockDb,
		logRepoIntegrationActivity: vi.fn(),
		syncLegacyProjectRepoOnConnect: vi.fn(),
		createProjectRepoIntegration: vi.fn(),
		getProjectMemberRole: vi.fn().mockResolvedValue("admin"),
		// The callback guard's live organization check. `@repo/permissions`
		// is stubbed permissive below, so any membership row passes it.
		getOrganizationMembership: vi.fn().mockResolvedValue({
			organization: { id: "org_1" },
			role: "admin",
		}),
	};
});

vi.mock("@repo/permissions", () => ({
	hasPermission: vi.fn().mockReturnValue(true),
	Permissions: {},
	resolveProjectPermissions: vi.fn().mockReturnValue({}),
}));

vi.mock("../../../orpc/procedures", () => ({
	tenantProtectedProcedure: {
		use: vi.fn().mockReturnThis(),
		route: vi.fn().mockReturnThis(),
		input: vi.fn().mockReturnThis(),
		output: vi.fn().mockReturnThis(),
		handler: vi.fn().mockReturnThis(),
	},
	protectedProcedure: {
		use: vi.fn().mockReturnThis(),
		route: vi.fn().mockReturnThis(),
		input: vi.fn().mockReturnThis(),
		output: vi.fn().mockReturnThis(),
		handler: vi.fn().mockReturnThis(),
	},
	requireOrganizationMembership: vi.fn(),
	resolveOrganizationIdForCaller: vi.fn(),
	requirePermission: vi
		.fn()
		.mockReturnValue({ use: vi.fn().mockReturnThis() }),
	requireInputOrgPermission: vi
		.fn()
		.mockReturnValue({ use: vi.fn().mockReturnThis() }),
	Permissions: {},
}));

describe("GitLab OAuth callback — project target", () => {
	// The mocks below are module-level and were never reset, so call counts only
	// ever accumulated across tests. Any leakage read as "called twice" on an
	// assertion that expected one call.
	beforeEach(() => {
		createProjectRepo.mockClear();
		updateProjectRepo.mockClear();
		findFirstProjectRepo.mockReset().mockResolvedValue(null);
		createWorkflowIntegration.mockClear();
		enableGitLabPM.mockClear();
		verifyRepositoryAccess.mockClear();
		verifyRepositoryAccess.mockResolvedValue({ outcome: "accessible" });
	});

	it("writes encrypted token to ProjectRepositoryIntegration when targetType=project", async () => {
		const { handleProjectTargetCallback } = await import(
			"../procedures/gitlab-oauth"
		);
		await handleProjectTargetCallback({
			state: {
				userId: "u1",
				organizationId: "org_1",
				projectId: "proj_1",
				repositoryUrl: "https://gitlab.com/acme/widgets",
				repositoryOwner: "acme",
				repositoryName: "widgets",
				defaultBranch: "main",
				targetType: "project",
			},
			tokenResponse: {
				access_token: "a-token",
				refresh_token: "r-token",
				expires_in: 7200,
				token_type: "Bearer",
				scope: "api",
				created_at: 1700000000,
			},
			gitlabUser: { id: 1, username: "u", name: "U", avatar_url: "" },
		});

		expect(createProjectRepo).toHaveBeenCalledTimes(1);
		const args = createProjectRepo.mock.calls[0][0];
		expect(args.data.provider).toBe("GITLAB");
		expect(args.data.authMethod).toBe("OAUTH");
		expect(args.data.encryptedAccessToken).toBe("enc_a-token");
		expect(args.data.status).toBe("ACTIVE");
		expect(args.data.lastError).toBeNull();
		// Reconnect must hand the row a full retirement budget, not inherit
		// whatever count the previous credential accumulated.
		expect(args.data.probeFailCount).toBe(0);
	});

	// GitLab parity with the GitHub callback (Fizzy #2252 AC1): without these
	// pins, deleting the GitLab probe would pass CI.
	it("rejects a non-gitlab.com stored URL before any write or fetch (SSRF pin)", async () => {
		verifyRepositoryAccess.mockClear();
		createProjectRepo.mockClear();
		updateProjectRepo.mockClear();
		const { handleProjectTargetCallback } = await import(
			"../procedures/gitlab-oauth"
		);
		await expect(
			handleProjectTargetCallback({
				state: {
					userId: "u1",
					organizationId: "org_1",
					projectId: "proj_1",
					repositoryUrl:
						"https://internal-host.attacker.tld/acme/widgets",
					repositoryOwner: "acme",
					repositoryName: "widgets",
					defaultBranch: "main",
					targetType: "project",
				},
				tokenResponse: {
					access_token: "a-token",
					token_type: "Bearer",
					scope: "api",
				},
				gitlabUser: { id: 1, username: "u", name: "U", avatar_url: "" },
			}),
		).rejects.toMatchObject({
			message: expect.stringContaining("Only gitlab.com"),
		});
		expect(verifyRepositoryAccess).not.toHaveBeenCalled();
		expect(createProjectRepo).not.toHaveBeenCalled();
		expect(updateProjectRepo).not.toHaveBeenCalled();
	});

	it("writes REPO_UNAVAILABLE when the credential cannot see the repository (404)", async () => {
		verifyRepositoryAccess.mockResolvedValue({ outcome: "not-found" });
		const { handleProjectTargetCallback } = await import(
			"../procedures/gitlab-oauth"
		);
		await handleProjectTargetCallback({
			state: {
				userId: "u1",
				organizationId: "org_1",
				projectId: "proj_1",
				repositoryUrl: "https://gitlab.com/acme/widgets",
				repositoryOwner: "acme",
				repositoryName: "widgets",
				defaultBranch: "main",
				targetType: "project",
			},
			tokenResponse: {
				access_token: "a-token",
				token_type: "Bearer",
				scope: "api",
			},
			gitlabUser: { id: 1, username: "u", name: "U", avatar_url: "" },
		});

		const args = createProjectRepo.mock.calls[0][0];
		expect(args.data.status).toBe("REPO_UNAVAILABLE");
		expect(args.data.lastError).toMatch(/not visible/i);
	});

	it("keeps a rejected GitLab credential (401) on TOKEN_EXPIRED", async () => {
		verifyRepositoryAccess.mockResolvedValue({ outcome: "unauthorized" });
		const { handleProjectTargetCallback } = await import(
			"../procedures/gitlab-oauth"
		);
		await handleProjectTargetCallback({
			state: {
				userId: "u1",
				organizationId: "org_1",
				projectId: "proj_1",
				repositoryUrl: "https://gitlab.com/acme/widgets",
				repositoryOwner: "acme",
				repositoryName: "widgets",
				defaultBranch: "main",
				targetType: "project",
			},
			tokenResponse: {
				access_token: "a-token",
				token_type: "Bearer",
				scope: "api",
			},
			gitlabUser: { id: 1, username: "u", name: "U", avatar_url: "" },
		});

		const args = createProjectRepo.mock.calls[0][0];
		expect(args.data.status).toBe("TOKEN_EXPIRED");
	});

	it("auto-wires GitLab as the project's PM tool from the same token", async () => {
		enableGitLabPM.mockClear();
		const { handleProjectTargetCallback } = await import(
			"../procedures/gitlab-oauth"
		);
		await handleProjectTargetCallback({
			state: {
				userId: "u1",
				organizationId: "org_1",
				projectId: "proj_1",
				repositoryUrl: "https://gitlab.com/acme/widgets",
				repositoryOwner: "acme",
				repositoryName: "widgets",
				defaultBranch: "main",
				targetType: "project",
			},
			tokenResponse: {
				access_token: "a-token",
				refresh_token: "r-token",
				expires_in: 7200,
				token_type: "Bearer",
				scope: "api",
				created_at: 1700000000,
			},
			gitlabUser: { id: 1, username: "u", name: "U", avatar_url: "" },
		});

		expect(enableGitLabPM).toHaveBeenCalledTimes(1);
		const pmArgs = enableGitLabPM.mock.calls[0][0];
		expect(pmArgs.userId).toBe("u1");
		expect(pmArgs.organizationId).toBe("org_1");
		expect(pmArgs.projectId).toBe("proj_1");
		expect(pmArgs.repositoryOwner).toBe("acme");
		expect(pmArgs.repositoryName).toBe("widgets");
		expect(pmArgs.token.accessToken).toBe("a-token");
	});

	it("does not fail the repo connect when PM auto-wire throws", async () => {
		enableGitLabPM.mockRejectedValueOnce(new Error("probe failed"));
		const { handleProjectTargetCallback } = await import(
			"../procedures/gitlab-oauth"
		);
		await expect(
			handleProjectTargetCallback({
				state: {
					userId: "u1",
					organizationId: "org_1",
					projectId: "proj_1",
					repositoryUrl: "https://gitlab.com/acme/widgets",
					repositoryOwner: "acme",
					repositoryName: "widgets",
					defaultBranch: "main",
					targetType: "project",
				},
				tokenResponse: {
					access_token: "a-token",
					refresh_token: "r-token",
					expires_in: 7200,
					token_type: "Bearer",
					scope: "api",
					created_at: 1700000000,
				},
				gitlabUser: { id: 1, username: "u", name: "U", avatar_url: "" },
			}),
		).resolves.toMatchObject({ connectedStatus: "ACTIVE" });
	});

	it("persists roleTag from OAuth state to ProjectRepositoryIntegration", async () => {
		const { handleProjectTargetCallback } = await import(
			"../procedures/gitlab-oauth"
		);
		await handleProjectTargetCallback({
			state: {
				userId: "u1",
				organizationId: "org_1",
				projectId: "proj_1",
				repositoryUrl: "https://gitlab.com/acme/legacy-widgets",
				repositoryOwner: "acme",
				repositoryName: "legacy-widgets",
				defaultBranch: "main",
				roleTag: "Legacy V1",
				targetType: "project",
			},
			tokenResponse: {
				access_token: "a-token",
				token_type: "Bearer",
			},
			gitlabUser: { id: 1, username: "u", name: "U", avatar_url: "" },
		});

		expect(createProjectRepo).toHaveBeenCalledTimes(1);
		const args = createProjectRepo.mock.calls[0][0];
		expect(args.data.roleTag).toBe("Legacy V1");
	});

	// Fizzy #2662: the URL signed into `state` at OAuth start is caller-supplied
	// and was never re-validated before this write.
	it("stores the canonical form of a caller-supplied repositoryUrl (trailing .git removed)", async () => {
		const { handleProjectTargetCallback } = await import(
			"../procedures/gitlab-oauth"
		);
		await handleProjectTargetCallback({
			state: {
				userId: "u1",
				organizationId: "org_1",
				projectId: "proj_1",
				repositoryUrl: "https://gitlab.com/acme/widgets.git",
				repositoryOwner: "acme",
				repositoryName: "widgets",
				defaultBranch: "main",
				targetType: "project",
			},
			tokenResponse: {
				access_token: "a-token",
				token_type: "Bearer",
				scope: "api",
			},
			gitlabUser: { id: 1, username: "u", name: "U", avatar_url: "" },
		});

		const args = createProjectRepo.mock.calls[0][0];
		expect(args.data.repositoryUrl).toBe("https://gitlab.com/acme/widgets");
	});

	it("refuses a caller-supplied repositoryUrl carrying a query string, before writing anything", async () => {
		const { handleProjectTargetCallback } = await import(
			"../procedures/gitlab-oauth"
		);
		await expect(
			handleProjectTargetCallback({
				state: {
					userId: "u1",
					organizationId: "org_1",
					projectId: "proj_1",
					repositoryUrl: "https://gitlab.com/acme/widgets?ref=main",
					repositoryOwner: "acme",
					repositoryName: "widgets",
					defaultBranch: "main",
					targetType: "project",
				},
				tokenResponse: {
					access_token: "a-token",
					token_type: "Bearer",
					scope: "api",
				},
				gitlabUser: { id: 1, username: "u", name: "U", avatar_url: "" },
			}),
		).rejects.toMatchObject({ message: "Cannot parse repository URL" });

		expect(createProjectRepo).not.toHaveBeenCalled();
		expect(updateProjectRepo).not.toHaveBeenCalled();
	});

	// Codex follow-up on Fizzy #2662: the GitHub callback had a second gap
	// where an OMITTED `repositoryUrl` fell back to an unvalidated
	// `owner/name` template. GitLab's `state.repositoryUrl` field is
	// non-optional on `handleProjectTargetCallback`, and the fallback for a
	// caller-omitted URL is built by the outer callback procedure BEFORE this
	// function ever runs — so it lands here exactly like any other URL and
	// this function's own `parseRepoUrl(state.repositoryUrl)` already covers
	// it. This test proves that (no production code change was needed here)
	// by passing the same shape the outer procedure's fallback would build.
	it("refuses a query string carried in the owner/name fallback shape (mirrors the caller-omitted-repositoryUrl case)", async () => {
		const { handleProjectTargetCallback } = await import(
			"../procedures/gitlab-oauth"
		);
		const repositoryNameWithQuery = ["widgets", "ref=main"].join("?");
		await expect(
			handleProjectTargetCallback({
				state: {
					userId: "u1",
					organizationId: "org_1",
					projectId: "proj_1",
					repositoryUrl: `https://gitlab.com/acme/${repositoryNameWithQuery}`,
					repositoryOwner: "acme",
					repositoryName: repositoryNameWithQuery,
					defaultBranch: "main",
					targetType: "project",
				},
				tokenResponse: {
					access_token: "a-token",
					token_type: "Bearer",
					scope: "api",
				},
				gitlabUser: { id: 1, username: "u", name: "U", avatar_url: "" },
			}),
		).rejects.toMatchObject({ message: "Cannot parse repository URL" });

		expect(createProjectRepo).not.toHaveBeenCalled();
		expect(updateProjectRepo).not.toHaveBeenCalled();
	});

	// Codex follow-up on Fizzy #2662: `repositoryUrl`, `repositoryOwner`, and
	// `repositoryName` are three independent, unvalidated fields on the signed
	// state. Without this check, a state naming repository A in owner/name but
	// carrying a URL for repository B would probe and store a row for A using
	// B's URL — a mismatch nothing upstream catches. GitLab paths are
	// case-sensitive, so the comparison here is exact.
	it("refuses when repositoryUrl names a different repository than repositoryOwner/repositoryName", async () => {
		const { handleProjectTargetCallback } = await import(
			"../procedures/gitlab-oauth"
		);
		await expect(
			handleProjectTargetCallback({
				state: {
					userId: "u1",
					organizationId: "org_1",
					projectId: "proj_1",
					repositoryUrl: "https://gitlab.com/other-org/other-repo",
					repositoryOwner: "acme",
					repositoryName: "widgets",
					defaultBranch: "main",
					targetType: "project",
				},
				tokenResponse: {
					access_token: "a-token",
					token_type: "Bearer",
					scope: "api",
				},
				gitlabUser: { id: 1, username: "u", name: "U", avatar_url: "" },
			}),
		).rejects.toMatchObject({
			message: "Repository URL does not match the selected repository",
		});

		expect(createProjectRepo).not.toHaveBeenCalled();
		expect(updateProjectRepo).not.toHaveBeenCalled();
		expect(verifyRepositoryAccess).not.toHaveBeenCalled();
	});

	// Codex round-2 follow-up on Fizzy #2662: the GitLab project picker
	// (packages/api/modules/projects/procedures/gitlab/list-projects.ts)
	// sends `repositoryName` as GitLab's `path_with_namespace`, which already
	// repeats the owner — for a project in "group/subgroup", the picker's
	// `owner` is "group/subgroup" and its `name` is "group/subgroup/repo",
	// not the bare slug "repo". The exact-match mismatch check above would
	// refuse every picker selection outright, and a state minted before this
	// fix (or hand-built the same way) must still reconnect correctly rather
	// than being refused. This proves both: the legacy shape is accepted,
	// and the probe/stored row get the bare owner/name pair — not the
	// doubled path — because `probeGitLab` builds its GitLab API path as
	// `${owner}/${repo}`, which a doubled name would corrupt into
	// "group/subgroup/group/subgroup/repo".
	it("accepts the picker's legacy full-path repositoryName and normalizes to the bare owner/name pair everywhere", async () => {
		const { handleProjectTargetCallback } = await import(
			"../procedures/gitlab-oauth"
		);
		await handleProjectTargetCallback({
			state: {
				userId: "u1",
				organizationId: "org_1",
				projectId: "proj_1",
				repositoryUrl: "https://gitlab.com/group/subgroup/repo",
				repositoryOwner: "group/subgroup",
				repositoryName: "group/subgroup/repo",
				defaultBranch: "main",
				targetType: "project",
			},
			tokenResponse: {
				access_token: "a-token",
				token_type: "Bearer",
				scope: "api",
			},
			gitlabUser: { id: 1, username: "u", name: "U", avatar_url: "" },
		});

		expect(verifyRepositoryAccess).toHaveBeenCalledTimes(1);
		expect(verifyRepositoryAccess).toHaveBeenCalledWith(
			expect.objectContaining({ owner: "group/subgroup", repo: "repo" }),
		);
		// Neither the canonical nor the legacy key had an existing row (the
		// mock's default `findFirst` resolves null for both lookups), so this
		// creates fresh — both lookups are asserted so this test also proves
		// the exact `where` shapes the transaction checks.
		expect(findFirstProjectRepo).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					repositoryOwner: "group/subgroup",
					repositoryName: "repo",
				}),
			}),
		);
		expect(findFirstProjectRepo).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					repositoryOwner: "group/subgroup",
					repositoryName: "group/subgroup/repo",
				}),
			}),
		);
		expect(createProjectRepo).toHaveBeenCalledTimes(1);
		expect(updateProjectRepo).not.toHaveBeenCalled();
		const args = createProjectRepo.mock.calls[0][0];
		expect(args.data.repositoryOwner).toBe("group/subgroup");
		expect(args.data.repositoryName).toBe("repo");
		expect(args.data.repositoryUrl).toBe(
			"https://gitlab.com/group/subgroup/repo",
		);
	});

	// Codex round-3 follow-up on Fizzy #2662: a plain upsert keys on the
	// CANONICAL [projectId, provider, repositoryOwner, repositoryName], which
	// never matches a row a picker created (or last reconnected) before this
	// fix — those are stored under the LEGACY doubled name. Reconnecting one
	// must UPDATE it in place (same id, canonical owner/name/url), never
	// create a second row alongside it.
	it("migrates a legacy-shaped row to the canonical name in place on reconnect, instead of creating a duplicate", async () => {
		findFirstProjectRepo.mockImplementation(
			async ({ where }: { where: { repositoryName: string } }) =>
				where.repositoryName === "group/subgroup/repo"
					? { id: "pri_legacy_original" }
					: null,
		);

		const { handleProjectTargetCallback } = await import(
			"../procedures/gitlab-oauth"
		);
		await handleProjectTargetCallback({
			state: {
				userId: "u1",
				organizationId: "org_1",
				projectId: "proj_1",
				repositoryUrl: "https://gitlab.com/group/subgroup/repo",
				repositoryOwner: "group/subgroup",
				repositoryName: "group/subgroup/repo",
				defaultBranch: "main",
				targetType: "project",
			},
			tokenResponse: {
				access_token: "a-token",
				token_type: "Bearer",
				scope: "api",
			},
			gitlabUser: { id: 1, username: "u", name: "U", avatar_url: "" },
		});

		expect(createProjectRepo).not.toHaveBeenCalled();
		expect(updateProjectRepo).toHaveBeenCalledTimes(1);
		const [updateArgs] = updateProjectRepo.mock.calls[0];
		expect(updateArgs.where).toEqual({ id: "pri_legacy_original" });
		expect(updateArgs.data.repositoryOwner).toBe("group/subgroup");
		expect(updateArgs.data.repositoryName).toBe("repo");
		expect(updateArgs.data.repositoryUrl).toBe(
			"https://gitlab.com/group/subgroup/repo",
		);
	});

	// The rarer case: a legacy row was reconnected once while the OLD
	// exact-match bug was live, which — since it never found the legacy row
	// — created a second, canonical-named row alongside it. Reconnecting
	// again must update the canonical row and leave the legacy one alone;
	// this is not the place to delete data that might still be referenced.
	it("updates the canonical row and leaves a coexisting legacy row untouched when both exist", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		findFirstProjectRepo.mockImplementation(
			async ({ where }: { where: { repositoryName: string } }) => {
				if (where.repositoryName === "repo") {
					return { id: "pri_canonical" };
				}
				if (where.repositoryName === "group/subgroup/repo") {
					return { id: "pri_legacy_leftover" };
				}
				return null;
			},
		);

		const { handleProjectTargetCallback } = await import(
			"../procedures/gitlab-oauth"
		);
		await handleProjectTargetCallback({
			state: {
				userId: "u1",
				organizationId: "org_1",
				projectId: "proj_1",
				repositoryUrl: "https://gitlab.com/group/subgroup/repo",
				repositoryOwner: "group/subgroup",
				repositoryName: "group/subgroup/repo",
				defaultBranch: "main",
				targetType: "project",
			},
			tokenResponse: {
				access_token: "a-token",
				token_type: "Bearer",
				scope: "api",
			},
			gitlabUser: { id: 1, username: "u", name: "U", avatar_url: "" },
		});

		expect(createProjectRepo).not.toHaveBeenCalled();
		expect(updateProjectRepo).toHaveBeenCalledTimes(1);
		const [updateArgs] = updateProjectRepo.mock.calls[0];
		expect(updateArgs.where).toEqual({ id: "pri_canonical" });
		// The canonical-row update path only applies credential fields — it
		// must not also try to rewrite repositoryOwner/repositoryName/Url,
		// unlike the legacy-migration path above.
		expect(updateArgs.data.repositoryOwner).toBeUndefined();
		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringContaining("pri_canonical"),
		);
		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringContaining("pri_legacy_leftover"),
		);
		warnSpy.mockRestore();
	});

	// Codex round-3 item 4: `repositoryUrl` is optional on this function's
	// state (a legacy in-flight state minted before OAuth start always sent
	// it may omit it). `resolveProjectRepositoryIdentity` must build its own
	// fallback candidate from `repositoryOwner`/`repositoryName` — and,
	// because this state uses the legacy picker shape (name already carries
	// the owner prefix), must build `https://gitlab.com/group/subgroup/repo`,
	// NOT the doubled `https://gitlab.com/group/subgroup/group/subgroup/repo`
	// a naive `${owner}/${name}` concatenation would produce.
	it("builds the correct non-doubled candidate URL for a URL-less legacy-shaped state", async () => {
		const { handleProjectTargetCallback } = await import(
			"../procedures/gitlab-oauth"
		);
		await handleProjectTargetCallback({
			state: {
				userId: "u1",
				organizationId: "org_1",
				projectId: "proj_1",
				repositoryUrl: undefined,
				repositoryOwner: "group/subgroup",
				repositoryName: "group/subgroup/repo",
				defaultBranch: "main",
				targetType: "project",
			},
			tokenResponse: {
				access_token: "a-token",
				token_type: "Bearer",
				scope: "api",
			},
			gitlabUser: { id: 1, username: "u", name: "U", avatar_url: "" },
		});

		expect(verifyRepositoryAccess).toHaveBeenCalledWith(
			expect.objectContaining({
				repositoryUrl: "https://gitlab.com/group/subgroup/repo",
				owner: "group/subgroup",
				repo: "repo",
			}),
		);
		expect(createProjectRepo).toHaveBeenCalledTimes(1);
		expect(createProjectRepo.mock.calls[0][0].data.repositoryUrl).toBe(
			"https://gitlab.com/group/subgroup/repo",
		);
	});
});
