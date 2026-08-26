/**
 * PartyKit Publisher Hardening Tests
 *
 * Covers both Temporal-worker PartyKit publishers (task-agent and
 * orchestrator) and the task-agent broadcastProgress activity that wraps
 * them: none of these may ever reject, since every call site awaits them
 * bare — including a failure-path call inside a workflow's own catch block,
 * where a rejection would mask the workflow's real error.
 *
 * Run with: pnpm --filter @repo/temporal test __tests__/partykit-publisher.test.ts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The orchestrator publisher imports redis-publisher at module load; mock it
// so the import doesn't drag in the real ioredis client.
vi.mock("../src/lib/redis-publisher", () => ({
	publishExecutionEvent: vi.fn(async () => {}),
}));

describe("publishTaskAgentEvent", () => {
	beforeEach(() => {
		vi.resetModules();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("resolves and warns when fetch rejects", async () => {
		const fetchMock = vi.fn(async () => {
			throw new Error("network down");
		});
		vi.stubGlobal("fetch", fetchMock);
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

		const { publishTaskAgentEvent } = await import(
			"../src/activities/task-agent/partykit-publisher"
		);

		await expect(
			publishTaskAgentEvent({
				type: "agent_started",
				planId: "plan-1",
				data: {},
			}),
		).resolves.toBeUndefined();

		expect(warnSpy).toHaveBeenCalled();
	});

	it("resolves and warns when fetch returns a non-ok response", async () => {
		const fetchMock = vi.fn(async () => ({ ok: false, status: 500 }));
		vi.stubGlobal("fetch", fetchMock);
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

		const { publishTaskAgentEvent } = await import(
			"../src/activities/task-agent/partykit-publisher"
		);

		await expect(
			publishTaskAgentEvent({
				type: "agent_started",
				planId: "plan-1",
				data: {},
			}),
		).resolves.toBeUndefined();

		expect(warnSpy).toHaveBeenCalled();
	});

	it("sends an AbortSignal in the fetch options", async () => {
		const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
		const fetchMock = vi.fn(
			async (_url: string, _options?: RequestInit) =>
				({ ok: true, status: 200 }) as Response,
		);
		vi.stubGlobal("fetch", fetchMock);
		vi.spyOn(console, "warn").mockImplementation(() => {});

		const { publishTaskAgentEvent } = await import(
			"../src/activities/task-agent/partykit-publisher"
		);

		await publishTaskAgentEvent({
			type: "agent_started",
			planId: "plan-1",
			data: {},
		});

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const options = fetchMock.mock.calls[0][1];
		expect(options?.signal).toBeInstanceOf(AbortSignal);
		expect(timeoutSpy).toHaveBeenCalledWith(5000);
	});
});

describe("publishOrchestratorEvent", () => {
	beforeEach(() => {
		vi.resetModules();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("resolves and warns when fetch rejects", async () => {
		const fetchMock = vi.fn(async () => {
			throw new Error("network down");
		});
		vi.stubGlobal("fetch", fetchMock);
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

		const { publishOrchestratorEvent } = await import(
			"../src/activities/orchestrator/utils/partykit-publisher"
		);

		await expect(
			publishOrchestratorEvent({
				type: "heartbeat",
				executionId: "exec-1",
				data: {},
			}),
		).resolves.toBeUndefined();

		expect(warnSpy).toHaveBeenCalled();
	});

	it("resolves and warns when fetch returns a non-ok response", async () => {
		const fetchMock = vi.fn(async () => ({ ok: false, status: 500 }));
		vi.stubGlobal("fetch", fetchMock);
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

		const { publishOrchestratorEvent } = await import(
			"../src/activities/orchestrator/utils/partykit-publisher"
		);

		await expect(
			publishOrchestratorEvent({
				type: "heartbeat",
				executionId: "exec-1",
				data: {},
			}),
		).resolves.toBeUndefined();

		expect(warnSpy).toHaveBeenCalled();
	});

	it("sends an AbortSignal in the fetch options", async () => {
		const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
		const fetchMock = vi.fn(
			async (_url: string, _options?: RequestInit) =>
				({ ok: true, status: 200 }) as Response,
		);
		vi.stubGlobal("fetch", fetchMock);
		vi.spyOn(console, "warn").mockImplementation(() => {});

		const { publishOrchestratorEvent } = await import(
			"../src/activities/orchestrator/utils/partykit-publisher"
		);

		await publishOrchestratorEvent({
			type: "heartbeat",
			executionId: "exec-1",
			data: {},
		});

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const options = fetchMock.mock.calls[0][1];
		expect(options?.signal).toBeInstanceOf(AbortSignal);
		expect(timeoutSpy).toHaveBeenCalledWith(5000);
	});
});

describe("broadcastProgress", () => {
	beforeEach(() => {
		vi.resetModules();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		vi.doUnmock("../src/activities/task-agent/partykit-publisher");
	});

	it("resolves without throwing when the publisher's fetch rejects", async () => {
		const fetchMock = vi.fn(async () => {
			throw new Error("network down");
		});
		vi.stubGlobal("fetch", fetchMock);
		vi.spyOn(console, "warn").mockImplementation(() => {});

		const { broadcastProgress } = await import(
			"../src/activities/task-agent/broadcast"
		);

		await expect(
			broadcastProgress({
				planId: "plan-1",
				projectId: "project-1",
				type: "agent_failed",
				data: { error: "boom" },
			}),
		).resolves.toBeUndefined();
	});

	it("resolves and warns when the publisher module fails to load", async () => {
		vi.doMock("../src/activities/task-agent/partykit-publisher", () => {
			throw new Error("publisher module failed to load");
		});
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { broadcastProgress } = await import(
			"../src/activities/task-agent/broadcast"
		);

		await expect(
			broadcastProgress({
				planId: "plan-1",
				projectId: "project-1",
				type: "agent_failed",
				data: {},
			}),
		).resolves.toBeUndefined();
		expect(warnSpy).toHaveBeenCalled();

		vi.doUnmock("../src/activities/task-agent/partykit-publisher");
	});
});
