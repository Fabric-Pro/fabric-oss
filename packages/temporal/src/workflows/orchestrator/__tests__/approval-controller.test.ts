import { beforeEach, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
	handlers: new Map<string, (data?: unknown) => unknown>(),
	condition: vi.fn(),
	patched: vi.fn(),
}));
vi.mock("@temporalio/workflow", () => ({
	defineSignal: (name: string) => name,
	defineQuery: (name: string) => name,
	defineUpdate: (name: string) => name,
	setHandler: (name: string, handler: (data?: unknown) => unknown) =>
		runtime.handlers.set(name, handler),
	patched: runtime.patched,
	deprecatePatch: vi.fn(),
	condition: runtime.condition,
	workflowInfo: () => ({ runId: "run-1" }),
	log: { info: vi.fn(), warn: vi.fn() },
}));

import { installApprovalController } from "../approval-controller";
import { createInitialState } from "../types";

const input = {
	userId: "user-1",
	organizationId: "org-1",
	executionId: "execution-1",
	executionMode: "balanced" as const,
	message: "Example",
	history: [],
};
function invoke(name: string, data?: unknown) {
	const handler = runtime.handlers.get(name);
	if (!handler) {
		throw new Error(`Missing handler ${name}`);
	}
	return handler(data);
}
beforeEach(() => {
	runtime.handlers.clear();
	runtime.condition.mockReset();
	runtime.patched.mockImplementation(() => true);
});
it("withholds pending approvals while preceding activities are still running", async () => {
	const state = createInitialState(input);
	const controller = installApprovalController(
		state,
		{ ...input, approvalProtocol: 2 },
		60_000,
	);
	state.pendingApproval = {
		approvalId: "approval-1",
		stepId: "step-1",
		reason: "Review",
	};
	expect(invoke("pendingApproval")).toBeNull();
	runtime.condition.mockImplementation(async () => {
		const pending = state.pendingApproval;
		expect(invoke("pendingApproval")).toMatchObject({
			approvalId: "approval-1",
			requestId: "run-1:1",
			runId: "run-1",
		});
		expect(
			invoke("decideApproval", {
				...pending,
				organizationId: input.organizationId,
				decidedBy: input.userId,
				approved: true,
			}),
		).toMatchObject({ accepted: true });
		expect(invoke("pendingApproval")).toBeNull();
		return true;
	});
	expect(
		await controller.waitForApproval({ requireExplicitDecision: true }),
	).toMatchObject({ approved: true });
	expect(invoke("pendingApproval")).toBeNull();
});
it("keeps legacy buffered decisions and enables acknowledged updates on old runs", async () => {
	runtime.patched.mockImplementation(
		(name) => name !== "orchestrator-bound-approvals-v1",
	);
	const state = createInitialState(input);
	const controller = installApprovalController(state, input, 60_000);
	state.pendingApproval = {
		approvalId: "approval-1",
		stepId: "step-1",
		reason: "Review",
	};
	invoke("approval", { approved: true });
	runtime.condition.mockImplementation(async (predicate) => {
		expect(predicate()).toBe(true);
		return true;
	});
	expect(await controller.waitForApproval()).toEqual({ approved: true });
	state.pendingApproval = {
		approvalId: "approval-2",
		stepId: "step-2",
		reason: "Review",
	};
	runtime.condition.mockImplementation(async () => {
		expect(
			invoke("decideApproval", {
				...state.pendingApproval,
				organizationId: input.organizationId,
				decidedBy: input.userId,
				approved: false,
			}),
		).toMatchObject({ accepted: true });
		return true;
	});
	expect(await controller.waitForApproval()).toMatchObject({
		approved: false,
	});
});
it("closes the gate when SDK cancellation interrupts the wait", async () => {
	const state = createInitialState(input);
	const controller = installApprovalController(
		state,
		{ ...input, approvalProtocol: 2 },
		60_000,
	);
	state.pendingApproval = {
		approvalId: "approval-1",
		stepId: "step-1",
		reason: "Review",
	};
	runtime.condition.mockRejectedValue(new Error("Cancelled"));
	await expect(controller.waitForApproval()).rejects.toThrow("Cancelled");
	expect(invoke("pendingApproval")).toBeNull();
	expect(
		invoke("decideApproval", {
			...state.pendingApproval,
			organizationId: input.organizationId,
			decidedBy: input.userId,
			approved: true,
		}),
	).toMatchObject({ accepted: false });
});
it("ignores stale signals and approve-all for explicit authority gates", async () => {
	const inputV2 = { ...input, approvalProtocol: 2 as const };
	const state = createInitialState(input);
	const controller = installApprovalController(state, inputV2, 60_000);
	state.pendingApproval = {
		approvalId: "approval-1",
		stepId: "step-1",
		reason: "Review",
	};
	runtime.condition.mockImplementation(async () => {
		invoke("approval", { approved: true, approvalId: "stale-approval" });
		invoke("autoApproveAll");
		expect(state.approvalDecision).toBeNull();
		expect(invoke("pendingApproval")).not.toBeNull();
		return false;
	});
	expect(
		await controller.waitForApproval({ requireExplicitDecision: true }),
	).toBeNull();
});

it.each([true, false])(
	"accepts legacy starter decisions on a new worker: %s",
	async (approved) => {
		const state = createInitialState(input);
		const controller = installApprovalController(state, input, 60_000);
		state.pendingApproval = {
			approvalId: "example-approval",
			stepId: "example-step",
			reason: "Review",
		};
		runtime.condition.mockImplementation(async (predicate) => {
			invoke("approval", { approved, approvalId: "example-approval" });
			expect(predicate()).toBe(true);
			return true;
		});
		expect(await controller.waitForApproval()).toMatchObject({ approved });
	},
);
it("preserves an explicit legacy wait when approve-all arrives", async () => {
	runtime.patched.mockImplementation(
		(name) => name === "orchestrator-authority-explicit-approval-v1",
	);
	const state = createInitialState(input);
	const controller = installApprovalController(state, input, 60_000);
	state.pendingApproval = {
		approvalId: "example-approval",
		stepId: "example-step",
		reason: "Review",
	};
	runtime.condition.mockImplementation(async (predicate) => {
		invoke("autoApproveAll");
		expect(predicate()).toBe(false);
		return false;
	});
	expect(
		await controller.waitForApproval({ requireExplicitDecision: true }),
	).toBeNull();
});

it.each([true, false])(
	"accepts rollback API signals for a protocol 2 run: %s",
	async (approved) => {
		const state = createInitialState(input);
		const controller = installApprovalController(
			state,
			{ ...input, approvalProtocol: 2 },
			60_000,
		);
		state.pendingApproval = {
			approvalId: "example-approval",
			stepId: "example-step",
			reason: "Review",
		};
		runtime.condition.mockImplementation(async (predicate) => {
			invoke("approval", {
				approved,
				approvalId: "example-approval",
				decidedBy: input.userId,
			});
			expect(predicate()).toBe(true);
			expect(invoke("pendingApproval")).toBeNull();
			return true;
		});
		expect(
			await controller.waitForApproval({ requireExplicitDecision: true }),
		).toMatchObject({ approved });
	},
);

it("legacy starts retain flag-only approve-all even when new patches are available", async () => {
	const state = createInitialState(input);
	const controller = installApprovalController(state, input, 60000);
	state.pendingApproval = {
		approvalId: "example-approval",
		stepId: "example-step",
		reason: "Review",
	};
	runtime.condition.mockImplementation(async () => {
		invoke("autoApproveAll");
		expect(state.approvalDecision).toBeNull();
		return false;
	});
	expect(await controller.waitForApproval()).toMatchObject({
		approved: true,
	});
});
