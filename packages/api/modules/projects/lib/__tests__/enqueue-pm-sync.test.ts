import { beforeEach, describe, expect, it, vi } from "vitest";

const { mocks } = vi.hoisted(() => ({
	mocks: {
		userStoryFindFirst: vi.fn(),
		userStoryUpdate: vi.fn(),
		featureFindFirst: vi.fn(),
		featureUpdate: vi.fn(),
		epicFindFirst: vi.fn(),
		epicUpdate: vi.fn(),
		projectFindUnique: vi.fn(),
		workflowStart: vi.fn(),
		resolvePMConfigForUser: vi.fn(),
	},
}));

vi.mock("@repo/database", () => ({
	db: {
		userStory: {
			findFirst: mocks.userStoryFindFirst,
			update: mocks.userStoryUpdate,
		},
		feature: {
			findFirst: mocks.featureFindFirst,
			update: mocks.featureUpdate,
		},
		epic: {
			findFirst: mocks.epicFindFirst,
			update: mocks.epicUpdate,
		},
		project: { findUnique: mocks.projectFindUnique },
	},
	PmSyncStatus: {
		PENDING: "PENDING",
		SUCCESS: "SUCCESS",
		CONFLICT: "CONFLICT",
		FAILED: "FAILED",
	},
	resolvePMConfigForUser: mocks.resolvePMConfigForUser,
}));

vi.mock("@repo/temporal", () => ({
	getTemporalClient: vi.fn(async () => ({
		workflow: { start: mocks.workflowStart },
	})),
}));

const { enqueuePmSync } = await import("../enqueue-pm-sync");

describe("enqueuePmSync", () => {
	beforeEach(() => {
		for (const m of Object.values(mocks)) {
			(m as ReturnType<typeof vi.fn>).mockReset();
		}
		// Default: pinned configId resolves to the same id (single-user happy
		// path). Tests that exercise the per-user fallback override this.
		mocks.resolvePMConfigForUser.mockImplementation(
			async ({ configId }: { configId: string | null }) =>
				configId ? { id: configId, enabled: true } : null,
		);
	});

	it("skips enqueue when story has no externalId", async () => {
		mocks.userStoryFindFirst.mockResolvedValue({
			id: "story-1",
			externalId: null,
		});

		const result = await enqueuePmSync({
			itemId: "story-1",
			itemType: "story",
			projectId: "project-1",
			userId: "user-1",
			triggerSource: "manual-edit",
		});

		expect(result).toEqual({ enqueued: false, reason: "no-external-id" });
		expect(mocks.userStoryUpdate).not.toHaveBeenCalled();
		expect(mocks.workflowStart).not.toHaveBeenCalled();
	});

	it("skips enqueue when project has no PM config", async () => {
		mocks.userStoryFindFirst.mockResolvedValue({
			id: "story-1",
			externalId: "EXT-1",
		});
		mocks.projectFindUnique.mockResolvedValue({
			id: "project-1",
			organizationId: null,
			projectManagementMcpConfigId: null,
			projectManagementContainerId: null,
			projectManagementContainerName: null,
			projectManagementAdditionalContext: null,
		});

		const result = await enqueuePmSync({
			itemId: "story-1",
			itemType: "story",
			projectId: "project-1",
			userId: "user-1",
			triggerSource: "manual-edit",
		});

		expect(result).toEqual({ enqueued: false, reason: "no-pm-config" });
		expect(mocks.userStoryUpdate).not.toHaveBeenCalled();
		expect(mocks.workflowStart).not.toHaveBeenCalled();
	});

	it("skips enqueue silently when project is in Read-only mode", async () => {
		mocks.userStoryFindFirst.mockResolvedValue({
			id: "story-1",
			externalId: "EXT-1",
		});
		mocks.projectFindUnique.mockResolvedValue({
			id: "project-1",
			organizationId: null,
			readOnlyMode: true,
			// Fully configured PM — only the read-only flag blocks the push.
			projectManagementMcpServerId: "server-1",
			projectManagementMcpConfigId: "config-1",
			projectManagementContainerId: "container-1",
			projectManagementContainerName: "Container",
			projectManagementAdditionalContext: null,
		});

		const result = await enqueuePmSync({
			itemId: "story-1",
			itemType: "story",
			projectId: "project-1",
			userId: "user-1",
			triggerSource: "manual-edit",
		});

		expect(result).toEqual({ enqueued: false, reason: "read-only-mode" });
		// No PENDING stamp and no workflow — the skip must leave the row's
		// sync status untouched (background callers stay silent).
		expect(mocks.userStoryUpdate).not.toHaveBeenCalled();
		expect(mocks.workflowStart).not.toHaveBeenCalled();
	});

	it("marks PENDING and starts workflow when story is synced and PM is configured", async () => {
		mocks.userStoryFindFirst.mockResolvedValue({
			id: "story-1",
			externalId: "EXT-1",
		});
		mocks.projectFindUnique.mockResolvedValue({
			id: "project-1",
			organizationId: "org-1",
			projectManagementMcpServerId: "server-1",
			projectManagementMcpConfigId: "mcp-1",
			projectManagementContainerId: "container-1",
			projectManagementContainerName: "Container",
			projectManagementAdditionalContext: { key: "val" },
		});
		mocks.userStoryUpdate.mockResolvedValue({});
		mocks.workflowStart.mockResolvedValue({ workflowId: "wf-1" });

		const result = await enqueuePmSync({
			itemId: "story-1",
			itemType: "story",
			projectId: "project-1",
			userId: "user-1",
			triggerSource: "manual-edit",
		});

		expect(mocks.userStoryUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "story-1" },
				data: expect.objectContaining({
					lastPmSyncStatus: "PENDING",
				}),
			}),
		);
		expect(mocks.workflowStart).toHaveBeenCalledWith(
			"pmSyncSingleStoryWorkflow",
			expect.objectContaining({
				taskQueue: "ai-chat",
				args: [
					expect.objectContaining({
						itemId: "story-1",
						itemType: "story",
						projectId: "project-1",
						mcpConfigId: "mcp-1",
						containerId: "container-1",
						containerName: "Container",
						userId: "user-1",
						organizationId: "org-1",
						pushAnyway: false,
						triggerSource: "manual-edit",
					}),
				],
			}),
		);
		expect(result.enqueued).toBe(true);
		expect(result.workflowId).toBe("wf-1");
	});

	it("promotes a hardcoded itemType=story to bug when the row's kind is BUG", async () => {
		// Edit-triggered callers (update-story, move-story, enhance-feature,
		// etc.) enqueue with a hardcoded `itemType: "story"` regardless of kind.
		// The persisted kind is the source of truth — a BUG must reach the
		// workflow as `itemType: "bug"` so it pushes to ADO as a "Bug".
		mocks.userStoryFindFirst.mockResolvedValue({
			id: "bug-1",
			externalId: "EXT-BUG",
			kind: "BUG",
		});
		mocks.projectFindUnique.mockResolvedValue({
			id: "project-1",
			organizationId: "org-1",
			projectManagementMcpServerId: "server-1",
			projectManagementMcpConfigId: "mcp-1",
			projectManagementContainerId: "container-1",
			projectManagementContainerName: "Container",
			projectManagementAdditionalContext: null,
		});
		mocks.userStoryUpdate.mockResolvedValue({});
		mocks.workflowStart.mockResolvedValue({ workflowId: "wf-bug" });

		const result = await enqueuePmSync({
			itemId: "bug-1",
			itemType: "story",
			projectId: "project-1",
			userId: "user-1",
			triggerSource: "manual-edit",
		});

		expect(mocks.workflowStart).toHaveBeenCalledWith(
			"pmSyncSingleStoryWorkflow",
			expect.objectContaining({
				args: [expect.objectContaining({ itemType: "bug" })],
			}),
		);
		const startArg = mocks.workflowStart.mock.calls[0]?.[1] as {
			workflowId: string;
		};
		// Stable per-item workflowId (no random suffix) so Temporal can
		// de-duplicate concurrent syncs of the same item rather than run two
		// parallel CREATE paths. The bug-promotion is reflected in the id.
		expect(startArg.workflowId).toBe("pm-sync-bug-bug-1");
		const startOpts = mocks.workflowStart.mock.calls[0]?.[1] as {
			workflowIdConflictPolicy?: string;
			workflowIdReusePolicy?: string;
		};
		expect(startOpts.workflowIdConflictPolicy).toBe("USE_EXISTING");
		expect(startOpts.workflowIdReusePolicy).toBe("ALLOW_DUPLICATE");
		expect(result.enqueued).toBe(true);
	});

	it("keeps itemType=story when the row's kind is FEATURE", async () => {
		// Guard against over-promotion: only kind === "BUG" flips the type.
		mocks.userStoryFindFirst.mockResolvedValue({
			id: "story-1",
			externalId: "EXT-1",
			kind: "FEATURE",
		});
		mocks.projectFindUnique.mockResolvedValue({
			id: "project-1",
			organizationId: "org-1",
			projectManagementMcpServerId: "server-1",
			projectManagementMcpConfigId: "mcp-1",
			projectManagementContainerId: "container-1",
			projectManagementContainerName: "Container",
			projectManagementAdditionalContext: null,
		});
		mocks.userStoryUpdate.mockResolvedValue({});
		mocks.workflowStart.mockResolvedValue({ workflowId: "wf-feat" });

		await enqueuePmSync({
			itemId: "story-1",
			itemType: "story",
			projectId: "project-1",
			userId: "user-1",
			triggerSource: "manual-edit",
		});

		expect(mocks.workflowStart).toHaveBeenCalledWith(
			"pmSyncSingleStoryWorkflow",
			expect.objectContaining({
				args: [expect.objectContaining({ itemType: "story" })],
			}),
		);
	});

	it("returns temporal-error and rolls PENDING → FAILED when workflow start throws", async () => {
		mocks.userStoryFindFirst.mockResolvedValue({
			id: "story-1",
			externalId: "EXT-1",
		});
		mocks.projectFindUnique.mockResolvedValue({
			id: "project-1",
			organizationId: null,
			projectManagementMcpServerId: "server-1",
			projectManagementMcpConfigId: "mcp-1",
			projectManagementContainerId: "container-1",
			projectManagementContainerName: null,
			projectManagementAdditionalContext: null,
		});
		mocks.userStoryUpdate.mockResolvedValue({});
		mocks.workflowStart.mockRejectedValue(new Error("temporal down"));

		const result = await enqueuePmSync({
			itemId: "story-1",
			itemType: "story",
			projectId: "project-1",
			userId: "user-1",
			triggerSource: "retry",
		});

		expect(result).toEqual({ enqueued: false, reason: "temporal-error" });
		// First update writes PENDING, second writes FAILED with the error.
		expect(mocks.userStoryUpdate).toHaveBeenCalledTimes(2);
		expect(mocks.userStoryUpdate).toHaveBeenLastCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					lastPmSyncStatus: "FAILED",
					lastPmSyncError: expect.stringContaining(
						"Temporal unreachable",
					),
				}),
			}),
		);
	});

	it("legacy feature/epic itemTypes resolve to item-not-found (folder tables removed)", async () => {
		const featureResult = await enqueuePmSync({
			itemId: "feature-1",
			itemType: "feature",
			projectId: "project-1",
			userId: "user-1",
			triggerSource: "manual-edit",
		});
		const epicResult = await enqueuePmSync({
			itemId: "epic-1",
			itemType: "epic",
			projectId: "project-1",
			userId: "user-1",
			triggerSource: "manual-edit",
		});

		expect(featureResult).toEqual({
			enqueued: false,
			reason: "item-not-found",
		});
		expect(epicResult).toEqual({
			enqueued: false,
			reason: "item-not-found",
		});
		expect(mocks.userStoryFindFirst).not.toHaveBeenCalled();
		expect(mocks.workflowStart).not.toHaveBeenCalled();
	});

	it("resolves to the calling user's own MCP config when the project's pinned config belongs to a different user", async () => {
		// Project pins teammate's config; resolver finds the current user's
		// equivalent config of the same server type. Without this, the
		// workflow would receive the pinned id and immediately throw
		// "PM tool does not have required capabilities" because
		// `getMcpConfigById` filters by userId.
		mocks.userStoryFindFirst.mockResolvedValue({
			id: "story-1",
			externalId: "EXT-1",
		});
		mocks.projectFindUnique.mockResolvedValue({
			id: "project-1",
			organizationId: "org-1",
			projectManagementMcpServerId: "server-ado",
			projectManagementMcpConfigId: "mcp-pinned-by-teammate",
			projectManagementContainerId: "container-1",
			projectManagementContainerName: "Container",
			projectManagementAdditionalContext: null,
		});
		mocks.resolvePMConfigForUser.mockResolvedValue({
			id: "mcp-owned-by-current-user",
			enabled: true,
		});
		mocks.userStoryUpdate.mockResolvedValue({});
		mocks.workflowStart.mockResolvedValue({ workflowId: "wf-x" });

		const result = await enqueuePmSync({
			itemId: "story-1",
			itemType: "story",
			projectId: "project-1",
			userId: "user-current",
			triggerSource: "retry",
		});

		expect(mocks.resolvePMConfigForUser).toHaveBeenCalledWith(
			expect.objectContaining({
				configId: "mcp-pinned-by-teammate",
				mcpServerId: "server-ado",
				userId: "user-current",
				organizationId: "org-1",
			}),
		);
		expect(mocks.workflowStart).toHaveBeenCalledWith(
			"pmSyncSingleStoryWorkflow",
			expect.objectContaining({
				args: [
					expect.objectContaining({
						mcpConfigId: "mcp-owned-by-current-user",
					}),
				],
			}),
		);
		expect(result.enqueued).toBe(true);
	});

	it("stamps the row FAILED with an actionable message when a non-GitLab user has no resolvable MCP config", async () => {
		// Cross-PM visibility fix: silent return left the row with
		// pmAutoSyncEnabled=true / externalId=null forever, lying to the user
		// via the "Syncing to PM Tool" badge. The row should now show FAILED
		// with a message pointing at MCP Servers settings.
		mocks.userStoryFindFirst.mockResolvedValue({
			id: "story-1",
			externalId: "EXT-1",
		});
		mocks.projectFindUnique.mockResolvedValue({
			id: "project-1",
			organizationId: "org-1",
			projectManagementMcpServerId: "server-ado",
			projectManagementMcpConfigId: "mcp-pinned-by-teammate",
			projectManagementContainerId: "container-1",
			projectManagementContainerName: null,
			projectManagementAdditionalContext: null,
		});
		mocks.resolvePMConfigForUser.mockResolvedValue(null);

		const result = await enqueuePmSync({
			itemId: "story-1",
			itemType: "story",
			projectId: "project-1",
			userId: "user-without-own-config",
			triggerSource: "retry",
		});

		expect(result).toEqual({ enqueued: false, reason: "no-pm-config" });
		expect(mocks.userStoryUpdate).toHaveBeenCalledTimes(1);
		expect(mocks.userStoryUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "story-1" },
				data: expect.objectContaining({
					lastPmSyncStatus: "FAILED",
					lastPmSyncError: expect.stringContaining(
						"configured by another user",
					),
				}),
			}),
		);
		expect(mocks.workflowStart).not.toHaveBeenCalled();
	});

	it("stamps the row FAILED with an actionable message when the resolved config is disabled (non-GitLab)", async () => {
		mocks.userStoryFindFirst.mockResolvedValue({
			id: "story-1",
			externalId: "EXT-1",
		});
		mocks.projectFindUnique.mockResolvedValue({
			id: "project-1",
			organizationId: "org-1",
			projectManagementMcpServerId: "server-ado",
			projectManagementMcpConfigId: "mcp-1",
			projectManagementContainerId: "container-1",
			projectManagementContainerName: null,
			projectManagementAdditionalContext: null,
		});
		mocks.resolvePMConfigForUser.mockResolvedValue({
			id: "mcp-1",
			enabled: false,
		});

		const result = await enqueuePmSync({
			itemId: "story-1",
			itemType: "story",
			projectId: "project-1",
			userId: "user-1",
			triggerSource: "manual-edit",
		});

		expect(result).toEqual({ enqueued: false, reason: "no-pm-config" });
		expect(mocks.userStoryUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					lastPmSyncStatus: "FAILED",
				}),
			}),
		);
		expect(mocks.workflowStart).not.toHaveBeenCalled();
	});

	describe("GitLab REST fallback when user has no resolvable MCP config", () => {
		// The actual production failure observed on staging 2026-05-28:
		// project pins another user's GitLab MCP, the approving user has none,
		// resolvePMConfigForUser returns null. Before this fix, the function
		// silently returned and the row sat Unsynced forever. With the fix,
		// GitLab projects auto-recover via REST.
		it("routes a story through the REST path (mcpConfigId: null) when user-config is null", async () => {
			mocks.userStoryFindFirst.mockResolvedValue({
				id: "story-1",
				externalId: null,
			});
			mocks.projectFindUnique.mockResolvedValue({
				id: "project-1",
				organizationId: "org-1",
				projectManagementMcpServerId: "key:gitlab-official",
				projectManagementMcpConfigId: "mcp-pinned-by-teammate",
				projectManagementContainerId: "group/project",
				projectManagementContainerName: null,
				projectManagementAdditionalContext: null,
			});
			mocks.resolvePMConfigForUser.mockResolvedValue(null);
			mocks.userStoryUpdate.mockResolvedValue({});
			mocks.workflowStart.mockResolvedValue({
				workflowId: "wf-rest-recovered",
			});

			const result = await enqueuePmSync({
				itemId: "story-1",
				itemType: "story",
				projectId: "project-1",
				userId: "user-without-own-gitlab",
				triggerSource: "auto-push",
				forceInitialPush: true,
			});

			expect(result.enqueued).toBe(true);
			expect(mocks.workflowStart).toHaveBeenCalledWith(
				"pmSyncSingleStoryWorkflow",
				expect.objectContaining({
					args: [
						expect.objectContaining({
							itemType: "story",
							mcpConfigId: null,
							mcpServerId: "key:gitlab-official",
							containerId: "group/project",
						}),
					],
				}),
			);
		});

		it("routes a bug through the REST path when user-config is disabled", async () => {
			mocks.userStoryFindFirst.mockResolvedValue({
				id: "bug-1",
				externalId: null,
			});
			mocks.projectFindUnique.mockResolvedValue({
				id: "project-1",
				organizationId: "org-1",
				projectManagementMcpServerId: "key:gitlab-official",
				projectManagementMcpConfigId: "mcp-pinned",
				projectManagementContainerId: "group/project",
				projectManagementContainerName: null,
				projectManagementAdditionalContext: null,
			});
			mocks.resolvePMConfigForUser.mockResolvedValue({
				id: "mcp-pinned",
				enabled: false,
			});
			mocks.userStoryUpdate.mockResolvedValue({});
			mocks.workflowStart.mockResolvedValue({
				workflowId: "wf-rest-bug",
			});

			const result = await enqueuePmSync({
				itemId: "bug-1",
				itemType: "bug",
				projectId: "project-1",
				userId: "user-1",
				triggerSource: "auto-push",
				forceInitialPush: true,
			});

			expect(result.enqueued).toBe(true);
			expect(mocks.workflowStart).toHaveBeenCalledWith(
				"pmSyncSingleStoryWorkflow",
				expect.objectContaining({
					args: [
						expect.objectContaining({
							itemType: "bug",
							mcpConfigId: null,
						}),
					],
				}),
			);
		});
	});

	it("returns db-error when an unexpected DB read throws", async () => {
		mocks.userStoryFindFirst.mockRejectedValue(
			new Error("connection refused"),
		);

		const result = await enqueuePmSync({
			itemId: "story-1",
			itemType: "story",
			projectId: "project-1",
			userId: "user-1",
			triggerSource: "manual-edit",
		});

		expect(result).toEqual({ enqueued: false, reason: "db-error" });
	});

	it("starts the workflow when forceInitialPush bypasses the no-external-id short-circuit", async () => {
		// Initial-push path: a story with no externalId still
		// reaches the workflow start when the caller arms the flag, so the
		// downstream pmSyncSingleStoryWorkflow's create-then-link branch can
		// run and stamp the externalId back on the row.
		mocks.userStoryFindFirst.mockResolvedValue({
			id: "story-1",
			externalId: null,
		});
		mocks.projectFindUnique.mockResolvedValue({
			id: "project-1",
			organizationId: "org-1",
			projectManagementMcpServerId: "server-1",
			projectManagementMcpConfigId: "mcp-1",
			projectManagementContainerId: "container-1",
			projectManagementContainerName: "Container",
			projectManagementAdditionalContext: null,
		});
		mocks.userStoryUpdate.mockResolvedValue({});
		mocks.workflowStart.mockResolvedValue({ workflowId: "wf-initial" });

		const result = await enqueuePmSync({
			itemId: "story-1",
			itemType: "story",
			projectId: "project-1",
			userId: "user-1",
			triggerSource: "manual-edit",
			forceInitialPush: true,
		});

		expect(mocks.workflowStart).toHaveBeenCalled();
		expect(result.enqueued).toBe(true);
		expect(result.workflowId).toBe("wf-initial");
	});

	it("still short-circuits with no-pm-config when forceInitialPush is set but project lacks PM config", async () => {
		// The forceInitialPush flag only relaxes the no-external-id check;
		// the no-pm-config short-circuit still applies because there is
		// nowhere to push to.
		mocks.userStoryFindFirst.mockResolvedValue({
			id: "story-1",
			externalId: null,
		});
		mocks.projectFindUnique.mockResolvedValue({
			id: "project-1",
			organizationId: null,
			projectManagementMcpConfigId: null,
			projectManagementContainerId: null,
			projectManagementContainerName: null,
			projectManagementAdditionalContext: null,
		});

		const result = await enqueuePmSync({
			itemId: "story-1",
			itemType: "story",
			projectId: "project-1",
			userId: "user-1",
			triggerSource: "manual-edit",
			forceInitialPush: true,
		});

		expect(result).toEqual({ enqueued: false, reason: "no-pm-config" });
		expect(mocks.workflowStart).not.toHaveBeenCalled();
	});

	describe("GitLab REST fallback (mcpConfigId === null)", () => {
		it("enqueues the workflow with mcpConfigId: null + mcpServerId for a story", async () => {
			mocks.userStoryFindFirst.mockResolvedValue({
				id: "story-1",
				externalId: "9",
			});
			mocks.projectFindUnique.mockResolvedValue({
				id: "project-1",
				organizationId: "org-1",
				projectManagementMcpServerId: "key:gitlab-official",
				projectManagementMcpConfigId: null,
				projectManagementContainerId: "group/project",
				projectManagementContainerName: null,
				projectManagementAdditionalContext: null,
			});
			mocks.userStoryUpdate.mockResolvedValue({});
			mocks.workflowStart.mockResolvedValue({ workflowId: "wf-rest-1" });

			const result = await enqueuePmSync({
				itemId: "story-1",
				itemType: "story",
				projectId: "project-1",
				userId: "user-1",
				triggerSource: "manual-edit",
			});

			// The user-MCP-config resolver must NOT run on the REST path — there's
			// no MCPConfig to resolve.
			expect(mocks.resolvePMConfigForUser).not.toHaveBeenCalled();
			expect(mocks.workflowStart).toHaveBeenCalledWith(
				"pmSyncSingleStoryWorkflow",
				expect.objectContaining({
					args: [
						expect.objectContaining({
							itemId: "story-1",
							itemType: "story",
							mcpConfigId: null,
							mcpServerId: "key:gitlab-official",
							containerId: "group/project",
						}),
					],
				}),
			);
			expect(result.enqueued).toBe(true);
			expect(result.workflowId).toBe("wf-rest-1");
		});

		it("enqueues the workflow for a bug itemType on the REST path", async () => {
			mocks.userStoryFindFirst.mockResolvedValue({
				id: "bug-1",
				externalId: "10",
			});
			mocks.projectFindUnique.mockResolvedValue({
				id: "project-1",
				organizationId: null,
				projectManagementMcpServerId: "key:gitlab-official",
				projectManagementMcpConfigId: null,
				projectManagementContainerId: "group/project",
				projectManagementContainerName: null,
				projectManagementAdditionalContext: null,
			});
			mocks.userStoryUpdate.mockResolvedValue({});
			mocks.workflowStart.mockResolvedValue({
				workflowId: "wf-rest-bug",
			});

			const result = await enqueuePmSync({
				itemId: "bug-1",
				itemType: "bug",
				projectId: "project-1",
				userId: "user-1",
				triggerSource: "manual-edit",
			});

			expect(result.enqueued).toBe(true);
			expect(mocks.workflowStart).toHaveBeenCalledWith(
				"pmSyncSingleStoryWorkflow",
				expect.objectContaining({
					args: [
						expect.objectContaining({
							itemType: "bug",
							mcpConfigId: null,
						}),
					],
				}),
			);
		});

		it("still short-circuits for non-GitLab tools with null mcpConfigId (no REST routine)", async () => {
			// Defensive: a non-GitLab tool with a null config is an inconsistent
			// state, but we should fail closed rather than route to REST.
			mocks.userStoryFindFirst.mockResolvedValue({
				id: "story-1",
				externalId: "EXT-X",
			});
			mocks.projectFindUnique.mockResolvedValue({
				id: "project-1",
				organizationId: null,
				projectManagementMcpServerId: "key:some-other-tool",
				projectManagementMcpConfigId: null,
				projectManagementContainerId: "container-1",
				projectManagementContainerName: null,
				projectManagementAdditionalContext: null,
			});

			const result = await enqueuePmSync({
				itemId: "story-1",
				itemType: "story",
				projectId: "project-1",
				userId: "user-1",
				triggerSource: "manual-edit",
			});

			expect(result).toEqual({ enqueued: false, reason: "no-pm-config" });
			expect(mocks.workflowStart).not.toHaveBeenCalled();
		});
	});
});
