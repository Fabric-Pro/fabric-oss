import { beforeEach, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({
	status: "RUNNING",
	workflowId: "example-workflow",
	org: "example-org",
	update: vi.fn(),
	upsert: vi.fn(),
	events: new Set<string>(),
}));
vi.mock("../prisma/client", () => ({
	db: {
		$transaction: async (fn: any) =>
			fn({
				codingRun: { updateMany: f.update },
				codingRunEvent: { upsert: f.upsert },
			}),
	},
}));

import { markCodingRunRecoveryRequired } from "../prisma/queries/coding-runs";

const input = {
	codingRunId: "example-run",
	workflowId: "example-workflow",
	organizationId: "example-org",
	payload: { message: "Unknown shutdown" },
};
beforeEach(() => {
	vi.clearAllMocks();
	f.status = "RUNNING";
	f.workflowId = "example-workflow";
	f.org = "example-org";
	f.events.clear();
	f.update.mockImplementation(async ({ where, data }) => {
		if (
			(where.organizationId !== undefined &&
				where.organizationId !== f.org) ||
			(where.OR &&
				!where.OR.some(
					(entry: any) => entry.workflowId === f.workflowId,
				)) ||
			(where.status && !where.status.in.includes(f.status))
		) {
			return { count: 0 };
		}
		f.status = data.status ?? f.status;
		return { count: 1 };
	});
	f.upsert.mockImplementation(async ({ where }) => {
		f.events.add(where.id);
	});
});
it("marks a closed uncertain run recoverable and upserts one event across repeated watchdog ticks", async () => {
	await markCodingRunRecoveryRequired(input);
	await markCodingRunRecoveryRequired(input);
	expect(f.status).toBe("AWAITING_REVIEW");
	expect(f.events.size).toBe(1);
});
it.each(["FAILED", "CANCELLED", "COMPLETED", "TERMINATED_STALE"])(
	"does not revive a terminal %s row or append a recovery event",
	async (status) => {
		f.status = status;
		await markCodingRunRecoveryRequired(input);
		expect(f.status).toBe(status);
		expect(f.upsert).not.toHaveBeenCalled();
	},
);
it("does not alter another workflow's resumed row", async () => {
	f.workflowId = "example-follow-up";
	await markCodingRunRecoveryRequired(input);
	expect(f.status).toBe("RUNNING");
	expect(f.upsert).not.toHaveBeenCalled();
});
it("does not alter a row in a different organization", async () => {
	f.org = "example-other-org";
	await markCodingRunRecoveryRequired(input);
	expect(f.upsert).not.toHaveBeenCalled();
});

it("records a continuation recovery event conditionally without changing an active status before cleanup", async () => {
	await markCodingRunRecoveryRequired({
		...input,
		eventType: "continuation_recovery_required",
	});
	expect(f.status).toBe("RUNNING");
	expect(f.events.size).toBe(1);
});
it("does not append a late continuation recovery event after manual recovery", async () => {
	f.status = "FAILED";
	await markCodingRunRecoveryRequired({
		...input,
		eventType: "continuation_recovery_required",
	});
	expect(f.upsert).not.toHaveBeenCalled();
});
