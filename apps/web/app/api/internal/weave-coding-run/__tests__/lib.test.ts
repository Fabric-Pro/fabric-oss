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

import { db } from "@repo/database";
import { executeWeaveCodingRun } from "../lib";

describe("executeWeaveCodingRun", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		vi.clearAllMocks();
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
});
