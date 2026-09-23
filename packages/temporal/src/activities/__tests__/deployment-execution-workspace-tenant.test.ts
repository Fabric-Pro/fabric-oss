/**
 * `loadDeploymentConfiguration` narrows an instance's stored `workspaceIds`
 * to the deployment's own tenant before they reach the rest of the config
 * (see the `dropped`/`allowed` handling in `../deployment-execution.ts`).
 *
 * The filter call must use the deployment ROW's own stored `userId` and
 * `organizationId` — not the caller-supplied `params` used only to fetch the
 * deployment — because instances saved before create/update bound workspaces
 * to the instance's organization can still name another organization's
 * workspace. These tests pin the call args to the row's fields and prove a
 * foreign workspace id never survives into the returned config.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getAgentDeploymentById: vi.fn(),
	filterWorkspaceIdsForTenant: vi.fn(),
	loggerInfo: vi.fn(),
	loggerWarn: vi.fn(),
	loggerError: vi.fn(),
}));

// Full mock, no `importOriginal`: loadDeploymentConfiguration only reaches
// these two functions, and loading the real barrel would boot the Prisma
// pool for a test that needs neither.
vi.mock("@repo/database", () => ({
	appendTemplateMessage: vi.fn(),
	filterWorkspaceIdsForTenant: (...args: unknown[]) =>
		mocks.filterWorkspaceIdsForTenant(...args),
	getAgentDeploymentById: (...args: unknown[]) =>
		mocks.getAgentDeploymentById(...args),
	getBuiltInToolConfig: vi.fn(),
	getTemplateConversationMessages: vi.fn(),
	updateExecutionStatus: vi.fn(),
	setAiUsageRecorder: vi.fn(),
}));

// deployment-execution.ts also imports these for its other activities.
// loadDeploymentConfiguration never touches them, but the real module chain
// (agent-execution-core -> @repo/ai -> @repo/database) would otherwise pull
// in the heavy AI/gateway provider setup this test does not need.
vi.mock("../agent-execution-core", () => ({
	buildAgentExecutionContext: vi.fn(),
	buildKnowledgeContextPrompt: vi.fn(),
	buildUserInputContext: vi.fn(),
	executeAgentTurn: vi.fn(),
	extractBuiltInToolNames: vi.fn(),
	extractMcpConfigIds: vi.fn(),
	fetchKnowledgeSources: vi.fn(),
}));

vi.mock("@repo/logs", () => ({
	logger: {
		info: mocks.loggerInfo,
		warn: mocks.loggerWarn,
		error: mocks.loggerError,
		debug: vi.fn(),
		log: vi.fn(),
	},
}));

// Import AFTER the mocks so the activity captures them.
import { loadDeploymentConfiguration } from "../deployment-execution";

// The deployment row's own tenant fields, distinct from the caller-supplied
// params used only to look up the row — proves the filter call reads the
// row, not the params.
const ROW_USER_ID = "user-row-owner";
const ROW_ORGANIZATION_ID = "org-a";

function buildDeploymentFixture(workspaceIds: string[]) {
	return {
		id: "deployment-1",
		userId: ROW_USER_ID,
		organizationId: ROW_ORGANIZATION_ID,
		instance: {
			id: "instance-1",
			name: "My Agent",
			description: null,
			customInstructions: null,
			modelOverride: null,
			modelConfig: null,
			integrationConfigurations: [],
			mcpServerConfigurations: [],
			toolConnections: {},
			workspaceIds,
			template: {
				id: "template-1",
				name: "template",
				slug: "template",
				displayName: "Template",
				description: "A template",
				instructions: null,
				suggestedModel: null,
			},
		},
	};
}

describe("loadDeploymentConfiguration workspace tenant filtering", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("filters instance.workspaceIds using the deployment row's own userId/organizationId, not the params", async () => {
		mocks.getAgentDeploymentById.mockResolvedValue(
			buildDeploymentFixture(["ws-a", "ws-b"]),
		);
		mocks.filterWorkspaceIdsForTenant.mockResolvedValue({
			allowed: ["ws-a"],
			dropped: ["ws-b"],
		});

		const config = await loadDeploymentConfiguration({
			deploymentId: "deployment-1",
			// Caller-supplied tenant, deliberately different from the row's own
			// fields above — the filter call must ignore these.
			userId: "user-param-caller",
			organizationId: "org-param-caller",
		});

		expect(mocks.getAgentDeploymentById).toHaveBeenCalledWith(
			"deployment-1",
			{ userId: "user-param-caller", organizationId: "org-param-caller" },
		);
		expect(mocks.filterWorkspaceIdsForTenant).toHaveBeenCalledWith({
			workspaceIds: ["ws-a", "ws-b"],
			userId: ROW_USER_ID,
			organizationId: ROW_ORGANIZATION_ID,
		});

		// Only the helper's `allowed` list survives into the config — the
		// foreign "ws-b" id must be absent, not merely reordered.
		expect(config?.workspaceIds).toEqual(["ws-a"]);
	});

	it("logs a warning naming the dropped workspace ids when the helper drops any", async () => {
		mocks.getAgentDeploymentById.mockResolvedValue(
			buildDeploymentFixture(["ws-a", "ws-b"]),
		);
		mocks.filterWorkspaceIdsForTenant.mockResolvedValue({
			allowed: ["ws-a"],
			dropped: ["ws-b"],
		});

		await loadDeploymentConfiguration({
			deploymentId: "deployment-1",
			userId: "user-param-caller",
			organizationId: "org-param-caller",
		});

		expect(mocks.loggerWarn).toHaveBeenCalledWith(
			expect.stringContaining("Dropping workspaces"),
			expect.objectContaining({ dropped: ["ws-b"] }),
		);
	});

	it("does not warn and keeps every workspace id when nothing is dropped", async () => {
		mocks.getAgentDeploymentById.mockResolvedValue(
			buildDeploymentFixture(["ws-a"]),
		);
		mocks.filterWorkspaceIdsForTenant.mockResolvedValue({
			allowed: ["ws-a"],
			dropped: [],
		});

		const config = await loadDeploymentConfiguration({
			deploymentId: "deployment-1",
			userId: "user-param-caller",
			organizationId: "org-param-caller",
		});

		expect(config?.workspaceIds).toEqual(["ws-a"]);
		expect(mocks.loggerWarn).not.toHaveBeenCalled();
	});
});
