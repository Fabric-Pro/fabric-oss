import { ServiceError, WorkflowNotFoundError } from "@temporalio/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mocks } = vi.hoisted(() => ({
	mocks: {
		userStoryFindFirst: vi.fn(),
		userStoryUpdate: vi.fn(),
		userStoryUpdateMany: vi.fn(),
		describe: vi.fn(),
		getTemporalClient: vi.fn(),
		featureFindFirst: vi.fn(),
		featureUpdate: vi.fn(),
		epicFindFirst: vi.fn(),
		epicUpdate: vi.fn(),
		projectFindUnique: vi.fn(),
		workflowStart: vi.fn(),
		resolvePMConfigForUser: vi.fn(),
		markPmSyncFailedUnlessPending: vi.fn(),
	},
}));

vi.mock("@repo/database", () => ({
	isGitLabPersonalMcpServerKey: (key: string | null | undefined) =>
		key === "gitlab" || key === "gitlab-official",
	db: {
		userStory: {
			findFirst: mocks.userStoryFindFirst,
			update: mocks.userStoryUpdate,
			updateMany: mocks.userStoryUpdateMany,
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
	markPmSyncFailedUnlessPending: mocks.markPmSyncFailedUnlessPending,
}));

vi.mock("@repo/temporal", () => ({
	getTemporalClient: mocks.getTemporalClient,
}));

/** A grpc-js status error, as the client's connection raises it. */
function grpcError(code: number) {
	return Object.assign(new Error(`${code} status`), {
		code,
		details: "status details",
		metadata: {},
	});
}

/** What `workflow.start` throws for a gRPC failure of the send itself. */
function startServiceError(code: number) {
	return new ServiceError("Failed to start Workflow", {
		cause: grpcError(code),
	});
}

const GRPC_INVALID_ARGUMENT = 3;
const GRPC_DEADLINE_EXCEEDED = 4;

const { enqueuePmSync } = await import("../enqueue-pm-sync");

describe("enqueuePmSync", () => {
	beforeEach(() => {
		for (const m of Object.values(mocks)) {
			(m as ReturnType<typeof vi.fn>).mockReset();
		}
		mocks.getTemporalClient.mockImplementation(async () => ({
			workflow: {
				start: mocks.workflowStart,
				getHandle: () => ({ describe: mocks.describe }),
			},
		}));
		mocks.userStoryUpdateMany.mockResolvedValue({ count: 1 });
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

	it("hands the attempt id it stamped to the workflow, so the run's writes are scoped to it", async () => {
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
			projectManagementAdditionalContext: null,
		});
		mocks.userStoryUpdate.mockResolvedValue({});
		mocks.workflowStart.mockResolvedValue({ workflowId: "wf-1" });

		await enqueuePmSync({
			itemId: "story-1",
			itemType: "story",
			projectId: "project-1",
			userId: "user-1",
			triggerSource: "manual-edit",
		});

		const stamped = mocks.userStoryUpdate.mock.calls[0]?.[0] as {
			data: { lastPmSyncAttemptId: string };
		};
		const [, options] = mocks.workflowStart.mock.calls[0] as [
			string,
			{ args: Array<Record<string, unknown>> },
		];
		expect(stamped.data.lastPmSyncAttemptId).toEqual(expect.any(String));
		expect(options.args[0]?.pmSyncAttemptId).toBe(
			stamped.data.lastPmSyncAttemptId,
		);
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

	describe("a workflow start that throws", () => {
		const PROJECT = {
			id: "project-1",
			organizationId: null,
			projectManagementMcpServerId: "server-1",
			projectManagementMcpConfigId: "mcp-1",
			projectManagementContainerId: "container-1",
			projectManagementContainerName: null,
			projectManagementAdditionalContext: null,
		};

		beforeEach(() => {
			mocks.userStoryFindFirst.mockResolvedValue({
				id: "story-1",
				externalId: "EXT-1",
			});
			mocks.projectFindUnique.mockResolvedValue(PROJECT);
			mocks.userStoryUpdate.mockResolvedValue({});
		});

		const enqueue = () =>
			enqueuePmSync({
				itemId: "story-1",
				itemType: "story",
				projectId: "project-1",
				userId: "user-1",
				triggerSource: "retry",
			});

		/** The attempt id the PENDING stamp wrote. */
		function stampedAttemptId(): string {
			const data = (
				mocks.userStoryUpdate.mock.calls[0]?.[0] as {
					data: { lastPmSyncAttemptId: string };
				}
			).data;
			return data.lastPmSyncAttemptId;
		}

		function expectFailedForThisAttempt() {
			expect(mocks.userStoryUpdateMany).toHaveBeenCalledTimes(1);
			expect(mocks.userStoryUpdateMany).toHaveBeenCalledWith({
				where: {
					id: "story-1",
					lastPmSyncAttemptId: stampedAttemptId(),
					lastPmSyncStatus: "PENDING",
				},
				data: expect.objectContaining({
					lastPmSyncStatus: "FAILED",
					lastPmSyncError: expect.stringContaining(
						"Temporal unreachable",
					),
				}),
			});
			// The FAILED write is never the unconditional by-id update.
			expect(mocks.userStoryUpdate).toHaveBeenCalledTimes(1);
		}

		it("stamps PENDING with a fresh attempt id and pending-since", async () => {
			mocks.workflowStart.mockResolvedValue({ workflowId: "wf-1" });
			await enqueue();
			const data = (
				mocks.userStoryUpdate.mock.calls[0]?.[0] as {
					data: Record<string, unknown>;
				}
			).data;
			expect(data).toMatchObject({
				lastPmSyncStatus: "PENDING",
				lastPmSyncAttemptId: expect.stringMatching(/^[0-9a-f-]{36}$/),
			});
			expect(data.pmSyncPendingSince).toEqual(data.lastPmSyncAttemptAt);
		});

		it("leaves the row PENDING and reports enqueued when the start timed out but its workflow is running", async () => {
			mocks.workflowStart.mockRejectedValue(
				startServiceError(GRPC_DEADLINE_EXCEEDED),
			);
			mocks.describe.mockResolvedValue({
				status: { name: "RUNNING" },
			});

			const result = await enqueue();

			expect(result).toEqual({
				enqueued: true,
				workflowId: "pm-sync-story-story-1",
			});
			expect(mocks.userStoryUpdateMany).not.toHaveBeenCalled();
			expect(mocks.userStoryUpdate).toHaveBeenCalledTimes(1);
		});

		it("marks this attempt FAILED when the start timed out and Temporal has no such workflow", async () => {
			mocks.workflowStart.mockRejectedValue(
				startServiceError(GRPC_DEADLINE_EXCEEDED),
			);
			mocks.describe.mockRejectedValue(
				new WorkflowNotFoundError(
					"not found",
					"pm-sync-story-story-1",
					undefined,
				),
			);

			const result = await enqueue();

			expect(result).toEqual({
				enqueued: false,
				reason: "temporal-error",
			});
			expectFailedForThisAttempt();
		});

		it("leaves the row PENDING with start-uncertain when the describe also fails", async () => {
			mocks.workflowStart.mockRejectedValue(
				startServiceError(GRPC_DEADLINE_EXCEEDED),
			);
			mocks.describe.mockRejectedValue(
				startServiceError(GRPC_DEADLINE_EXCEEDED),
			);

			const result = await enqueue();

			expect(result).toEqual({
				enqueued: false,
				reason: "start-uncertain",
				workflowId: "pm-sync-story-story-1",
			});
			expect(mocks.userStoryUpdateMany).not.toHaveBeenCalled();
		});

		it.each([
			[
				"INVALID_ARGUMENT",
				() => startServiceError(GRPC_INVALID_ARGUMENT),
			],
			["PERMISSION_DENIED", () => startServiceError(7)],
			// What an interceptor throws after the service accepted the start.
			["a plain Error", () => new Error("span exporter failed")],
		])(
			"describes before deciding when the start threw %s: running stays PENDING",
			async (_name, error) => {
				mocks.workflowStart.mockRejectedValue(error());
				mocks.describe.mockResolvedValue({
					status: { name: "RUNNING" },
				});

				const result = await enqueue();

				expect(mocks.describe).toHaveBeenCalledTimes(1);
				expect(result).toEqual({
					enqueued: true,
					workflowId: "pm-sync-story-story-1",
				});
				expect(mocks.userStoryUpdateMany).not.toHaveBeenCalled();
			},
		);

		it("marks this attempt FAILED after the describe when Temporal rejected the start as INVALID_ARGUMENT and has no such workflow", async () => {
			mocks.workflowStart.mockRejectedValue(
				startServiceError(GRPC_INVALID_ARGUMENT),
			);
			mocks.describe.mockRejectedValue(
				new WorkflowNotFoundError(
					"not found",
					"pm-sync-story-story-1",
					undefined,
				),
			);

			const result = await enqueue();

			expect(result).toEqual({
				enqueued: false,
				reason: "temporal-error",
			});
			expect(mocks.describe).toHaveBeenCalledTimes(1);
			expectFailedForThisAttempt();
		});

		it("marks this attempt FAILED when the client could not connect, before any start", async () => {
			mocks.getTemporalClient.mockRejectedValue(
				new Error("Failed to connect to Temporal Server: ECONNREFUSED"),
			);

			const result = await enqueue();

			expect(result).toEqual({
				enqueued: false,
				reason: "temporal-error",
			});
			expect(mocks.workflowStart).not.toHaveBeenCalled();
			expectFailedForThisAttempt();
		});

		it("still reports temporal-error when the FAILED write itself fails", async () => {
			mocks.workflowStart.mockRejectedValue(new Error("temporal down"));
			mocks.describe.mockRejectedValue(
				new WorkflowNotFoundError(
					"not found",
					"pm-sync-story-story-1",
					undefined,
				),
			);
			mocks.userStoryUpdateMany.mockRejectedValue(
				new Error("database unavailable"),
			);
			expect(await enqueue()).toEqual({
				enqueued: false,
				reason: "temporal-error",
			});
		});

		it("never overwrites a newer attempt's PENDING: attempt 1's compensation runs after attempt 2 stamped", async () => {
			// Attempt 1's describe finds no workflow, so it compensates.
			mocks.describe.mockRejectedValue(
				new WorkflowNotFoundError(
					"not found",
					"pm-sync-story-story-1",
					undefined,
				),
			);
			// One simulated row; the mocks apply each write's `where` the way
			// Postgres would.
			const row: Record<string, unknown> = {
				id: "story-1",
				lastPmSyncStatus: null,
				lastPmSyncAttemptId: null,
			};
			mocks.userStoryUpdate.mockImplementation(
				async (args: { data: Record<string, unknown> }) => {
					Object.assign(row, args.data);
					return { ...row };
				},
			);
			mocks.userStoryUpdateMany.mockImplementation(
				async (args: {
					where: Record<string, unknown>;
					data: Record<string, unknown>;
				}) => {
					const matches = Object.entries(args.where).every(
						([key, value]) => row[key] === value,
					);
					if (!matches) {
						return { count: 0 };
					}
					Object.assign(row, args.data);
					return { count: 1 };
				},
			);
			let attempt2Result: unknown;
			mocks.workflowStart
				// Attempt 1's start: while it is in flight, attempt 2 stamps
				// and starts; then attempt 1's start fails definitively.
				.mockImplementationOnce(async () => {
					attempt2Result = await enqueue();
					throw startServiceError(GRPC_INVALID_ARGUMENT);
				})
				.mockResolvedValueOnce({ workflowId: "pm-sync-story-story-1" });

			const attempt1Result = await enqueue();

			expect(attempt2Result).toEqual({
				enqueued: true,
				workflowId: "pm-sync-story-story-1",
			});
			expect(attempt1Result).toEqual({
				enqueued: false,
				reason: "temporal-error",
			});
			// Attempt 1's compensation ran and matched nothing.
			expect(mocks.userStoryUpdateMany).toHaveBeenCalledTimes(1);
			const attempt2Id = (
				mocks.userStoryUpdate.mock.calls[1]?.[0] as {
					data: { lastPmSyncAttemptId: string };
				}
			).data.lastPmSyncAttemptId;
			expect(row).toMatchObject({
				lastPmSyncStatus: "PENDING",
				lastPmSyncAttemptId: attempt2Id,
			});
		});
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
		// Never the by-id update: a PENDING row belongs to another user's
		// in-flight sync and must not be overwritten.
		expect(mocks.userStoryUpdate).not.toHaveBeenCalled();
		expect(mocks.markPmSyncFailedUnlessPending).toHaveBeenCalledTimes(1);
		expect(mocks.markPmSyncFailedUnlessPending).toHaveBeenCalledWith({
			itemId: "story-1",
			error: expect.stringContaining("configured by another user"),
		});
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
		expect(mocks.userStoryUpdate).not.toHaveBeenCalled();
		expect(mocks.markPmSyncFailedUnlessPending).toHaveBeenCalledWith({
			itemId: "story-1",
			error: expect.stringContaining("Failed to enqueue PM sync"),
		});
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
