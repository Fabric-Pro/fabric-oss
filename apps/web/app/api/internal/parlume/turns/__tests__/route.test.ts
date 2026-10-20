import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	sessionFindFirst: vi.fn(),
	sessionUpdateMany: vi.fn(),
	turnCreateMany: vi.fn(),
	turnFindUnique: vi.fn(),
	turnUpdateMany: vi.fn(),
	turnUpdate: vi.fn(),
	workflowStart: vi.fn(),
	mintGrant: vi.fn(),
}));

vi.mock("@repo/api/lib/agent-service-auth", () => ({
	mintParlumeActingGrantForTurn: mocks.mintGrant,
}));

vi.mock("@repo/database", () => ({
	db: {
		parlumeMeetingSession: {
			findFirst: mocks.sessionFindFirst,
			updateMany: mocks.sessionUpdateMany,
		},
		parlumeMeetingTurn: {
			createMany: mocks.turnCreateMany,
			findUnique: mocks.turnFindUnique,
			updateMany: mocks.turnUpdateMany,
			update: mocks.turnUpdate,
		},
	},
}));

vi.mock("@repo/temporal", () => ({
	getTemporalClient: async () => ({
		workflow: { start: mocks.workflowStart },
	}),
}));

vi.mock("@repo/api/modules/projects/lib/parlume-attendee", () => ({
	deleteParlumeMeetingBotData: vi.fn(),
	getParlumeBridgeSettings: vi.fn(),
}));

import { POST } from "../route";

function request(): NextRequest {
	return new NextRequest(
		"https://fabric.example/api/internal/parlume/turns",
		{
			method: "POST",
			headers: {
				"content-type": "application/json",
				"X-Agent-Service-Token": "service-secret",
			},
			body: JSON.stringify({
				sessionId: "session-1",
				botId: "bot-1",
				text: "What was decided?",
				speakerName: "Alice",
				speakerId: "1",
				utteranceStartMs: 1_000,
				utteranceEndMs: 2_000,
			}),
		},
	);
}

beforeEach(() => {
	vi.resetAllMocks();
	process.env.AGENT_SERVICE_SECRET = "service-secret";
	mocks.sessionFindFirst.mockResolvedValue({
		id: "session-1",
		projectId: "project-1",
		organizationId: "org-1",
		userId: "user-1",
		activeTurnId: null,
		toolsReadOnly: false,
	});
	mocks.sessionUpdateMany.mockResolvedValue({ count: 1 });
	mocks.workflowStart.mockResolvedValue(undefined);
	mocks.mintGrant.mockReturnValue("grant-for-this-turn");
});

describe("Parlume acting grant", () => {
	function acceptNewTurn() {
		mocks.turnCreateMany.mockResolvedValue({ count: 1 });
		mocks.turnFindUnique.mockResolvedValue({
			id: "turn-1",
			status: "PENDING",
			error: null,
		});
	}

	it("mints a grant for the inviter and hands it to the turn workflow", async () => {
		acceptNewTurn();

		const response = await POST(request());

		expect(response.status).toBe(200);
		expect(mocks.mintGrant).toHaveBeenCalledWith({
			userId: "user-1",
			organizationId: "org-1",
			projectId: "project-1",
			readOnly: false,
		});
		expect(mocks.workflowStart).toHaveBeenCalledWith(
			"parlumeMeetingTurnWorkflow",
			expect.objectContaining({
				args: [
					expect.objectContaining({
						turnId: "turn-1",
						actingGrant: "grant-for-this-turn",
					}),
				],
			}),
		);
	});

	it("mints a read-only meeting's grant as read-only", async () => {
		acceptNewTurn();
		mocks.sessionFindFirst.mockResolvedValue({
			id: "session-1",
			projectId: "project-1",
			organizationId: "org-1",
			userId: "user-1",
			activeTurnId: null,
			toolsReadOnly: true,
		});

		await POST(request());

		expect(mocks.mintGrant).toHaveBeenCalledWith(
			expect.objectContaining({ readOnly: true }),
		);
	});

	it("mints a fresh grant for every turn instead of keeping one on the session", async () => {
		acceptNewTurn();
		mocks.mintGrant
			.mockReturnValueOnce("first-grant")
			.mockReturnValueOnce("second-grant");

		await POST(request());
		await POST(request());

		const grants = mocks.workflowStart.mock.calls.map(
			([, options]) => options.args[0].actingGrant,
		);
		expect(grants).toEqual(["first-grant", "second-grant"]);
	});

	it("never writes the grant to the turn or the session", async () => {
		acceptNewTurn();

		await POST(request());

		const written = JSON.stringify([
			mocks.turnCreateMany.mock.calls,
			mocks.turnUpdateMany.mock.calls,
			mocks.turnUpdate.mock.calls,
			mocks.sessionUpdateMany.mock.calls,
		]);
		expect(written).not.toContain("grant-for-this-turn");
	});
});

describe("Parlume interrupted turn dispatch", () => {
	it("asks the bridge to retry while a first spoken turn is active", async () => {
		mocks.sessionFindFirst.mockResolvedValueOnce({
			id: "session-1",
			activeTurnId: "first-turn",
		});

		const response = await POST(request());

		expect(response.status).toBe(409);
		expect(mocks.turnCreateMany).not.toHaveBeenCalled();
	});

	it("retries a deduplicated turn that lost the session claim", async () => {
		mocks.turnCreateMany.mockResolvedValue({ count: 0 });
		mocks.turnFindUnique.mockResolvedValue({
			id: "turn-2",
			status: "FAILED",
			error: "Another Parlume turn is already running.",
		});
		mocks.turnUpdateMany.mockResolvedValue({ count: 1 });

		const response = await POST(request());

		expect(response.status).toBe(200);
		expect(mocks.turnUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: {
					status: "PENDING",
					error: null,
					completedAt: null,
				},
			}),
		);
		expect(mocks.workflowStart).toHaveBeenCalledWith(
			"parlumeMeetingTurnWorkflow",
			expect.objectContaining({
				workflowId: "parlume-turn-turn-2",
			}),
		);
	});
});
