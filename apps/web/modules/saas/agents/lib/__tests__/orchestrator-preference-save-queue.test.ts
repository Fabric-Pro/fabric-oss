import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	enqueueOrchestratorPreferences as enqueue,
	flushOrchestratorPreferences as flush,
	getUnsentOrchestratorPreferences as readUnsent,
	resetOrchestratorPreferenceSaveQueueForTests,
	subscribeOrchestratorPreferenceSaveQueue as subscribe,
} from "../orchestrator-preference-save-queue";

const mocks = vi.hoisted(() => ({
	update: vi.fn(),
	error: vi.fn(),
	dismiss: vi.fn(),
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { users: { orchestratorPreferences: mocks } },
}));
vi.mock("sonner", () => ({
	toast: { error: mocks.error, dismiss: mocks.dismiss },
}));

const owner = { userId: "example-user", organizationId: "example-org" };
const getUser = () => "example-user";

beforeEach(() => {
	vi.useFakeTimers();
	resetOrchestratorPreferenceSaveQueueForTests();
	mocks.update.mockReset().mockResolvedValue({});
	mocks.error.mockReset().mockReturnValue("example-sync-error");
	mocks.dismiss.mockReset();
	vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("orchestrator preference save queue", () => {
	it("reads in-flight fields overlaid by pending fields and clears settled fields", async () => {
		let finish!: () => void;
		mocks.update.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					finish = resolve;
				}),
		);
		enqueue(
			owner,
			{ enabledAgentIds: ["example-old-agent"], enabledWorkspaceIds: [] },
			getUser,
		);
		const running = flush(owner);
		expect(readUnsent(owner)).toEqual({
			enabledAgentIds: ["example-old-agent"],
			enabledWorkspaceIds: [],
		});
		enqueue(owner, { enabledAgentIds: [] }, getUser);
		expect(readUnsent(owner)).toEqual({
			enabledAgentIds: [],
			enabledWorkspaceIds: [],
		});
		expect(
			readUnsent({ ...owner, organizationId: "example-org-b" }),
		).toEqual({});
		expect(readUnsent({ ...owner, userId: "example-user-b" })).toEqual({});
		finish();
		await running;
		expect(readUnsent(owner)).toEqual({ enabledAgentIds: [] });
		await flush(owner);
		expect(readUnsent(owner)).toEqual({});
	});

	it("reads retry-backoff fields and retains them after failure", async () => {
		mocks.update.mockRejectedValue(new Error("Example failure"));
		enqueue(
			owner,
			{ enabledMcpConfigIds: ["oauth:integration:example-integration"] },
			getUser,
		);
		const running = flush(owner);
		await vi.advanceTimersByTimeAsync(1000);
		expect(readUnsent(owner)).toEqual({
			enabledMcpConfigIds: ["oauth:integration:example-integration"],
		});
		await vi.advanceTimersByTimeAsync(6000);
		await running;
		expect(readUnsent(owner)).toEqual({
			enabledMcpConfigIds: ["oauth:integration:example-integration"],
		});
		resetOrchestratorPreferenceSaveQueueForTests();
		expect(readUnsent(owner)).toEqual({});
	});

	it("isolates fields by both user and organization", async () => {
		const otherOrg = { ...owner, organizationId: "example-org-b" };
		const otherUser = { ...owner, userId: "example-user-b" };
		enqueue(owner, { enabledAgentIds: ["example-agent"] }, getUser);
		enqueue(otherOrg, { enabledWorkspaceIds: [] }, getUser);
		enqueue(otherUser, { enabledMcpConfigIds: [] }, () => "example-user-b");
		await flush(owner);
		await flush(otherOrg);
		await flush(otherUser);
		expect(mocks.update.mock.calls.map(([input]) => input)).toEqual([
			{
				organizationId: "example-org",
				enabledAgentIds: ["example-agent"],
			},
			{ organizationId: "example-org-b", enabledWorkspaceIds: [] },
			{ organizationId: "example-org", enabledMcpConfigIds: [] },
		]);
	});

	it("allows one send per key and drains after the last subscriber leaves", async () => {
		let finish!: () => void;
		mocks.update.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					finish = resolve;
				}),
		);
		const listener = vi.fn();
		const unsubscribe = subscribe(owner, getUser, listener);
		enqueue(owner, { enabledAgentIds: [] }, getUser);
		const running = flush(owner);
		enqueue(owner, { enabledAgentIds: ["example-new-agent"] }, getUser);
		await flush(owner);
		unsubscribe();
		expect(mocks.update).toHaveBeenCalledTimes(1);
		listener.mockClear();
		finish();
		await running;
		await vi.advanceTimersByTimeAsync(0);
		expect(mocks.update).toHaveBeenLastCalledWith({
			organizationId: "example-org",
			enabledAgentIds: ["example-new-agent"],
		});
		expect(listener).not.toHaveBeenCalled();
	});

	it("skips superseded fields before retrying and sends the latest pending fields", async () => {
		mocks.update.mockRejectedValueOnce(new Error("Example failure"));
		enqueue(
			owner,
			{ enabledAgentIds: [], enabledWorkspaceIds: [] },
			getUser,
		);
		const running = flush(owner);
		await vi.advanceTimersByTimeAsync(0);
		enqueue(owner, { enabledAgentIds: ["example-new-agent"] }, getUser);
		await flush(owner);
		await vi.advanceTimersByTimeAsync(1000);
		await running;
		expect(mocks.update.mock.calls.map(([input]) => input)).toEqual([
			{
				organizationId: "example-org",
				enabledAgentIds: [],
				enabledWorkspaceIds: [],
			},
			{ organizationId: "example-org", enabledWorkspaceIds: [] },
			{
				organizationId: "example-org",
				enabledAgentIds: ["example-new-agent"],
			},
		]);
	});

	it("requeues failures without overwriting newer fields or looping automatically", async () => {
		mocks.update.mockRejectedValue(new Error("Example failure"));
		enqueue(
			owner,
			{ enabledAgentIds: [], enabledWorkspaceIds: [] },
			getUser,
		);
		const running = flush(owner);
		await vi.advanceTimersByTimeAsync(3000);
		let rejectLast!: (error: Error) => void;
		mocks.update.mockImplementationOnce(
			() =>
				new Promise<void>((_resolve, reject) => {
					rejectLast = reject;
				}),
		);
		await vi.advanceTimersByTimeAsync(4000);
		enqueue(owner, { enabledAgentIds: ["example-new-agent"] }, getUser);
		rejectLast(new Error("Example last failure"));
		await running;
		await vi.advanceTimersByTimeAsync(10000);
		expect(mocks.update).toHaveBeenCalledTimes(4);
		mocks.update.mockResolvedValue({});
		await flush(owner);
		expect(mocks.update).toHaveBeenLastCalledWith({
			organizationId: "example-org",
			enabledAgentIds: ["example-new-agent"],
			enabledWorkspaceIds: [],
		});
	});

	it("retains failed fields after the last subscriber unmounts", async () => {
		mocks.update.mockRejectedValue(new Error("Example failure"));
		const listener = vi.fn();
		const unsubscribe = subscribe(owner, getUser, listener);
		enqueue(owner, { enabledAgentIds: [] }, getUser);
		const running = flush(owner);
		unsubscribe();
		listener.mockClear();
		await vi.advanceTimersByTimeAsync(7000);
		await running;
		expect(listener).not.toHaveBeenCalled();
		mocks.update.mockResolvedValue({});
		await flush(owner);
		expect(mocks.update).toHaveBeenLastCalledWith({
			organizationId: "example-org",
			enabledAgentIds: [],
		});
	});

	it("reports dropped and clears a previous Retry notice after a session change", async () => {
		let sessionUser = "example-user";
		const getSessionUser = () => sessionUser;
		const listener = vi.fn();
		subscribe(owner, getSessionUser, listener);
		mocks.update.mockRejectedValue(new Error("Example failure"));
		enqueue(owner, { enabledAgentIds: [] }, getSessionUser);
		const running = flush(owner);
		await vi.advanceTimersByTimeAsync(7000);
		await running;
		expect(mocks.error).toHaveBeenCalledOnce();
		sessionUser = "example-user-b";
		await flush(owner);
		expect(listener).toHaveBeenLastCalledWith("dropped");
		expect(readUnsent(owner)).toEqual({});
		expect(mocks.dismiss).toHaveBeenCalledWith("example-sync-error");
		expect(mocks.error).toHaveBeenCalledOnce();
		sessionUser = "example-user";
		await flush(owner);
		expect(mocks.update).toHaveBeenCalledTimes(4);
	});

	it("only dismisses the successful key's error notice", async () => {
		const other = { ...owner, organizationId: "example-org-b" };
		mocks.error
			.mockReturnValueOnce("example-error-a")
			.mockReturnValueOnce("example-error-b");
		mocks.update.mockRejectedValue(new Error("Example failure"));
		enqueue(owner, { enabledAgentIds: [] }, getUser);
		const first = flush(owner);
		await vi.advanceTimersByTimeAsync(7000);
		await first;
		enqueue(other, { enabledWorkspaceIds: [] }, getUser);
		const second = flush(other);
		await vi.advanceTimersByTimeAsync(7000);
		await second;
		mocks.update.mockResolvedValue({});
		await flush(owner);
		expect(mocks.dismiss.mock.calls).toEqual([["example-error-a"]]);
		await flush(other);
		expect(mocks.dismiss.mock.calls).toEqual([
			["example-error-a"],
			["example-error-b"],
		]);
	});
});
