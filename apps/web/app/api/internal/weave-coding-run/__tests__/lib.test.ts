import { beforeEach, describe, expect, it, vi } from "vitest";

const { transactionCodingRunFindFirst } = vi.hoisted(() => ({
	transactionCodingRunFindFirst: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		weavePlan: { findFirst: vi.fn() },
		weaveExecution: { findFirst: vi.fn() },
		codingRun: {
			findFirst: transactionCodingRunFindFirst,
			create: vi.fn(),
			update: vi.fn(),
			findUnique: vi.fn(),
		},
		organization: {
			findUnique: vi.fn(),
		},
		$transaction: vi.fn(async (callback: (tx: unknown) => unknown) =>
			callback({
				codingRun: {
					findFirst: transactionCodingRunFindFirst,
				},
			}),
		),
	},
}));

const workflowStart = vi.fn();
const workflowGetHandle = vi.fn();
vi.mock("@repo/temporal", () => ({
	getTemporalClient: vi.fn(async () => ({
		workflow: {
			start: workflowStart,
			getHandle: workflowGetHandle,
		},
	})),
}));

const createSession = vi.fn();
const sendPrompt = vi.fn();
const getSessionStatus = vi.fn();
vi.mock("@repo/temporal/coding-execution", () => ({
	getCodingExecutionProvider: vi.fn(() => ({
		createSession,
		sendPrompt,
		getSessionStatus,
	})),
}));

// The creator's live permission on the plan's project (Fizzy #2904 review):
// the real precedence is covered in packages/api; here it is the project's
// organization, or a refusal.
const { assertProjectPermission } = vi.hoisted(() => ({
	assertProjectPermission: vi.fn(),
}));
vi.mock("@repo/api/orpc/procedures", () => ({
	assertProjectPermission,
	Permissions: { AGENT_EXECUTE: "agent:execute" },
}));

import { ORPCError } from "@orpc/client";
import { db } from "@repo/database";
import { executeWeaveCodingRun } from "../lib";

describe("executeWeaveCodingRun", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		vi.clearAllMocks();
		assertProjectPermission.mockImplementation(
			async (projectId: string) => ({
				projectId,
				organizationId: "org_1",
			}),
		);
	});

	it("uses the CodingRun workflow for feature-linked plans", async () => {
		vi.mocked(db.weavePlan.findFirst).mockResolvedValue({
			id: "plan_1",
			name: "Feature plan",
			project: {
				id: "project_1",
				name: "Fabric",
				organizationId: "org_1",
				repositoryUrl: "https://github.com/acme/fabric",
				repositoryOwner: "acme",
				repositoryName: "fabric",
				defaultBranch: "main",
				implementationDefaultChannel: "BACKGROUND_AGENTS",
				implementationDefaultProvider: "BACKGROUND_AGENTS",
				implementationDefaultWorkingDirectory: null,
			},
			userStory: {
				id: "story_1",
				identifier: "FAB-101",
				title: "Ship feature",
				description: "Feature description",
				acceptanceCriteria: "- works",
			},
			storyTask: null,
		} as never);
		vi.mocked(db.organization.findUnique).mockResolvedValue({
			name: "Acme",
		} as never);
		vi.mocked(db.weaveExecution.findFirst).mockResolvedValue({
			id: "weave_exec_1",
		} as never);
		vi.mocked(db.codingRun.findFirst).mockResolvedValue(null as never);
		vi.mocked(db.codingRun.create).mockResolvedValue({
			id: "run_1",
		} as never);
		vi.mocked(db.codingRun.update).mockResolvedValue({
			id: "run_1",
		} as never);
		vi.mocked(db.codingRun.findUnique).mockResolvedValue({
			id: "run_1",
			externalUrl: "https://background-agents.example/session/1",
			pullRequestUrl: null,
		} as never);
		workflowStart.mockResolvedValue({});
		workflowGetHandle.mockReturnValue({
			result: vi.fn().mockResolvedValue({
				codingRunId: "run_1",
				status: "completed",
				pullRequestUrl: "https://github.com/acme/fabric/pull/1",
			}),
		});

		const result = await executeWeaveCodingRun({
			planId: "plan_1",
			prompt: "Implement feature",
			category: "backend",
			userId: "user_1",
			organizationId: "org_1",
			timeoutMs: 100,
		});

		expect(result.executionKind).toBe("coding_run");
		expect(result.provider).toBe("BACKGROUND_AGENTS");
		expect(result.executionChannel).toBe("BACKGROUND_AGENTS");
		expect(db.codingRun.create).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					weaveExecutionId: "weave_exec_1",
					provider: "BACKGROUND_AGENTS",
				}),
			}),
		);
		expect(workflowStart).toHaveBeenCalledWith(
			"codingRunWorkflow",
			expect.objectContaining({
				args: [
					expect.objectContaining({
						provider: "BACKGROUND_AGENTS",
					}),
				],
			}),
		);
		expect(result.pullRequestUrl).toContain("/pull/1");
	});

	it("uses direct local execution for standalone plans", async () => {
		vi.mocked(db.weavePlan.findFirst).mockResolvedValue({
			id: "plan_2",
			name: "Standalone plan",
			project: {
				id: "project_2",
				name: "Fabric",
				organizationId: null,
				repositoryUrl: "https://github.com/acme/fabric",
				repositoryOwner: "acme",
				repositoryName: "fabric",
				defaultBranch: "main",
				implementationDefaultChannel: "LOCAL_AGENTS",
				implementationDefaultProvider: "KANBAN_LOCAL",
				implementationDefaultWorkingDirectory: "/repo/fabric",
			},
			userStory: null,
			storyTask: null,
		} as never);
		createSession.mockResolvedValue({
			sessionId: "session_1",
			externalUrl: "http://127.0.0.1:3484",
		});
		sendPrompt.mockResolvedValue(undefined);
		getSessionStatus.mockResolvedValue({
			id: "session_1",
			status: "completed",
			branchName: "main",
			artifacts: [
				{
					id: "artifact_1",
					type: "pull_request",
					url: "https://github.com/acme/fabric/pull/2",
					metadata: null,
					createdAt: Date.now(),
				},
			],
		});

		const result = await executeWeaveCodingRun({
			planId: "plan_2",
			prompt: "Implement standalone feature",
			category: "backend",
			userId: "user_1",
			organizationId: null,
			timeoutMs: 6000,
		});

		expect(result.executionKind).toBe("direct_execution_session");
		expect(result.provider).toBe("KANBAN_LOCAL");
		expect(result.executionChannel).toBe("LOCAL_AGENTS");
		expect(result.providerSessionId).toBe("session_1");
		expect(result.pullRequestUrl).toContain("/pull/2");
		expect(workflowStart).not.toHaveBeenCalled();
	});

	it("rejects standalone Background Agents execution until feature-linked support exists", async () => {
		vi.mocked(db.weavePlan.findFirst).mockResolvedValue({
			id: "plan_3",
			name: "Standalone remote plan",
			project: {
				id: "project_3",
				name: "Fabric",
				organizationId: null,
				repositoryUrl: "https://github.com/acme/fabric",
				repositoryOwner: "acme",
				repositoryName: "fabric",
				defaultBranch: "main",
				implementationDefaultChannel: "BACKGROUND_AGENTS",
				implementationDefaultProvider: "BACKGROUND_AGENTS",
				implementationDefaultWorkingDirectory: null,
			},
			userStory: null,
			storyTask: null,
		} as never);

		await expect(
			executeWeaveCodingRun({
				planId: "plan_3",
				prompt: "Implement standalone feature",
				category: "backend",
				userId: "user_1",
				organizationId: null,
				timeoutMs: 100,
			}),
		).rejects.toMatchObject({
			message:
				"Background Agents currently require a feature-linked Weave plan. For standalone plans, use local development or attach the plan to a feature first.",
		});
		expect(createSession).not.toHaveBeenCalled();
		expect(workflowStart).not.toHaveBeenCalled();
	});

	it("fails fast when local development requires a repository root", async () => {
		vi.mocked(db.weavePlan.findFirst).mockResolvedValue({
			id: "plan_4",
			name: "Local plan",
			project: {
				id: "project_4",
				name: "Fabric",
				organizationId: "org_1",
				repositoryUrl: "https://github.com/acme/fabric",
				repositoryOwner: "acme",
				repositoryName: "fabric",
				defaultBranch: "main",
				implementationDefaultChannel: "LOCAL_AGENTS",
				implementationDefaultProvider: "KANBAN_LOCAL",
				implementationDefaultWorkingDirectory: null,
			},
			userStory: {
				id: "story_4",
				identifier: "FAB-104",
				title: "Local launch",
				description: null,
				acceptanceCriteria: null,
			},
			storyTask: null,
		} as never);
		vi.mocked(db.organization.findUnique).mockResolvedValue({
			name: "Acme",
		} as never);

		await expect(
			executeWeaveCodingRun({
				planId: "plan_4",
				prompt: "Implement local task",
				category: "backend",
				userId: "user_1",
				organizationId: "org_1",
				timeoutMs: 100,
			}),
		).rejects.toMatchObject({
			message:
				"Local development require a default repository root on the project before Weave can launch implementation.",
		});
	});
	// Fizzy #2904: `startExecution` runs a plan in its AUTHORIZED project's
	// organization, so the run's organization can differ from the one a
	// legacy plan was stamped with (none, for a project guest's plan).
	// Fizzy #2904 review: the service token authenticates the service, not
	// the user, and a queued delegation can run after its creator lost the
	// project. So the creator is re-authorized on the plan's project and the
	// plan held to that project's organization before anything is created.
	describe("authorizing the plan's project", () => {
		const featurePlan = (organizationId: string | null) => ({
			id: "plan_5",
			projectId: "project_5",
			name: "Feature plan",
			organizationId,
			project: {
				id: "project_5",
				name: "Fabric",
				organizationId: "org_1",
				repositoryUrl: "https://github.com/acme/fabric",
				repositoryOwner: "acme",
				repositoryName: "fabric",
				defaultBranch: "main",
				implementationDefaultChannel: "BACKGROUND_AGENTS",
				implementationDefaultProvider: "BACKGROUND_AGENTS",
				implementationDefaultWorkingDirectory: null,
			},
			userStory: {
				id: "story_5",
				identifier: "FAB-105",
				title: "Ship feature",
				description: null,
				acceptanceCriteria: null,
			},
			storyTask: null,
		});
		/** Honours the lookup's filter as the database would. */
		const storePlan = (row: ReturnType<typeof featurePlan>) =>
			vi
				.mocked(db.weavePlan.findFirst)
				.mockImplementation((async (args: {
					where: Record<string, unknown>;
				}) =>
					Object.entries(args.where).every(
						([key, value]) =>
							(key === "id" && value === "plan_5") ||
							(key === "userId" && value === "user_1") ||
							(row as Record<string, unknown>)[key] === value,
					)
						? row
						: null) as never);
		const run = (organizationId: string | null) =>
			executeWeaveCodingRun({
				planId: "plan_5",
				prompt: "Implement feature",
				category: "backend",
				userId: "user_1",
				organizationId,
				timeoutMs: 100,
			});
		const nothingCreated = () => {
			expect(db.codingRun.create).not.toHaveBeenCalled();
			expect(db.codingRun.update).not.toHaveBeenCalled();
			expect(workflowStart).not.toHaveBeenCalled();
			expect(createSession).not.toHaveBeenCalled();
		};

		beforeEach(() => {
			vi.mocked(db.organization.findUnique).mockResolvedValue({
				name: "Acme",
			} as never);
			vi.mocked(db.weaveExecution.findFirst).mockResolvedValue(null);
			transactionCodingRunFindFirst.mockResolvedValue(null);
			vi.mocked(db.codingRun.create).mockResolvedValue({
				id: "run_5",
			} as never);
			vi.mocked(db.codingRun.update).mockResolvedValue({
				id: "run_5",
			} as never);
			vi.mocked(db.codingRun.findUnique).mockResolvedValue({
				id: "run_5",
				externalUrl: null,
				pullRequestUrl: null,
			} as never);
			workflowStart.mockResolvedValue({});
			workflowGetHandle.mockReturnValue({
				result: vi.fn().mockResolvedValue({
					codingRunId: "run_5",
					status: "completed",
				}),
			});
		});

		it("loads the plan by id and creator, then checks the creator's execute permission on its project", async () => {
			storePlan(featurePlan("org_1"));
			await run("org_1");
			expect(db.weavePlan.findFirst).toHaveBeenCalledWith(
				expect.objectContaining({
					where: { id: "plan_5", userId: "user_1" },
				}),
			);
			expect(assertProjectPermission).toHaveBeenCalledWith(
				"project_5",
				"user_1",
				"agent:execute",
			);
		});

		it("runs a legacy plan with no organization in the project's organization", async () => {
			storePlan(featurePlan(null));
			await run("org_1");
			expect(db.codingRun.create).toHaveBeenCalledWith(
				expect.objectContaining({
					data: expect.objectContaining({ organizationId: "org_1" }),
				}),
			);
			const options = workflowStart.mock.calls[0]?.[1] as {
				args: Array<{ organizationId?: string }>;
			};
			expect(options.args[0]?.organizationId).toBe("org_1");
		});

		it("refuses a legacy plan under another organization, creating nothing", async () => {
			storePlan(featurePlan(null));
			await expect(run("org_other")).rejects.toMatchObject({
				message: "Weave plan not found or access denied",
			});
			nothingCreated();
		});

		it("runs a legacy plan requested with no organization in the project's organization", async () => {
			storePlan(featurePlan(null));
			await run(null).catch(() => undefined);
			// The authorized project's organization, never the request's null.
			expect(db.codingRun.create).toHaveBeenCalledWith(
				expect.objectContaining({
					data: expect.objectContaining({ organizationId: "org_1" }),
				}),
			);
		});

		it("refuses a creator who lost access to the project, creating nothing", async () => {
			storePlan(featurePlan("org_1"));
			assertProjectPermission.mockRejectedValue(
				new ORPCError("NOT_FOUND", { message: "Project not found" }),
			);
			await expect(run("org_1")).rejects.toMatchObject({
				message: "Weave plan not found or access denied",
			});
			nothingCreated();
		});

		it("refuses a plan stamped with another organization than its project's, creating nothing", async () => {
			storePlan(featurePlan("org_other"));
			await expect(run("org_other")).rejects.toMatchObject({
				message: "Weave plan not found or access denied",
			});
			nothingCreated();
		});

		describe("an execution id the caller names", () => {
			const execution = (over: Record<string, unknown> = {}) => ({
				id: "exec_5",
				planId: "plan_5",
				userId: "user_1",
				organizationId: "org_1",
				status: "RUNNING",
				...over,
			});
			/** Honours the explicit lookup's filter as the database would. */
			const storeExecution = (row: Record<string, unknown>) =>
				vi
					.mocked(db.weaveExecution.findFirst)
					.mockImplementation((async (args: {
						where: Record<string, unknown>;
					}) =>
						Object.entries(args.where).every(
							([key, value]) => row[key] === value,
						)
							? row
							: null) as never);
			const runWith = (weaveExecutionId: string) =>
				executeWeaveCodingRun({
					planId: "plan_5",
					prompt: "Implement feature",
					category: "backend",
					userId: "user_1",
					organizationId: "org_1",
					weaveExecutionId,
					timeoutMs: 100,
				});

			it.each([
				["a cancelled execution", execution({ status: "CANCELLED" })],
				["a completed execution", execution({ status: "COMPLETED" })],
				[
					"another plan's execution",
					execution({ planId: "plan_other" }),
				],
				[
					"another creator's execution",
					execution({ userId: "user_2" }),
				],
				[
					"an execution in another organization",
					execution({ organizationId: "org_other" }),
				],
			])("refuses %s, creating nothing", async (_label, row) => {
				storePlan(featurePlan("org_1"));
				storeExecution(row);
				await expect(runWith("exec_5")).rejects.toMatchObject({
					message: "Weave plan not found or access denied",
				});
				nothingCreated();
			});

			it("refuses an id that does not exist, without falling back to the lookup", async () => {
				storePlan(featurePlan("org_1"));
				storeExecution(execution());
				await expect(runWith("exec_missing")).rejects.toMatchObject({
					message: "Weave plan not found or access denied",
				});
				expect(db.weaveExecution.findFirst).toHaveBeenCalledTimes(1);
				nothingCreated();
			});

			it.each([
				["in the project's organization", "org_1"],
				["a legacy one with no organization", null],
			])("links a valid active execution %s", async (_label, org) => {
				storePlan(featurePlan("org_1"));
				storeExecution(execution({ organizationId: org }));
				await runWith("exec_5");
				expect(db.codingRun.create).toHaveBeenCalledWith(
					expect.objectContaining({
						data: expect.objectContaining({
							weaveExecutionId: "exec_5",
						}),
					}),
				);
			});
		});

		it("refuses a project with no organization, creating nothing", async () => {
			storePlan(featurePlan(null));
			assertProjectPermission.mockResolvedValue({
				projectId: "project_5",
				organizationId: null,
			});
			await expect(run(null)).rejects.toMatchObject({
				message: "Weave plan not found or access denied",
			});
			nothingCreated();
		});
	});
});
