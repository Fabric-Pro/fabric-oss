import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeParlumeMeetingTurn } from "../parlume";

const mocks = vi.hoisted(() => ({
	turn: vi.fn(),
	updateTurn: vi.fn(),
	updateSession: vi.fn(),
	agent: vi.fn(),
	hasAccess: vi.fn(),
	context: vi.fn(),
	project: vi.fn(),
	retrieve: vi.fn(),
	execute: vi.fn(),
	speak: vi.fn(),
	stop: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		parlumeMeetingTurn: {
			findUnique: mocks.turn,
			findMany: vi.fn(async () => []),
			update: mocks.updateTurn,
		},
		parlumeMeetingSession: { updateMany: mocks.updateSession },
		parlumeMeetingSegment: {
			findMany: vi.fn(async () => [
				{ text: "Meeting context", speakerName: null },
			]),
		},
		agentTemplateInstance: { findFirst: mocks.agent },
		$transaction: (operations: Promise<unknown>[]) =>
			Promise.all(operations),
	},
	hasProjectAccess: mocks.hasAccess,
	getBuiltInToolConfig: vi.fn(),
}));
vi.mock("@repo/logs", () => ({ logger: { error: vi.fn() } }));
vi.mock("../agent-execution-core", () => ({ executeAgentTurn: mocks.execute }));
vi.mock("../deployment-execution", () => ({
	buildExecutionContext: mocks.context,
}));
vi.mock("../parlume-voice", () => ({
	speakParlumeResponse: mocks.speak,
	requestParlumeMeetingStop: mocks.stop,
}));
vi.mock("../project-metadata", () => ({
	retrieveProjectContextsActivity: mocks.retrieve,
}));
vi.mock("../shared/project-context-block", () => ({
	buildProjectContextBlock: mocks.project,
}));

function turn(agentKind = "FABRIC_AGENT") {
	return {
		id: "example-turn",
		status: "PENDING",
		requestText: "What is the project plan?",
		session: {
			id: "example-session",
			projectId: "example-project",
			organizationId: "example-org",
			userId: "example-user",
			agentKind,
			agentInstanceSId:
				agentKind === "FABRIC_AGENT" ? null : "example-agent",
			agentInstanceVersionId:
				agentKind === "FABRIC_AGENT" ? null : "example-version",
			agentInstanceVersion: agentKind === "FABRIC_AGENT" ? null : 1,
			status: "ACTIVE",
			toolsReadOnly: true,
		},
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.turn.mockResolvedValue(turn());
	mocks.hasAccess.mockResolvedValue(true);
	mocks.project.mockResolvedValue("Project instructions");
	mocks.retrieve.mockResolvedValue({ context: "Project knowledge" });
	mocks.execute.mockResolvedValue({
		success: true,
		response: "The project plan.",
	});
});

describe("Parlume agent selection at execution", () => {
	it("runs the built-in agent with project context and tenant model selection", async () => {
		await executeParlumeMeetingTurn({ turnId: "example-turn" });
		expect(mocks.agent).not.toHaveBeenCalled();
		expect(mocks.context).not.toHaveBeenCalled();
		expect(mocks.retrieve).toHaveBeenCalledWith(
			"What is the project plan?",
			"example-project",
			"example-user",
			"example-org",
			6,
		);
		expect(mocks.execute).toHaveBeenCalledWith(
			expect.objectContaining({
				systemPrompt: expect.stringContaining(
					"You are Fabric Agent.\n\nProject instructions",
				),
				knowledgeContext: expect.stringContaining(
					"Project knowledge\n\n## Recent meeting transcript\nMeeting context",
				),
				model: undefined,
				agentInstanceId: undefined,
				callingAgentId: undefined,
				projectId: "example-project",
				organizationId: "example-org",
				userId: "example-user",
				mcpConfigIds: [],
				integrationConfigurations: [],
				meetingReadOnly: true,
			}),
		);
		expect(mocks.speak).toHaveBeenCalledWith(
			expect.objectContaining({ response: "The project plan." }),
		);
		expect(mocks.updateTurn).toHaveBeenLastCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ status: "COMPLETED" }),
			}),
		);
	});

	it.each(["FABRIC_AGENT", "TEMPLATE_INSTANCE"])(
		"stops %s before loading context after access is revoked",
		async (kind) => {
			mocks.turn.mockResolvedValue(turn(kind));
			mocks.hasAccess.mockResolvedValue(false);
			await executeParlumeMeetingTurn({ turnId: "example-turn" });
			expect(mocks.hasAccess).toHaveBeenCalledWith(
				"example-project",
				"example-user",
				"example-org",
			);
			expect(mocks.stop).toHaveBeenCalledWith({
				sessionId: "example-session",
			});
			expect(mocks.retrieve).not.toHaveBeenCalled();
			expect(mocks.context).not.toHaveBeenCalled();
			expect(mocks.execute).not.toHaveBeenCalled();
			expect(mocks.speak).not.toHaveBeenCalled();
			expect(mocks.updateTurn).toHaveBeenCalledWith(
				expect.objectContaining({
					data: expect.objectContaining({ status: "FAILED" }),
				}),
			);
		},
	);
});
