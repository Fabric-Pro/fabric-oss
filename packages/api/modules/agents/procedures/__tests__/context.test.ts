import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Hoisted mocks ────────────────────────────────────────────────────────────

const {
	handlersByPath,
	mockProjectFindFirst,
	mockStatusFindMany,
	mockUserStoryFindMany,
	mockDocumentFindMany,
	mockCodingRunFindMany,
	mockCountArchitectureDecisionsByStatus,
	mockListDecisionLogThreads,
	mockGetLatestProjectScan,
	mockScanFindingCount,
	mockHasProjectAccess,
} = vi.hoisted(() => ({
	handlersByPath: new Map<string, (args: unknown) => unknown>(),
	mockProjectFindFirst: vi.fn(),
	mockStatusFindMany: vi.fn(),
	mockUserStoryFindMany: vi.fn(),
	mockDocumentFindMany: vi.fn(),
	mockCodingRunFindMany: vi.fn(),
	mockCountArchitectureDecisionsByStatus: vi.fn(),
	mockListDecisionLogThreads: vi.fn(),
	mockGetLatestProjectScan: vi.fn(),
	mockScanFindingCount: vi.fn(),
	mockHasProjectAccess: vi.fn(),
}));

vi.mock("@repo/database/prisma/client", () => ({
	db: {
		project: { findFirst: (...a: unknown[]) => mockProjectFindFirst(...a) },
		projectStoryStatus: {
			findMany: (...a: unknown[]) => mockStatusFindMany(...a),
		},
		userStory: {
			findMany: (...a: unknown[]) => mockUserStoryFindMany(...a),
			findFirst: vi.fn(),
		},
		projectDocument: {
			findMany: (...a: unknown[]) => mockDocumentFindMany(...a),
		},
		codingRun: {
			findMany: (...a: unknown[]) => mockCodingRunFindMany(...a),
		},
		scanFinding: {
			count: (...a: unknown[]) => mockScanFindingCount(...a),
		},
		storyTask: { findFirst: vi.fn() },
	},
}));

vi.mock("@repo/database/prisma/queries/projects/projects", () => ({
	hasProjectAccess: (...a: unknown[]) => mockHasProjectAccess(...a),
}));

vi.mock(
	"@repo/database/prisma/queries/projects/architecture-decisions",
	() => ({
		countArchitectureDecisionsByStatus: (...a: unknown[]) =>
			mockCountArchitectureDecisionsByStatus(...a),
	}),
);

vi.mock("@repo/database/prisma/queries/feature-maturation", () => ({
	listDecisionLogThreads: (...a: unknown[]) =>
		mockListDecisionLogThreads(...a),
}));

vi.mock("@repo/database/prisma/queries/projects/scan", () => ({
	getLatestProjectScan: (...a: unknown[]) => mockGetLatestProjectScan(...a),
}));

vi.mock("../../../../orpc/procedures", () => {
	function makeChainable() {
		const c: Record<string, unknown> = {};
		let routePath: string | undefined;
		Object.assign(c, {
			use: () => c,
			route: (route: { path: string }) => {
				routePath = route.path;
				return c;
			},
			input: () => c,
			handler: (fn: (args: unknown) => unknown) => {
				if (!routePath) {
					throw new Error(
						"Procedure handler registered without a route path",
					);
				}
				handlersByPath.set(routePath, fn);
				return { _handler: fn };
			},
		});
		return c;
	}
	return {
		get tenantProtectedProcedure() {
			return makeChainable();
		},
		Permissions: { PROJECT_READ: "PROJECT_READ", STORY_READ: "STORY_READ" },
		requireProjectPermission: () => (c: unknown) => c,
		resolveOrganizationId: (
			input: string | null | undefined,
			session: { activeOrganizationId?: string | null },
		) => input ?? session.activeOrganizationId ?? null,
	};
});

// Import AFTER mocks so vi.mock hoisting applies and handlers[] is populated.
import "../context";

describe("getAgentProjectContext — architecture decisions risk signal", () => {
	const baseContext = {
		user: { id: "user_1" },
		session: { activeOrganizationId: null },
	};

	beforeEach(() => {
		vi.clearAllMocks();
		mockHasProjectAccess.mockResolvedValue(true);
		mockProjectFindFirst.mockResolvedValue({
			id: "project_1",
			name: "Fabric",
			description: "desc",
			goals: "goals",
			status: "ACTIVE",
			tags: [],
			repositoryUrl: null,
			repositoryOwner: null,
			repositoryName: null,
			defaultBranch: null,
			updatedAt: new Date("2024-01-01"),
			createdAt: new Date("2024-01-01"),
			organizationId: null,
		});
		mockStatusFindMany.mockResolvedValue([]);
		mockUserStoryFindMany.mockResolvedValue([]);
		mockDocumentFindMany.mockResolvedValue([]);
		mockCodingRunFindMany.mockResolvedValue([]);
		mockCountArchitectureDecisionsByStatus.mockResolvedValue({
			total: 0,
			proposed: 0,
		});
		mockListDecisionLogThreads.mockResolvedValue([]);
		mockGetLatestProjectScan.mockResolvedValue(null);
		mockScanFindingCount.mockResolvedValue(0);
	});

	function callProjectHandler(input: Record<string, unknown> = {}) {
		const handler = handlersByPath.get(
			"/agents/context/project/{projectId}",
		);
		if (!handler) {
			throw new Error("getAgentProjectContext handler was not captured");
		}
		return handler({
			input: { projectId: "project_1", organizationId: null, ...input },
			context: baseContext,
		});
	}

	it("adds an architecture_decisions risk signal when decisions are recorded", async () => {
		mockCountArchitectureDecisionsByStatus.mockResolvedValue({
			total: 3,
			proposed: 2,
		});

		const result = (await callProjectHandler()) as {
			riskSignals: Array<{
				type: string;
				severity: string;
				sourceId: string;
				sourceLabel: string;
				message: string;
			}>;
		};

		const signal = result.riskSignals.find(
			(s) => s.type === "architecture_decisions",
		);

		expect(signal).toBeDefined();
		expect(signal).toMatchObject({
			type: "architecture_decisions",
			severity: "medium",
			sourceId: "decisions-tab",
			sourceLabel: "Decisions tab",
		});
		expect(signal?.message).toContain(
			"3 architecture decision(s) recorded",
		);
		expect(signal?.message).toContain("2 are PROPOSED (awaiting review)");
		expect(signal?.message).toContain(
			"Use fabric_list_architecture_decisions to read them.",
		);

		expect(mockCountArchitectureDecisionsByStatus).toHaveBeenCalledWith(
			"project_1",
		);
	});

	it("omits the PROPOSED sentence when no decisions are pending review", async () => {
		mockCountArchitectureDecisionsByStatus.mockResolvedValue({
			total: 2,
			proposed: 0,
		});

		const result = (await callProjectHandler()) as {
			riskSignals: Array<{ type: string; message: string }>;
		};

		const signal = result.riskSignals.find(
			(s) => s.type === "architecture_decisions",
		);

		expect(signal).toBeDefined();
		expect(signal?.message).not.toContain("PROPOSED");
	});

	it("does not add the risk signal when there are no recorded decisions", async () => {
		mockCountArchitectureDecisionsByStatus.mockResolvedValue({
			total: 0,
			proposed: 0,
		});

		const result = (await callProjectHandler()) as {
			riskSignals: Array<{ type: string }>;
		};

		expect(
			result.riskSignals.find((s) => s.type === "architecture_decisions"),
		).toBeUndefined();
	});

	it("does not add the risk signal when decision counts resolve null", async () => {
		mockCountArchitectureDecisionsByStatus.mockResolvedValue(null);

		const result = (await callProjectHandler()) as {
			riskSignals: Array<{ type: string }>;
		};

		expect(
			result.riskSignals.find((s) => s.type === "architecture_decisions"),
		).toBeUndefined();
	});

	it("uses the live open high-severity finding count for the security signal", async () => {
		mockGetLatestProjectScan.mockResolvedValue({
			id: "scan_1",
			securityFindingCount: 99,
		});
		mockScanFindingCount.mockResolvedValue(2);

		const result = (await callProjectHandler()) as {
			riskSignals: Array<{
				type: string;
				sourceId: string;
				message: string;
			}>;
		};

		const signal = result.riskSignals.find(
			(s) => s.type === "security_findings",
		);

		expect(signal).toMatchObject({
			type: "security_findings",
			sourceId: "scan_1",
		});
		expect(signal?.message).toContain(
			"2 open high-severity security findings",
		);
		expect(signal?.message).not.toContain("99");
		expect(mockScanFindingCount).toHaveBeenCalledWith({
			where: {
				scanId: "scan_1",
				projectId: "project_1",
				project: { organizationId: null },
				category: "SECURITY",
				status: "OPEN",
				severity: { in: ["CRITICAL", "HIGH"] },
			},
		});
	});

	it("omits the security signal when all findings have been triaged", async () => {
		mockGetLatestProjectScan.mockResolvedValue({
			id: "scan_1",
			securityFindingCount: 12,
		});
		mockScanFindingCount.mockResolvedValue(0);

		const result = (await callProjectHandler()) as {
			riskSignals: Array<{ type: string }>;
		};

		expect(
			result.riskSignals.find((s) => s.type === "security_findings"),
		).toBeUndefined();
	});

	it("adds a feature_decisions risk signal on feature context when Decision Log threads exist", async () => {
		mockUserStoryFindMany.mockResolvedValue([
			{
				id: "story_1",
				identifier: "F-001",
				title: "Example Feature",
				description: null,
				acceptanceCriteria: null,
				priority: null,
				size: null,
				storyPoints: null,
				labels: [],
				draftingStage: null,
				assigneeId: null,
				externalUrl: null,
				createdAt: new Date("2024-01-01"),
				updatedAt: new Date("2024-01-01"),
				status: {
					id: "status_1",
					name: "Todo",
					isFinal: false,
					requiresApproval: false,
				},
				tasks: [],
			},
		]);
		mockListDecisionLogThreads.mockResolvedValue([
			{ root: { status: "OPEN" } },
			{ root: { status: "RESOLVED" } },
		]);

		const featureHandler = handlersByPath.get(
			"/agents/context/project/{projectId}/feature/{storyId}",
		);
		if (!featureHandler) {
			throw new Error("getAgentFeatureContext handler was not captured");
		}

		const result = (await featureHandler({
			input: {
				projectId: "project_1",
				organizationId: null,
				storyId: "story_1",
			},
			context: baseContext,
		})) as {
			riskSignals: Array<{
				type: string;
				sourceId: string;
				sourceLabel: string;
				message: string;
			}>;
		};

		const signal = result.riskSignals.find(
			(s) => s.type === "feature_decisions",
		);
		expect(signal).toBeDefined();
		expect(signal).toMatchObject({
			type: "feature_decisions",
			sourceId: "story_1",
			sourceLabel: "F-001 Decisions tab",
		});
		expect(signal?.message).toContain(
			"2 feature decision thread(s) recorded",
		);
		expect(signal?.message).toContain("1 remain unresolved");
		expect(signal?.message).toContain("fabric_list_feature_decisions");

		expect(mockListDecisionLogThreads).toHaveBeenCalledWith({
			tenantFilter: { userId: "user_1", organizationId: null },
			userStoryId: "story_1",
		});
	});

	it("uses the organization resolved from the active session for decision threads", async () => {
		mockUserStoryFindMany.mockResolvedValue([
			{
				id: "story_1",
				identifier: "F-001",
				title: "Example Feature",
				description: null,
				acceptanceCriteria: null,
				priority: null,
				size: null,
				storyPoints: null,
				labels: [],
				draftingStage: null,
				assigneeId: null,
				externalUrl: null,
				createdAt: new Date("2024-01-01"),
				updatedAt: new Date("2024-01-01"),
				status: {
					id: "status_1",
					name: "Todo",
					isFinal: false,
					requiresApproval: false,
				},
				tasks: [],
			},
		]);
		mockCountArchitectureDecisionsByStatus.mockResolvedValue({
			total: 0,
			proposed: 0,
		});
		const featureHandler = handlersByPath.get(
			"/agents/context/project/{projectId}/feature/{storyId}",
		);
		if (!featureHandler) {
			throw new Error("getAgentFeatureContext handler was not captured");
		}

		await featureHandler({
			input: { projectId: "project_1", storyId: "story_1" },
			context: {
				...baseContext,
				session: { activeOrganizationId: "org_1" },
			},
		});

		expect(mockListDecisionLogThreads).toHaveBeenCalledWith({
			tenantFilter: { userId: "user_1", organizationId: "org_1" },
			userStoryId: "story_1",
		});
	});

	it("skips project-level decision and security queries for task context", async () => {
		mockUserStoryFindMany.mockResolvedValue([
			{
				id: "story_1",
				identifier: "F-001",
				title: "Example Feature",
				description: null,
				acceptanceCriteria: null,
				priority: null,
				size: null,
				storyPoints: null,
				labels: [],
				draftingStage: null,
				assigneeId: null,
				externalUrl: null,
				createdAt: new Date("2024-01-01"),
				updatedAt: new Date("2024-01-01"),
				status: {
					id: "status_1",
					name: "Todo",
					isFinal: false,
					requiresApproval: false,
				},
				tasks: [
					{
						id: "task_1",
						identifier: "T-001",
						title: "Example Task",
						isCompleted: false,
						agentStatus: null,
						agentError: null,
						artifactUrl: null,
						repositoryUrl: null,
						updatedAt: new Date("2024-01-01"),
					},
				],
			},
		]);
		const taskHandler = handlersByPath.get(
			"/agents/context/project/{projectId}/feature/{storyId}/task/{taskId}",
		);
		if (!taskHandler) {
			throw new Error("getAgentTaskContext handler was not captured");
		}

		await taskHandler({
			input: {
				projectId: "project_1",
				organizationId: null,
				storyId: "story_1",
				taskId: "task_1",
			},
			context: baseContext,
		});

		expect(mockCountArchitectureDecisionsByStatus).not.toHaveBeenCalled();
		expect(mockGetLatestProjectScan).not.toHaveBeenCalled();
		expect(mockScanFindingCount).not.toHaveBeenCalled();
	});
});
