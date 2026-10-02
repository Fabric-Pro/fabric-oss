import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	start: vi.fn(),
	getTemporalClient: vi.fn(),
	warn: vi.fn(),
}));

vi.mock("@repo/temporal", () => ({
	getTemporalClient: (...a: unknown[]) => m.getTemporalClient(...a),
}));
vi.mock("@repo/logs", () => ({ logger: { warn: m.warn } }));
vi.mock("../../../../lib/temporal-correlation", () => ({
	withCorrelationMemo: (options: unknown) => options,
}));

import { queueRepositorySyncFollowUp } from "../repository-sync-follow-up";

const input = {
	subject: "context" as const,
	projectId: "proj_1",
	organizationId: "org_1",
	requesterUserId: "user_1",
};

beforeEach(() => {
	m.start.mockReset();
	m.warn.mockReset();
	m.start.mockResolvedValue(undefined);
	m.getTemporalClient.mockReset();
	m.getTemporalClient.mockResolvedValue({ workflow: { start: m.start } });
});

describe("queueRepositorySyncFollowUp", () => {
	it("starts the follow-up under its own id, replacing one already waiting, with the requester in its input", async () => {
		expect(await queueRepositorySyncFollowUp(input)).toBe(true);

		expect(m.start).toHaveBeenCalledWith(
			"projectRepositorySyncFollowUpWorkflow",
			{
				taskQueue: "fabric-worker",
				workflowId: "repository-sync-follow-up-context-proj_1",
				workflowIdConflictPolicy: "TERMINATE_EXISTING",
				args: [input],
			},
		);
	});

	it("keeps the two syncs' follow-ups apart", async () => {
		await queueRepositorySyncFollowUp({
			...input,
			subject: "instructions",
		});

		expect(m.start.mock.calls[0]?.[1]).toMatchObject({
			workflowId: "repository-sync-follow-up-instructions-proj_1",
		});
	});

	it("answers false, and logs only the error's class, when it could not be queued", async () => {
		m.start.mockRejectedValue(
			new Error("connect ECONNREFUSED temporal.internal:7233"),
		);

		expect(await queueRepositorySyncFollowUp(input)).toBe(false);

		const [context] = m.warn.mock.calls[0] as [Record<string, unknown>];
		expect(context.failure).toBe("Error");
		expect(JSON.stringify(context)).not.toContain("temporal.internal");
	});

	it("answers false when the Temporal client cannot be reached at all", async () => {
		m.getTemporalClient.mockRejectedValue(new Error("no client"));

		expect(await queueRepositorySyncFollowUp(input)).toBe(false);
	});
});
