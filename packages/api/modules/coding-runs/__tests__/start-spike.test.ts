/**
 * Spike runs (plan Slice 3): start gates, accept and discard.
 *
 * Run with: pnpm --filter @repo/api test modules/coding-runs/__tests__/start-spike.test.ts
 */

import { ORPCError } from "@orpc/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	handlers,
	mockDb,
	mockComputeStoryReadiness,
	mockApplySpikeFindings,
	mockDiscardSpikeRun,
	mockAddCodingRunEvent,
	mockLogWorkflowEvent,
	mockGetTemporalClient,
	mockCapabilities,
	workflowStart,
	workflowGetHandle,
	SpikeRunNotFoundError,
	SpikeRunStateError,
} = vi.hoisted(() => {
	const handlers: Record<string, (...args: unknown[]) => unknown> = {};
	class SpikeRunNotFoundError extends Error {}
	class SpikeRunStateError extends Error {
		status: string;
		kind: string;
		constructor(status: string, kind: string) {
			super(`Spike run is ${status}`);
			this.status = status;
			this.kind = kind;
		}
	}
	const workflowDescribe = vi.fn();
	return {
		handlers,
		mockDb: {
			userStory: { findFirst: vi.fn() },
			organization: { findUnique: vi.fn() },
			project: { findUnique: vi.fn() },
			codingRun: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
		},
		mockComputeStoryReadiness: vi.fn(),
		mockApplySpikeFindings: vi.fn(),
		mockDiscardSpikeRun: vi.fn(),
		mockAddCodingRunEvent: vi.fn(),
		mockLogWorkflowEvent: vi.fn(),
		mockGetTemporalClient: vi.fn(),
		mockCapabilities: { pushBranchWithoutPr: true },
		workflowStart: vi.fn(),
		workflowGetHandle: vi.fn(() => ({ describe: workflowDescribe })),
		workflowDescribe,
		SpikeRunNotFoundError,
		SpikeRunStateError,
	};
});

vi.mock("@repo/database", () => ({
	db: mockDb,
	computeStoryReadiness: mockComputeStoryReadiness,
	applySpikeFindings: mockApplySpikeFindings,
	discardSpikeRun: mockDiscardSpikeRun,
	addCodingRunEvent: mockAddCodingRunEvent,
	SpikeRunNotFoundError,
	SpikeRunStateError,
	StageTransitionBlockedError: class extends Error {},
	GovernedActorRequiredError: class extends Error {},
	StageTransitionConflictError: class extends Error {},
	StageApprovalError: class extends Error {},
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
	logWorkflowEvent: mockLogWorkflowEvent,
}));

vi.mock("@repo/temporal", () => ({
	getTemporalClient: mockGetTemporalClient,
}));

vi.mock("@repo/temporal/coding-execution", () => ({
	getCodingExecutionAdapterDefinition: (provider: string) => ({
		provider,
		capabilities: mockCapabilities,
	}),
	getProviderCapabilities: (definition: {
		capabilities?: { pushBranchWithoutPr: boolean };
	}) => definition.capabilities ?? { pushBranchWithoutPr: false },
}));

vi.mock("../../../orpc/procedures", () => {
	let current = "";
	const chainable: any = {
		use: () => chainable,
		route: (route: { path: string }) => {
			current = route.path;
			return chainable;
		},
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			handlers[current] = fn;
			return { _handler: fn };
		},
	};
	return {
		tenantProtectedProcedure: chainable,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requirePermission: () => (c: unknown) => c,
		requireProjectPermission: () => (c: unknown) => c,
		resolveOrganizationId: vi.fn(
			(organizationId: string | null) => organizationId,
		),
	};
});

import "../procedures/accept-spike";
import "../procedures/discard-spike";
import "../procedures/start-coding-run";

const start = (input: Record<string, unknown>) =>
	handlers["/coding-runs/start"]({ input, context });
const accept = (input: Record<string, unknown>) =>
	handlers["/coding-runs/{codingRunId}/accept-spike"]({ input, context });
const discard = (input: Record<string, unknown>) =>
	handlers["/coding-runs/{codingRunId}/discard-spike"]({ input, context });

const context = {
	user: { id: "user-1" },
	session: { activeOrganizationId: null },
};

const spikeStory = {
	id: "story-1",
	identifier: "F-001",
	title: "Streaming export",
	description: JSON.stringify({
		type: "doc",
		content: [
			{
				type: "paragraph",
				content: [{ type: "text", text: "Exports time out today." }],
			},
		],
	}),
	deliveryTrack: "SPIKE",
	draftingStage: "PLACEHOLDER",
	tasks: [],
	project: {
		name: "Project",
		organizationId: null,
		repositoryUrl: "https://github.com/acme/repo",
		repositoryOwner: "acme",
		repositoryName: "repo",
		defaultBranch: "main",
	},
};

async function expectORPCError(
	promise: Promise<unknown>,
	code: string,
): Promise<ORPCError<string, unknown>> {
	const error = await promise.then(
		() => null,
		(e: unknown) => e,
	);
	expect(error).toBeInstanceOf(ORPCError);
	expect((error as ORPCError<string, unknown>).code).toBe(code);
	return error as ORPCError<string, unknown>;
}

beforeEach(() => {
	vi.clearAllMocks();
	mockCapabilities.pushBranchWithoutPr = true;
	mockDb.userStory.findFirst.mockResolvedValue(spikeStory);
	mockDb.organization.findUnique.mockResolvedValue(null);
	mockDb.project.findUnique.mockResolvedValue({ organizationId: null });
	mockDb.codingRun.findFirst.mockResolvedValue(null);
	mockDb.codingRun.create.mockResolvedValue({ id: "run-1" });
	mockDb.codingRun.update.mockResolvedValue({});
	mockGetTemporalClient.mockResolvedValue({
		workflow: { start: workflowStart, getHandle: workflowGetHandle },
	});
	workflowStart.mockResolvedValue({});
	mockLogWorkflowEvent.mockResolvedValue(undefined);
	mockAddCodingRunEvent.mockResolvedValue({});
	// Not PUBLISHED and not ready: a spike must still start.
	mockComputeStoryReadiness.mockResolvedValue({
		ready: false,
		missing: ["SPIKE_NOT_ACCEPTED"],
		advisory: [],
		effectiveTrack: "SPIKE",
		deliveryTrack: "SPIKE",
		draftingStage: "PLACEHOLDER",
		reviewRequired: false,
	});
});

describe("codingRuns.start — kind: SPIKE", () => {
	const spikeInput = {
		projectId: "proj-1",
		storyId: "story-1",
		organizationId: null,
		kind: "SPIKE",
		spikeQuestion: "Can we stream the export without buffering?",
	};

	it("starts a spike without requiring PUBLISHED or readiness", async () => {
		const result = (await start(spikeInput)) as { status: string };
		expect(result.status).toBe("started");
		expect(mockComputeStoryReadiness).not.toHaveBeenCalled();
		expect(mockDb.codingRun.create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				kind: "SPIKE",
				spikeQuestion: "Can we stream the export without buffering?",
				status: "QUEUED",
			}),
		});
		expect(workflowStart).toHaveBeenCalledWith(
			"codingRunWorkflow",
			expect.objectContaining({
				args: [
					expect.objectContaining({
						kind: "SPIKE",
						spikeQuestion:
							"Can we stream the export without buffering?",
					}),
				],
			}),
		);
	});

	it("defaults the question to the title and a text summary of the description", async () => {
		await start({ ...spikeInput, spikeQuestion: undefined });
		const created = mockDb.codingRun.create.mock.calls[0][0] as {
			data: { spikeQuestion: string };
		};
		expect(created.data.spikeQuestion).toContain('"Streaming export"');
		expect(created.data.spikeQuestion).toContain("Exports time out today.");
		expect(created.data.spikeQuestion).not.toContain('"type"');
	});

	it("rejects a spike for a story that is not on the SPIKE track", async () => {
		mockDb.userStory.findFirst.mockResolvedValue({
			...spikeStory,
			deliveryTrack: "SPECIFY",
		});
		const error = await expectORPCError(
			start(spikeInput),
			"PRECONDITION_FAILED",
		);
		expect(error.data).toEqual(
			expect.objectContaining({
				code: "TRACK_NOT_SPIKE",
				deliveryTrack: "SPECIFY",
			}),
		);
		expect(mockDb.codingRun.create).not.toHaveBeenCalled();
	});

	it("rejects a spike when the provider lacks pushBranchWithoutPr", async () => {
		mockCapabilities.pushBranchWithoutPr = false;
		const error = await expectORPCError(
			start(spikeInput),
			"PRECONDITION_FAILED",
		);
		expect(error.message).toBe("This execution provider cannot run spikes");
		expect(mockDb.codingRun.create).not.toHaveBeenCalled();
	});

	it("reports a DEMO_READY spike as awaiting a decision", async () => {
		mockDb.codingRun.findFirst.mockResolvedValue({
			id: "run-0",
			kind: "SPIKE",
			status: "DEMO_READY",
		});
		const error = await expectORPCError(start(spikeInput), "CONFLICT");
		expect(error.message).toMatch(/awaiting a decision/i);
		expect(error.data).toEqual(
			expect.objectContaining({ code: "SPIKE_AWAITING_DECISION" }),
		);
	});

	it("still gates IMPLEMENT runs on readiness", async () => {
		await expectORPCError(
			start({
				...spikeInput,
				kind: "IMPLEMENT",
				spikeQuestion: undefined,
			}),
			"PRECONDITION_FAILED",
		);
		expect(mockComputeStoryReadiness).toHaveBeenCalled();
	});
});

describe("codingRuns.acceptSpike", () => {
	const acceptInput = {
		codingRunId: "run-1",
		projectId: "proj-1",
		organizationId: null,
		playNotes: "Tried the demo with the PM; export streamed in 2s.",
		nextTrack: "SPECIFY",
	};

	it("applies the findings within the project's tenant and returns the result", async () => {
		mockDb.project.findUnique.mockResolvedValue({
			organizationId: "org-1",
		});
		mockApplySpikeFindings.mockResolvedValue({
			codingRunId: "run-1",
			status: "COMPLETED",
			storyId: "story-1",
			projectId: "proj-1",
			version: 4,
			stageTransition: { outcome: "applied", toStage: "ACTIVE_ANALYSIS" },
		});

		const result = await accept(acceptInput);

		expect(mockApplySpikeFindings).toHaveBeenCalledWith({
			codingRunId: "run-1",
			projectId: "proj-1",
			organizationId: "org-1",
			userId: "user-1",
			playNotes: acceptInput.playNotes,
			nextTrack: "SPECIFY",
		});
		expect(result).toEqual({
			codingRunId: "run-1",
			status: "COMPLETED",
			storyId: "story-1",
			version: 4,
			stageTransition: { outcome: "applied", toStage: "ACTIVE_ANALYSIS" },
		});
		expect(mockAddCodingRunEvent).toHaveBeenCalledWith(
			"run-1",
			"spike_accepted",
			expect.objectContaining({ acceptedBy: "user-1" }),
		);
	});

	it("maps a non-DEMO_READY run to CONFLICT", async () => {
		mockApplySpikeFindings.mockRejectedValue(
			new SpikeRunStateError("RUNNING", "SPIKE"),
		);
		const error = await expectORPCError(accept(acceptInput), "CONFLICT");
		expect(error.data).toEqual(
			expect.objectContaining({
				code: "SPIKE_NOT_DEMO_READY",
				status: "RUNNING",
			}),
		);
		expect(mockAddCodingRunEvent).not.toHaveBeenCalled();
	});

	it("maps a foreign-tenant run to NOT_FOUND", async () => {
		mockApplySpikeFindings.mockRejectedValue(new SpikeRunNotFoundError());
		await expectORPCError(accept(acceptInput), "NOT_FOUND");
	});

	it("maps a missing project to NOT_FOUND before touching the run", async () => {
		mockDb.project.findUnique.mockResolvedValue(null);
		await expectORPCError(accept(acceptInput), "NOT_FOUND");
		expect(mockApplySpikeFindings).not.toHaveBeenCalled();
	});
});

describe("codingRuns.discardSpike", () => {
	it("cancels the run with the reason and records an event", async () => {
		mockDiscardSpikeRun.mockResolvedValue({
			codingRunId: "run-1",
			status: "CANCELLED",
			storyId: "story-1",
		});
		const result = await discard({
			codingRunId: "run-1",
			projectId: "proj-1",
			organizationId: null,
			reason: "Not worth pursuing",
		});
		expect(mockDiscardSpikeRun).toHaveBeenCalledWith({
			codingRunId: "run-1",
			projectId: "proj-1",
			organizationId: null,
			reason: "Not worth pursuing",
		});
		expect(result).toEqual({
			codingRunId: "run-1",
			status: "CANCELLED",
			storyId: "story-1",
		});
		expect(mockAddCodingRunEvent).toHaveBeenCalledWith(
			"run-1",
			"spike_discarded",
			expect.objectContaining({ discardedBy: "user-1" }),
		);
	});

	it("maps a non-DEMO_READY run to CONFLICT", async () => {
		mockDiscardSpikeRun.mockRejectedValue(
			new SpikeRunStateError("COMPLETED", "SPIKE"),
		);
		await expectORPCError(
			discard({ codingRunId: "run-1", projectId: "proj-1" }),
			"CONFLICT",
		);
	});
});
