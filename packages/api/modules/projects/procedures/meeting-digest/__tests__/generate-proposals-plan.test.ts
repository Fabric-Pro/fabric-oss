/**
 * A person's "Create feature proposals" click is their own interactive work
 * (Fizzy #2770): the run is started plan-eligible, unlike the automatic
 * meeting scan, which stays background work tagged with its job type.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	start: vi.fn(),
	findTranscript: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		projectMeetingTranscript: {
			findFirst: mocks.findTranscript,
			updateMany: vi.fn(async () => ({ count: 1 })),
		},
		projectContext: {
			findUnique: vi.fn(async () => ({ content: "Transcript text" })),
		},
	},
	hasProjectAccess: vi.fn(async () => true),
}));

vi.mock("@repo/temporal", () => ({
	getTemporalClient: async () => ({ workflow: { start: mocks.start } }),
}));

vi.mock("../../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => ({ _handler: fn }),
	});
	return {
		tenantProtectedProcedure: chainable,
		requireProjectPermission: () => ({}),
		resolveOrganizationId: (organizationId: string) => organizationId,
		Permissions: { PROJECT_READ: "project_read" },
	};
});

import { generateProposalsProcedure } from "../generate-proposals";

const handler = (
	generateProposalsProcedure as unknown as {
		_handler: (args: {
			input: unknown;
			context: unknown;
		}) => Promise<unknown>;
	}
)._handler;

beforeEach(() => {
	vi.clearAllMocks();
	mocks.findTranscript.mockResolvedValue({
		id: "transcript-row-1",
		contextId: "context-1",
		analysisStatus: "NOT_SCANNED",
		analyzedProposalId: null,
		meetingId: "meeting-1",
		transcriptId: "transcript-1",
		linkedMeetingId: "linked-1",
		meetingSubject: "Weekly sync",
		meetingDate: null,
	});
});

describe("generateProposals", () => {
	it("starts the analysis as the person's plan-eligible interactive work", async () => {
		await expect(
			handler({
				input: {
					projectId: "project-1",
					organizationId: "org-1",
					transcriptId: "transcript-1",
				},
				context: { user: { id: "user-1" }, session: {} },
			}),
		).resolves.toEqual({ status: "started", proposalId: null });

		expect(mocks.start).toHaveBeenCalledTimes(1);
		const [workflow, options] = mocks.start.mock.calls[0] as [
			string,
			{ args: Array<Record<string, unknown>> },
		];
		expect(workflow).toBe("autoAnalyzeMeetingTranscriptWorkflow");
		expect(options.args[0]).toMatchObject({
			userId: "user-1",
			organizationId: "org-1",
			userInitiated: true,
			planEligible: true,
		});
		expect(options.args[0]).not.toHaveProperty("jobType");
	});
});
