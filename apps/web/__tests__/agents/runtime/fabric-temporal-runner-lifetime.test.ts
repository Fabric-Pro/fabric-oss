// @vitest-environment node
import {
	type AGUIEvent,
	type BaseEvent,
	EventType,
	type RunAgentInput,
} from "@ag-ui/client";
import type { RuntimeEngine } from "@saas/agents/runtime/engine";
import {
	FabricRuntimeAgent,
	FabricTemporalRunner,
} from "@saas/agents/runtime/fabric-temporal-runner";
import { lastValueFrom, toArray } from "rxjs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const background = vi.hoisted(() =>
	vi.fn<(promise: Promise<unknown>) => void>(),
);
vi.mock("@repo/api/modules/weave/lib/run-in-background", () => ({
	runInBackground: background,
}));

const AGENT = "agent-example";
const THREAD = "thread-example-1";
const INPUT: RunAgentInput = {
	threadId: THREAD,
	runId: "run-example-1",
	messages: [],
	tools: [],
	context: [],
	state: {},
};

function fixture() {
	const engine = {
		run: vi.fn<RuntimeEngine["run"]>().mockResolvedValue(undefined),
		connect: vi.fn<RuntimeEngine["connect"]>().mockResolvedValue(undefined),
		isRunning: vi.fn<RuntimeEngine["isRunning"]>().mockResolvedValue(true),
		stop: vi.fn<RuntimeEngine["stop"]>().mockResolvedValue(false),
	};
	const runner = new FabricTemporalRunner({ [AGENT]: engine }, 60_000);
	const agent = new FabricRuntimeAgent();
	agent.agentId = AGENT;
	return {
		engine,
		runner,
		run: () => runner.run({ threadId: THREAD, agent, input: INPUT }),
	};
}

beforeEach(() => background.mockReset());

describe("runtime producer lifetime", () => {
	it("registers before producing and retains cleanup after disconnect until persistence completes", async () => {
		const { engine, runner, run } = fixture();
		const disconnected = Promise.withResolvers<void>();
		const write = Promise.withResolvers<void>();
		const finished = Promise.withResolvers<void>();
		const order: string[] = [];
		let persisted = false;
		background.mockImplementation(() => {
			order.push("registered");
		});
		engine.run.mockImplementation(async (_request, stream) => {
			order.push("producer");
			try {
				await disconnected.promise;
				expect(stream.isClosed()).toBe(true);
				await write.promise;
				persisted = true;
			} finally {
				finished.resolve();
			}
		});
		const subscription = run().subscribe();
		try {
			expect(order).toEqual(["registered", "producer"]);
			subscription.unsubscribe();
			disconnected.resolve();
			let hostFinished = false;
			const retained = Promise.all(
				background.mock.calls.map(([promise]) => promise),
			);
			void retained.then(() => {
				hostFinished = true;
			});
			await Promise.resolve();
			expect(hostFinished).toBe(false);
			expect(persisted).toBe(false);
			expect(await runner.isRunning({ threadId: THREAD })).toBe(true);
			expect(engine.stop).not.toHaveBeenCalled();

			write.resolve();
			await retained;
			expect(persisted).toBe(true);
			expect(engine.stop).not.toHaveBeenCalled();
		} finally {
			subscription.unsubscribe();
			disconnected.resolve();
			write.resolve();
			await finished.promise;
		}
	});

	it("settles a successful producer while preserving its events", async () => {
		const { engine, run } = fixture();
		engine.run.mockImplementation(async (_request, stream) => {
			stream.emit({
				type: EventType.RUN_STARTED,
				threadId: THREAD,
				runId: INPUT.runId,
			});
			stream.emit({
				type: EventType.RUN_FINISHED,
				threadId: THREAD,
				runId: INPUT.runId,
			});
		});

		const events = await lastValueFrom(run().pipe(toArray()));
		expect(events.map((event) => event.type)).toEqual([
			EventType.RUN_STARTED,
			EventType.RUN_FINISHED,
		]);
		expect(background).toHaveBeenCalledOnce();
		await expect(background.mock.calls[0]?.[0]).resolves.toBeUndefined();
	});

	it("settles an admission refusal without keeping a rejected request alive", async () => {
		const { engine, run } = fixture();
		const refusal: AGUIEvent = {
			type: EventType.RUN_ERROR,
			code: "FORBIDDEN",
			message: "Not allowed.",
		};
		engine.run.mockImplementation(async (_request, stream) =>
			stream.emit(refusal),
		);

		expect(await lastValueFrom(run().pipe(toArray()))).toEqual([refusal]);
		expect(background).toHaveBeenCalledOnce();
		await expect(background.mock.calls[0]?.[0]).resolves.toBeUndefined();
	});

	it("settles the retained continuation when an engine throws synchronously", async () => {
		const { engine, run } = fixture();
		const failure = new Error("engine failed");
		engine.run.mockImplementation(() => {
			throw failure;
		});

		await expect(lastValueFrom(run())).rejects.toBe(failure);
		expect(background).toHaveBeenCalledOnce();
		await expect(background.mock.calls[0]?.[0]).resolves.toBeUndefined();
	});

	it("retains connect cleanup only until its observer detaches", async () => {
		const { engine, runner } = fixture();
		const detached = Promise.withResolvers<void>();
		const seen: BaseEvent[] = [];
		engine.connect.mockImplementation(async (_thread, stream) => {
			await detached.promise;
			expect(stream.isClosed()).toBe(true);
		});
		const subscription = runner
			.connect({ agentId: AGENT, threadId: THREAD })
			.subscribe((event) => seen.push(event));
		try {
			expect(background).toHaveBeenCalledOnce();
			subscription.unsubscribe();
			detached.resolve();
			await expect(
				background.mock.calls[0]?.[0],
			).resolves.toBeUndefined();
			expect(seen).toEqual([]);
			expect(engine.stop).not.toHaveBeenCalled();
		} finally {
			subscription.unsubscribe();
			detached.resolve();
			await engine.connect.mock.results[0]?.value;
		}
	});
});
