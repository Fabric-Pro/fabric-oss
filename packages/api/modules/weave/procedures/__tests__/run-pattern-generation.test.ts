/**
 * Unit tests for the shared `runPatternGeneration` continuation.
 *
 * The continuation runs detached from the request (`runInBackground`), so
 * its contract is: persist every outcome on the plan row and NEVER throw.
 *
 * Pinned behaviors:
 *   (a) Success (checkboxes returned) → checkboxes + description (analysis
 *       slice ≤500 chars, falling back to `priorDescription`) +
 *       PENDING_APPROVAL.
 *   (b) Success without a checkboxes array → status-only PENDING_APPROVAL.
 *   (c) Create-mode failure → FAILED + "Plan generation failed: …" (no
 *       DRAFT revert — the plan leaves the polling loop visibly).
 *   (d) Revise-mode failure → PENDING_APPROVAL restored + "Revision
 *       failed: …" (a failed revision keeps the reviewable plan).
 *   (e) Persistence failures are caught and logged — the function resolves.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runPatternGeneration } from "../../lib/run-pattern-generation";

const { mockPlanUpdate, mockSendMessageSecure, mockClientOptions } = vi.hoisted(
	() => ({
		mockPlanUpdate: vi.fn(),
		mockSendMessageSecure: vi.fn(),
		mockClientOptions: vi.fn(),
	}),
);

vi.mock("@repo/database", () => ({
	db: {
		weavePlan: {
			update: mockPlanUpdate,
		},
	},
}));

vi.mock("@repo/agent-core", () => ({
	SecureA2AClient: class {
		constructor(options: unknown) {
			mockClientOptions(options);
		}
		sendMessageSecure = mockSendMessageSecure;
	},
}));

const baseParams = {
	planId: "plan-1",
	patternUrl: "http://planners.internal:8142",
	message: "Implement feature: Do the thing",
	userId: "user-1",
	organizationId: "org-1" as string | null,
	projectContext: {
		projectId: "proj-1",
		projectName: "Demo Project",
		description: "A demo project",
		techStack: "TypeScript, Next.js",
	},
};

let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	vi.clearAllMocks();
	mockPlanUpdate.mockResolvedValue({});
	consoleErrorSpy = vi
		.spyOn(console, "error")
		.mockImplementation(() => undefined);
});

afterEach(() => {
	consoleErrorSpy.mockRestore();
});

describe("runPatternGeneration — success", () => {
	it("persists checkboxes, the analysis description, and PENDING_APPROVAL", async () => {
		const checkboxes = [{ id: "cb-1", text: "Step 1", agent: "thread" }];
		mockSendMessageSecure.mockResolvedValue({
			success: true,
			checkboxes,
			analysis: "Implementation analysis",
		});

		await runPatternGeneration({ ...baseParams, isRevision: false });

		expect(mockClientOptions).toHaveBeenCalledWith({
			timeout: 120_000,
			sourceAgent: "api",
		});
		expect(mockSendMessageSecure).toHaveBeenCalledWith(
			"http://planners.internal:8142",
			{
				role: "user",
				parts: [{ type: "text", text: baseParams.message }],
				metadata: {
					planId: "plan-1",
					tenantContext: {
						userId: "user-1",
						organizationId: "org-1",
					},
					projectContext: baseParams.projectContext,
				},
			},
			{ userId: "user-1", organizationId: "org-1" },
		);
		// Create mode must not tag the message as a revision.
		const sentMessage = mockSendMessageSecure.mock.calls[0]?.[1];
		expect(sentMessage.metadata).not.toHaveProperty("isRevision");

		expect(mockPlanUpdate).toHaveBeenCalledExactlyOnceWith({
			where: { id: "plan-1" },
			data: {
				checkboxes,
				description: "Implementation analysis",
				status: "PENDING_APPROVAL",
			},
		});
	});

	it("tags the message with isRevision: true in revise mode", async () => {
		mockSendMessageSecure.mockResolvedValue({
			checkboxes: [],
			analysis: "Revised analysis",
		});

		await runPatternGeneration({
			...baseParams,
			isRevision: true,
			priorDescription: "Prior description",
		});

		const sentMessage = mockSendMessageSecure.mock.calls[0]?.[1];
		expect(sentMessage.metadata.isRevision).toBe(true);
	});

	it("slices the analysis to 500 characters", async () => {
		mockSendMessageSecure.mockResolvedValue({
			checkboxes: [{ id: "cb-1" }],
			analysis: "x".repeat(600),
		});

		await runPatternGeneration({ ...baseParams, isRevision: false });

		const data = mockPlanUpdate.mock.calls[0]?.[0]?.data;
		expect(data.description).toBe("x".repeat(500));
	});

	it("falls back to priorDescription when Pattern returns no analysis", async () => {
		mockSendMessageSecure.mockResolvedValue({
			checkboxes: [{ id: "cb-1" }],
		});

		await runPatternGeneration({
			...baseParams,
			isRevision: false,
			priorDescription: "Original plan description",
		});

		const data = mockPlanUpdate.mock.calls[0]?.[0]?.data;
		expect(data.description).toBe("Original plan description");
	});

	it("updates status only when Pattern returns no checkboxes array", async () => {
		mockSendMessageSecure.mockResolvedValue({ success: true });

		await runPatternGeneration({ ...baseParams, isRevision: false });

		expect(mockPlanUpdate).toHaveBeenCalledExactlyOnceWith({
			where: { id: "plan-1" },
			data: { status: "PENDING_APPROVAL" },
		});
	});
});

describe("runPatternGeneration — failure", () => {
	it("create mode: flips the plan to FAILED with the failure copy (no DRAFT revert)", async () => {
		mockSendMessageSecure.mockRejectedValue(
			new Error("Pattern unavailable"),
		);

		await runPatternGeneration({ ...baseParams, isRevision: false });

		expect(mockPlanUpdate).toHaveBeenCalledExactlyOnceWith({
			where: { id: "plan-1" },
			data: {
				status: "FAILED",
				description: "Plan generation failed: Pattern unavailable.",
			},
		});
		expect(consoleErrorSpy).toHaveBeenCalled();
	});

	it("create mode: uses 'Unknown error' for non-Error rejections", async () => {
		mockSendMessageSecure.mockRejectedValue("boom");

		await runPatternGeneration({ ...baseParams, isRevision: false });

		const data = mockPlanUpdate.mock.calls[0]?.[0]?.data;
		expect(data).toEqual({
			status: "FAILED",
			description: "Plan generation failed: Unknown error.",
		});
	});

	it("revise mode: restores PENDING_APPROVAL with the revision-failure copy", async () => {
		mockSendMessageSecure.mockRejectedValue(
			new Error("Pattern unavailable"),
		);

		await runPatternGeneration({
			...baseParams,
			isRevision: true,
			priorDescription: "Prior description",
		});

		expect(mockPlanUpdate).toHaveBeenCalledExactlyOnceWith({
			where: { id: "plan-1" },
			data: {
				status: "PENDING_APPROVAL",
				description:
					"Revision failed: Pattern unavailable. You can still approve the original plan or try again.",
			},
		});
	});

	it("persists failure state when the success-path write fails", async () => {
		mockSendMessageSecure.mockResolvedValue({
			checkboxes: [{ id: "cb-1" }],
			analysis: "Analysis",
		});
		mockPlanUpdate
			.mockRejectedValueOnce(new Error("connection reset"))
			.mockResolvedValueOnce({});

		await runPatternGeneration({ ...baseParams, isRevision: false });

		expect(mockPlanUpdate).toHaveBeenCalledTimes(2);
		expect(mockPlanUpdate).toHaveBeenLastCalledWith({
			where: { id: "plan-1" },
			data: {
				status: "FAILED",
				description: "Plan generation failed: connection reset.",
			},
		});
	});

	it("resolves without throwing when every persistence write fails", async () => {
		mockSendMessageSecure.mockRejectedValue(
			new Error("Pattern unavailable"),
		);
		mockPlanUpdate.mockRejectedValue(new Error("database down"));

		await expect(
			runPatternGeneration({ ...baseParams, isRevision: false }),
		).resolves.toBeUndefined();

		// Both the Pattern failure and the persistence failure are logged.
		expect(consoleErrorSpy).toHaveBeenCalledTimes(2);
	});
});
