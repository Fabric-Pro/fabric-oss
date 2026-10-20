import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	conversation: vi.fn(),
	turns: vi.fn(),
	write: vi.fn(),
}));
vi.mock("../prisma/client", () => ({
	db: {
		agentConversation: {
			findFirst: mocks.conversation,
			update: mocks.write,
		},
		conversationTurn: { findMany: mocks.turns },
		$transaction: mocks.write,
	},
}));

import { getAgentConversationForViewer } from "../prisma/queries/agent-conversation-sharing";
import { getAgentConversationById } from "../prisma/queries/agent-conversations";
import { hydrateConversationTurnResults } from "../prisma/queries/conversation-turn-results";

const started = new Date("2026-10-01T10:00:00.000Z");
const ended = new Date("2026-10-01T10:01:00.000Z");
const question = {
	id: "question-1",
	role: "user",
	content: "Summarize the project",
	timestamp: started.toISOString(),
};
const turn = {
	id: "turn-1",
	executionId: "execution-1",
	generation: 1,
	status: "COMPLETED" as const,
	questionText: null as string | null,
	responseText: "The project is ready.",
	terminalAt: ended,
	terminalReason: "completed",
	createdAt: started,
	limitSignalSummary: null,
};
const conversation = {
	id: "conversation-1",
	userId: "user-1",
	organizationId: "example-org",
	messages: [question],
	metadata: { mode: "orchestrator", executions: [] },
};
const read = () =>
	getAgentConversationById({
		id: conversation.id,
		userId: conversation.userId,
		organizationId: conversation.organizationId,
	});

beforeEach(() => {
	vi.clearAllMocks();
	mocks.conversation.mockResolvedValue(structuredClone(conversation));
	mocks.turns.mockResolvedValue([turn]);
});

describe("conversation load after a detached Advisor turn", () => {
	it.each([
		["CANCELLED", "cancelled", "cancelled"],
		["FAILED", "error", "error"],
		["CANCELLED", "error", "cancelled"],
		["FAILED", "cancelled", "error"],
	])(
		"keeps a saved partial answer and its message identity when reconciled %s has no response",
		async (status, browserStatus, streamStatus) => {
			const stored = {
				...conversation,
				messages: [
					{
						...question,
						metadata: { executionId: turn.executionId },
					},
					{
						id: "partial-answer",
						role: "assistant",
						content: "The first finding is ready.",
						streamStatus,
						timestamp: ended.toISOString(),
						metadata: { executionId: turn.executionId },
					},
				],
				metadata: {
					mode: "orchestrator",
					executions: [
						{
							id: turn.executionId,
							userMessage: question.content,
							status: browserStatus,
							finalResponse: "The first finding is ready.",
							stepResults: [{ response: "A completed step" }],
						},
					],
				},
			};
			mocks.conversation.mockResolvedValue(stored);
			mocks.turns.mockResolvedValue([
				{ ...turn, status, responseText: null },
			]);
			const result = await read();
			expect(result?.messages).toEqual([
				expect.objectContaining({ id: question.id }),
				expect.objectContaining({
					id: "partial-answer",
					content: "The first finding is ready.",
					streamStatus,
				}),
			]);
			expect(result?.metadata).toMatchObject({
				executions: [
					{
						id: turn.executionId,
						finalResponse: "The first finding is ready.",
						status: streamStatus,
						terminalStatus: status,
						stepResults: [{ response: "A completed step" }],
					},
				],
			});
			expect(await read()).toEqual(result);
			expect(stored.messages[1].content).toBe(
				"The first finding is ready.",
			);
			expect(mocks.write).not.toHaveBeenCalled();
		},
	);

	it.each([null, ""])(
		"preserves independently saved text when the durable response is %s",
		async (responseText) => {
			mocks.conversation.mockResolvedValue({
				...conversation,
				messages: [
					question,
					{
						id: "partial-answer",
						role: "assistant",
						content: "Partial generated answer",
						metadata: { executionId: turn.executionId },
						timestamp: ended.toISOString(),
					},
				],
				metadata: {
					mode: "orchestrator",
					executions: [
						{
							id: turn.executionId,
							userMessage: question.content,
							status: "error",
							finalResponse: "The workflow may still be running.",
							error: "The workflow may still be running.",
						},
					],
				},
			});
			mocks.turns.mockResolvedValue([
				{
					...turn,
					status: "FAILED",
					responseText,
					terminalReason: "reconciled: workflow timed_out",
				},
			]);
			const result = await read();
			expect(result?.messages).toEqual([
				expect.objectContaining({ id: question.id }),
				expect.objectContaining({
					id: "partial-answer",
					content: "Partial generated answer",
					streamStatus: "error",
				}),
			]);
			expect(result?.metadata).toMatchObject({
				executions: [
					{
						finalResponse: "The workflow may still be running.",
						additionalResponses: ["Partial generated answer"],
						terminalStatus: "FAILED",
						error: "reconciled: workflow timed_out",
					},
				],
			});
		},
	);

	it("keeps every distinct owned assistant response and saved detail through repeated projection", async () => {
		const stored = {
			...conversation,
			messages: [
				{ ...question, metadata: { executionId: turn.executionId } },
				...(
					[
						"First partial answer",
						"Second partial answer",
						"First partial answer",
					] as const
				).map((content, index) => ({
					id: `partial-${index}`,
					role: "assistant",
					content,
					metadata: {
						executionId: turn.executionId,
						custom: "saved",
					},
					timestamp: ended.toISOString(),
				})),
			],
			metadata: {
				mode: "orchestrator",
				executions: [
					{
						id: turn.executionId,
						userMessage: question.content,
						finalResponse: "Saved execution response",
						additionalResponses: [
							null,
							"Already retained response",
							"Saved execution response",
						],
						stepResults: [{ response: "Saved step" }],
						artifacts: [
							{ type: "document", content: "Saved document" },
						],
						clarifications: [
							{
								question: "Which project?",
								answer: "Example project",
							},
						],
					},
				],
			},
		};
		mocks.conversation.mockResolvedValue(stored);
		const result = await read();
		expect(result?.metadata).toMatchObject({
			executions: [
				{
					finalResponse: turn.responseText,
					additionalResponses: [
						"Saved execution response",
						"Already retained response",
						"First partial answer",
						"Second partial answer",
					],
					stepResults: stored.metadata.executions[0].stepResults,
					artifacts: stored.metadata.executions[0].artifacts,
					clarifications:
						stored.metadata.executions[0].clarifications,
				},
			],
		});
		if (!result) {
			throw new Error("Expected the owned conversation");
		}
		expect(hydrateConversationTurnResults(result, [turn])).toEqual({
			messages: result?.messages,
			metadata: result?.metadata,
		});
		expect(stored.messages[1].content).toBe("First partial answer");
		expect(mocks.write).not.toHaveBeenCalled();
	});

	it("keeps the longer browser answer when cancellation changes the outcome after it was saved", async () => {
		mocks.conversation.mockResolvedValue({
			...conversation,
			metadata: {
				mode: "orchestrator",
				executions: [
					{
						id: turn.executionId,
						userMessage: question.content,
						status: "complete",
						finalResponse:
							"The project is ready. Additional detail.",
					},
				],
			},
		});
		mocks.turns.mockResolvedValue([{ ...turn, status: "CANCELLED" }]);
		expect((await read())?.metadata).toMatchObject({
			executions: [
				{
					finalResponse: "The project is ready. Additional detail.",
					status: "cancelled",
					terminalStatus: "CANCELLED",
				},
			],
		});
	});

	it.each(["message", "execution"])(
		"recovers a partial answer saved only in the %s when the durable response is absent",
		async (source) => {
			mocks.conversation.mockResolvedValue({
				...conversation,
				messages:
					source === "message"
						? [
								question,
								{
									id: "only-answer",
									role: "assistant",
									content: "Partial answer from the browser",
									metadata: { executionId: turn.executionId },
									timestamp: ended.toISOString(),
								},
							]
						: [question],
				metadata: {
					mode: "orchestrator",
					executions:
						source === "execution"
							? [
									{
										id: turn.executionId,
										userMessage: question.content,
										status: "cancelled",
										finalResponse:
											"Partial answer from the browser",
									},
								]
							: [],
				},
			});
			mocks.turns.mockResolvedValue([
				{ ...turn, status: "CANCELLED", responseText: null },
			]);
			const result = await read();
			expect(result?.messages).toHaveLength(source === "message" ? 2 : 1);
			expect(result?.metadata).toMatchObject({
				executions: [
					{
						finalResponse: "Partial answer from the browser",
						terminalStatus: "CANCELLED",
					},
				],
			});
		},
	);

	it("finds a matching message answer even when the saved execution contains a transport notice", async () => {
		mocks.conversation.mockResolvedValue({
			...conversation,
			messages: [
				question,
				{
					id: "generated-answer",
					role: "assistant",
					content: "The project is ready. Full detail.",
					metadata: { executionId: turn.executionId },
					timestamp: ended.toISOString(),
				},
			],
			metadata: {
				mode: "orchestrator",
				executions: [
					{
						id: turn.executionId,
						userMessage: question.content,
						status: "error",
						finalResponse: "The workflow may still be running.",
					},
				],
			},
		});
		expect((await read())?.metadata).toMatchObject({
			executions: [
				{
					finalResponse: "The project is ready. Full detail.",
					status: "complete",
				},
			],
		});
	});

	it.each([
		["COMPLETED", "error"],
		["LIMITED", "error"],
		["COMPLETED", "cancelled"],
		["LIMITED", "cancelled"],
	])(
		"uses durable %s after a browser saved %s",
		async (status, browserStatus) => {
			const notice =
				"The run's streaming window could not be resumed. The workflow may still be running.";
			const details = {
				stepResults: [{ response: "Partial step" }],
				artifacts: [{ id: "artifact-1", content: "Retain saved work" }],
				clarifications: [
					{
						question: "Which project?",
						answer: "The example project",
					},
				],
				plan: { description: "Saved plan" },
			};
			mocks.conversation.mockResolvedValue({
				...conversation,
				messages: [
					{
						...question,
						metadata: { executionId: turn.executionId },
					},
					{
						id: "browser-answer",
						role: "assistant",
						content: notice,
						streamStatus: "error",
						timestamp: ended.toISOString(),
						metadata: { executionId: turn.executionId },
					},
				],
				metadata: {
					mode: "orchestrator",
					executions: [
						{
							id: turn.executionId,
							userMessage: question.content,
							status: browserStatus,
							finalResponse: notice,
							error: notice,
							...details,
						},
					],
				},
			});
			mocks.turns.mockResolvedValue([
				{
					...turn,
					status,
					limitSignalSummary:
						status === "LIMITED"
							? [
									{
										kind: "internal_budget",
										message: "Budget reached",
									},
								]
							: null,
				},
			]);
			const result = await read();
			expect(result?.messages).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						id: "browser-answer",
						content: turn.responseText,
						streamStatus: "completed",
					}),
				]),
			);
			expect(result?.metadata).toMatchObject({
				executions: [
					{
						id: turn.executionId,
						finalResponse: turn.responseText,
						status: "complete",
						terminalStatus: status,
						recoveredFromTurn: true,
						...details,
						limitSignals:
							status === "LIMITED"
								? [
										{
											kind: "internal_budget",
											message: "Budget reached",
										},
									]
								: [],
					},
				],
			});
			// Durable text owns the primary answer. The distinct saved text is
			// still available without guessing whether it was generated or a notice.
			expect(result?.metadata).toMatchObject({
				executions: [{ additionalResponses: [notice] }],
			});
			expect(mocks.write).not.toHaveBeenCalled();
		},
	);

	it("returns the durable answer and an execution the Advisor can render", async () => {
		const result = await read();
		expect(result?.messages).toHaveLength(2);
		expect(result?.messages).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					role: "assistant",
					content: turn.responseText,
					metadata: expect.objectContaining({
						executionId: turn.executionId,
					}),
				}),
			]),
		);
		expect(result?.metadata).toMatchObject({
			executions: [
				{
					id: turn.executionId,
					userMessage: question.content,
					finalResponse: turn.responseText,
					status: "complete",
					terminalStatus: "COMPLETED",
				},
			],
		});
		expect(mocks.write).not.toHaveBeenCalled();
	});

	it.each(["LIMITED", "CANCELLED", "FAILED"])(
		"keeps partial text and terminal status %s",
		async (status) => {
			mocks.turns.mockResolvedValue([
				{
					...turn,
					status,
					responseText: "Partial answer",
					limitSignalSummary: [
						{
							kind: "provider_quota",
							provider: "example-provider",
							message: "Quota reached",
							secret: "discarded",
						},
					],
				},
			]);
			const result = await read();
			expect(result?.metadata).toMatchObject({
				executions: [
					{
						finalResponse: "Partial answer",
						terminalStatus: status,
						status:
							status === "FAILED"
								? "error"
								: status === "CANCELLED"
									? "cancelled"
									: "complete",
						limitSignals: [
							{
								kind: "provider_quota",
								provider: "example-provider",
								message: "Quota reached",
							},
						],
					},
				],
			});
			expect(JSON.stringify(result)).not.toContain("discarded");
		},
	);

	it.each(["LIMITED", "CANCELLED", "FAILED"])(
		"surfaces %s even when there is no partial response",
		async (status) => {
			mocks.turns.mockResolvedValue([
				{ ...turn, status, responseText: null },
			]);
			expect((await read())?.metadata).toMatchObject({
				executions: [{ terminalStatus: status, finalResponse: "" }],
			});
		},
	);

	it.each(["START_PENDING", "ACTIVE", "CANCEL_REQUESTED"])(
		"shows a %s turn by its question only, and adds no answer",
		async (status) => {
			mocks.turns.mockResolvedValue([
				{ ...turn, status, terminalAt: null },
			]);
			const result = await read();
			expect(result?.messages).toEqual(conversation.messages);
			expect(result?.metadata).toEqual({
				mode: "orchestrator",
				executions: [
					{
						id: turn.executionId,
						userMessage: question.content,
						finalResponse: "",
						status: "running",
						startedAt: started.toISOString(),
						recoveredFromTurn: true,
						inProgress: true,
						questionMessageId: question.id,
					},
				],
			});
		},
	);

	it("is stable across repeated loads and does not mutate or write stored JSON", async () => {
		const stored = structuredClone(conversation);
		mocks.conversation.mockResolvedValue(stored);
		const first = await read();
		expect(await read()).toEqual(first);
		expect(stored).toEqual(conversation);
		expect(mocks.write).not.toHaveBeenCalled();
	});

	it("does not reuse a message id that already belongs to an unrelated message", async () => {
		mocks.conversation.mockResolvedValue({
			...conversation,
			messages: [
				question,
				{
					id: `turn-result-${turn.id}`,
					role: "system",
					content: "Keep this note",
					timestamp: started.toISOString(),
				},
			],
		});
		const result = await read();
		const messages = result?.messages as Array<{ id: string }>;
		expect(new Set(messages.map((message) => message.id)).size).toBe(
			messages.length,
		);
		expect(await read()).toEqual(result);
	});

	it("returns a browser's richer saved result once instead of adding the durable copy", async () => {
		const saved = {
			...conversation,
			messages: [
				question,
				{
					id: "browser-answer",
					role: "assistant",
					content: turn.responseText,
					timestamp: ended.toISOString(),
					metadata: { executionId: turn.executionId },
				},
			],
			metadata: {
				mode: "orchestrator",
				executions: [
					{
						id: turn.executionId,
						userMessage: question.content,
						finalResponse: turn.responseText,
						stepResults: [{ response: "Step result" }],
					},
				],
			},
		};
		mocks.conversation.mockResolvedValue(saved);
		const result = await read();
		expect(result).toMatchObject(saved);
		expect(result?.messages).toHaveLength(2);
		expect(result?.metadata).toMatchObject({
			executions: [
				{
					terminalStatus: "COMPLETED",
					status: "complete",
					recoveredFromTurn: false,
				},
			],
		});
	});

	it("keeps the browser's full answer when the durable response is a capped prefix", async () => {
		const prefix = "A".repeat(200_000);
		const fullAnswer = `${prefix} The complete ending.`;
		mocks.turns.mockResolvedValue([{ ...turn, responseText: prefix }]);
		mocks.conversation.mockResolvedValue({
			...conversation,
			messages: [
				question,
				{
					id: "full-answer",
					role: "assistant",
					content: fullAnswer,
					timestamp: ended.toISOString(),
					metadata: { executionId: turn.executionId },
				},
			],
			metadata: {
				mode: "orchestrator",
				executions: [
					{
						id: turn.executionId,
						status: "complete",
						userMessage: question.content,
						finalResponse: fullAnswer,
					},
				],
			},
		});
		const result = await read();
		expect(result?.metadata).toMatchObject({
			executions: [
				{ finalResponse: fullAnswer, recoveredFromTurn: false },
			],
		});
		expect(result?.messages).toHaveLength(2);
		expect(result?.messages).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ content: fullAnswer }),
			]),
		);
	});

	it("handles a browser save landing between loads without duplicating or persisting the projected messages", async () => {
		const detached = await read();
		mocks.conversation.mockResolvedValue({
			...conversation,
			messages: [
				question,
				{
					id: "browser-answer",
					role: "assistant",
					content: turn.responseText,
					timestamp: ended.toISOString(),
					metadata: { executionId: turn.executionId },
				},
			],
			metadata: {
				mode: "orchestrator",
				executions: [
					{
						id: turn.executionId,
						userMessage: question.content,
						finalResponse: turn.responseText,
					},
				],
			},
		});
		const saved = await read();
		expect(detached?.messages).toHaveLength(2);
		expect(saved?.messages).toHaveLength(2);
		expect(saved?.metadata).toMatchObject({
			executions: [{ id: turn.executionId }],
		});
		expect(mocks.write).not.toHaveBeenCalled();
	});

	it("does not repeat an assistant message when only the execution record is missing", async () => {
		mocks.conversation.mockResolvedValue({
			...conversation,
			messages: [
				{ ...question, metadata: { executionId: turn.executionId } },
				{
					id: "existing-answer",
					role: "assistant",
					content: turn.responseText,
					timestamp: ended.toISOString(),
					metadata: { executionId: turn.executionId },
				},
			],
		});
		const result = await read();
		expect(result?.messages).toHaveLength(2);
		expect(result?.metadata).toMatchObject({
			executions: [{ id: turn.executionId }],
		});
	});

	it("replaces an empty assistant placeholder with the durable result at the same position", async () => {
		const placeholder = {
			id: "placeholder",
			role: "assistant",
			content: "",
			timestamp: started.toISOString(),
			metadata: { executionId: turn.executionId },
		};
		mocks.conversation.mockResolvedValue({
			...conversation,
			messages: [
				{ ...question, metadata: { executionId: turn.executionId } },
				placeholder,
			],
		});
		const result = await read();
		expect(result?.messages).toHaveLength(2);
		expect(result?.messages).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: placeholder.id,
					content: turn.responseText,
				}),
			]),
		);
		expect(result?.metadata).toMatchObject({
			executions: [{ finalResponse: turn.responseText }],
		});
	});

	it("keeps saved legacy executions with unstamped messages intact", async () => {
		const saved = {
			...conversation,
			messages: [
				question,
				{
					id: "legacy-answer",
					role: "assistant",
					content: turn.responseText,
					timestamp: ended.toISOString(),
				},
			],
			metadata: {
				mode: "orchestrator",
				executions: [
					{
						id: turn.executionId,
						userMessage: question.content,
						finalResponse: turn.responseText,
					},
				],
			},
		};
		mocks.conversation.mockResolvedValue(saved);
		const result = await read();
		expect(result).toMatchObject(saved);
		expect(result?.messages).toHaveLength(2);
		expect(result?.metadata).toMatchObject({
			executions: [{ terminalStatus: "COMPLETED" }],
		});
	});

	it("orders a detached earlier turn before a later saved or pending turn, keeping unrelated messages", async () => {
		const laterQuestion = {
			...question,
			id: "later-question",
			content: "Later question",
			metadata: { executionId: "execution-2" },
		};
		const system = { ...question, id: "system-note", role: "system" };
		mocks.conversation.mockResolvedValue({
			...conversation,
			messages: [question, system, laterQuestion],
			metadata: {
				mode: "orchestrator",
				executions: [
					{
						id: "execution-2",
						userMessage: "Later question",
						finalResponse: "Later answer",
					},
				],
			},
		});
		mocks.turns.mockResolvedValue([
			turn,
			{
				...turn,
				id: "turn-2",
				executionId: "execution-2",
				generation: 2,
				status: "ACTIVE",
				terminalAt: null,
			},
		]);
		const result = await read();
		const messages = result?.messages as Array<{
			id: string;
			role: string;
		}>;
		expect(messages.map((m) => m.id)).toEqual([
			question.id,
			system.id,
			`turn-result-${turn.id}`,
			laterQuestion.id,
		]);
		expect(result?.metadata).toMatchObject({
			executions: [{ id: turn.executionId }, { id: "execution-2" }],
		});
	});

	it("shows detached later answers without attributing an earlier question to them", async () => {
		mocks.turns.mockResolvedValue([
			{
				...turn,
				id: "turn-2",
				executionId: "execution-2",
				generation: 2,
			},
		]);
		const result = await read();
		expect(result?.metadata).toMatchObject({
			executions: expect.arrayContaining([
				{
					id: "execution-2",
					userMessage: "",
					recoveredFromTurn: true,
					finalResponse: turn.responseText,
					status: "complete",
					startedAt: started.toISOString(),
					completedAt: ended.toISOString(),
					terminalStatus: "COMPLETED",
					terminalReason: "completed",
					limitSignals: [],
				},
			]),
		});
	});

	it("keeps legacy message history visible when the detached turn creates the first execution record", async () => {
		mocks.conversation.mockResolvedValue({
			...conversation,
			messages: [
				question,
				{
					id: "legacy-answer",
					role: "assistant",
					content: "Earlier answer",
					timestamp: started.toISOString(),
				},
			],
		});
		mocks.turns.mockResolvedValue([
			{
				...turn,
				id: "turn-2",
				executionId: "execution-2",
				generation: 1,
			},
		]);
		expect((await read())?.metadata).toMatchObject({
			executions: [
				{
					userMessage: question.content,
					finalResponse: "Earlier answer",
				},
				{
					id: "execution-2",
					userMessage: "",
					finalResponse: turn.responseText,
				},
			],
		});
	});

	describe("a turn still running when the conversation is read", () => {
		const pending = {
			...turn,
			id: "turn-2",
			executionId: "execution-2",
			generation: 2,
			status: "ACTIVE" as const,
			responseText: null,
			terminalAt: null,
			terminalReason: null,
			questionText: "Make me a weekly status page",
		};
		const runningRecord = {
			id: pending.executionId,
			finalResponse: "",
			status: "running",
			startedAt: started.toISOString(),
			recoveredFromTurn: true,
			inProgress: true,
		};

		it("shows its question from the turn when the browser never saved it", async () => {
			mocks.turns.mockResolvedValue([turn, pending]);

			const result = await read();

			expect(result?.metadata).toMatchObject({
				executions: [
					{ id: turn.executionId, userMessage: question.content },
					{ ...runningRecord, userMessage: pending.questionText },
				],
			});
			expect(
				(result?.metadata as { executions: object[] }).executions[1],
			).not.toHaveProperty("questionMessageId");
			expect(result?.messages).toHaveLength(2);
		});

		it("prefers the question a message saved for it over the turn's copy", async () => {
			const pendingQuestion = {
				...question,
				id: "pending-question",
				content: "Saved wording",
				metadata: { executionId: pending.executionId },
			};
			mocks.conversation.mockResolvedValue({
				...conversation,
				messages: [question, pendingQuestion],
			});
			mocks.turns.mockResolvedValue([turn, pending]);

			expect((await read())?.metadata).toMatchObject({
				executions: [
					{ id: turn.executionId },
					{
						...runningRecord,
						userMessage: "Saved wording",
						questionMessageId: pendingQuestion.id,
					},
				],
			});
		});

		it("shows a new conversation's first question once, not also as a message pair", async () => {
			mocks.turns.mockResolvedValue([
				{ ...pending, generation: 1, questionText: question.content },
			]);

			const result = await read();

			expect(result?.metadata).toMatchObject({
				executions: [
					{
						...runningRecord,
						userMessage: question.content,
						questionMessageId: question.id,
					},
				],
			});
			expect(result?.messages).toEqual([question]);
		});

		it("adds nothing for a turn admitted before its question was kept", async () => {
			mocks.turns.mockResolvedValue([
				turn,
				{ ...pending, questionText: null },
			]);

			expect((await read())?.metadata).toMatchObject({
				executions: [{ id: turn.executionId }],
			});
		});

		it("leaves a record the browser already saved for it as it is", async () => {
			const saved = {
				id: pending.executionId,
				userMessage: "Saved by the browser",
				finalResponse: "Partial",
			};
			mocks.conversation.mockResolvedValue({
				...conversation,
				metadata: { mode: "orchestrator", executions: [saved] },
			});
			mocks.turns.mockResolvedValue([pending]);

			expect((await read())?.metadata).toMatchObject({
				executions: [saved],
			});
		});
	});

	describe("the read the chat opens a conversation with", () => {
		const unsaved = {
			...turn,
			id: "turn-2",
			executionId: "execution-2",
			generation: 2,
			questionText: "Make me a weekly status page",
		};

		it.each([
			["its owner", conversation.userId],
			["someone it is shared with", "user-colleague"],
		])(
			"carries the turns' durable results when %s opens it, read as the owner's turns",
			async (_label, viewerId) => {
				mocks.turns.mockResolvedValue([unsaved]);

				const result = await getAgentConversationForViewer({
					id: conversation.id,
					userId: viewerId,
					organizationId: conversation.organizationId,
				});

				expect(result?.metadata).toMatchObject({
					executions: expect.arrayContaining([
						expect.objectContaining({
							id: unsaved.executionId,
							userMessage: unsaved.questionText,
							finalResponse: turn.responseText,
						}),
					]),
				});
				expect(mocks.turns).toHaveBeenCalledWith(
					expect.objectContaining({
						where: {
							conversationId: conversation.id,
							userId: conversation.userId,
							organizationId: conversation.organizationId,
						},
					}),
				);
			},
		);
	});

	describe("a finished turn the browser never saved", () => {
		it("takes the turn's own question over an unstamped first message", async () => {
			mocks.turns.mockResolvedValue([
				{ ...turn, questionText: "The question this turn was sent" },
			]);

			expect((await read())?.metadata).toMatchObject({
				executions: [
					expect.objectContaining({
						id: turn.executionId,
						userMessage: "The question this turn was sent",
					}),
				],
			});
		});

		it("carries the question the turn was admitted with", async () => {
			mocks.turns.mockResolvedValue([
				{
					...turn,
					id: "turn-2",
					executionId: "execution-2",
					generation: 2,
					questionText: "Make me a weekly status page",
				},
			]);

			expect((await read())?.metadata).toMatchObject({
				executions: expect.arrayContaining([
					expect.objectContaining({
						id: "execution-2",
						userMessage: "Make me a weekly status page",
						finalResponse: turn.responseText,
						terminalStatus: "COMPLETED",
					}),
				]),
			});
		});

		it("replaces the running record a browser save carried back, once", async () => {
			mocks.conversation.mockResolvedValue({
				...conversation,
				metadata: {
					mode: "orchestrator",
					executions: [
						{
							id: turn.executionId,
							userMessage: question.content,
							finalResponse: "",
							status: "running",
							recoveredFromTurn: true,
							inProgress: true,
						},
					],
				},
			});

			const executions = (
				(await read())?.metadata as {
					executions: Array<Record<string, unknown>>;
				}
			).executions;

			expect(executions).toHaveLength(1);
			expect(executions[0]).toMatchObject({
				id: turn.executionId,
				userMessage: question.content,
				finalResponse: turn.responseText,
				terminalStatus: "COMPLETED",
			});
			expect(executions[0]).not.toHaveProperty("inProgress");
		});
	});

	it("queries only the owned conversation and organization and selects no start token", async () => {
		await read();
		expect(mocks.conversation).toHaveBeenCalledWith({
			where: {
				id: conversation.id,
				userId: conversation.userId,
				organizationId: conversation.organizationId,
			},
		});
		expect(mocks.turns).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					conversationId: conversation.id,
					userId: conversation.userId,
					organizationId: conversation.organizationId,
				},
				select: expect.not.objectContaining({ startToken: true }),
			}),
		);
	});

	it("reads no turns when the conversation is not the caller's in this organization", async () => {
		mocks.conversation.mockResolvedValue(null);
		expect(await read()).toBeNull();
		expect(mocks.turns).not.toHaveBeenCalled();
	});

	it("does not hydrate missing organizations or other chat engines", async () => {
		await getAgentConversationById({
			id: conversation.id,
			userId: conversation.userId,
		});
		mocks.conversation.mockResolvedValue({
			...conversation,
			metadata: { mode: "direct" },
		});
		await read();
		expect(mocks.turns).not.toHaveBeenCalled();
	});

	it("ignores tombstones, unknown statuses and malformed signals", async () => {
		mocks.turns.mockResolvedValue([
			{ ...turn, executionId: null },
			{ ...turn, status: "UNKNOWN" },
			{
				...turn,
				limitSignalSummary: [
					null,
					{ kind: 5, message: "invalid" },
					{
						kind: "provider_quota",
						message: "Valid",
						provider: {},
						startToken: "private",
					},
				],
			},
		]);
		const result = await read();
		expect(result?.messages).toHaveLength(2);
		expect(result?.metadata).toMatchObject({
			executions: [
				{
					limitSignals: [
						{ kind: "provider_quota", message: "Valid" },
					],
				},
			],
		});
		expect(JSON.stringify(result)).not.toContain("private");
	});
});
