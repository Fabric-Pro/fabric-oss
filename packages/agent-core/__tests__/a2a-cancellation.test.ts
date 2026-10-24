import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { describe, expect, it, vi } from "vitest";
import {
	type A2AAgentExecutor,
	type A2AExecutionResult,
	A2AServer,
	type A2AStreamEvent,
} from "../src/a2a/server";

const message = {
	role: "user" as const,
	parts: [{ type: "text" as const, text: "hello" }],
};
function server(executor: A2AAgentExecutor) {
	return new A2AServer(
		{
			name: "example-agent",
			description: "Example",
			url: "http://example.com",
			skills: [],
		},
		executor,
	);
}
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("A2A request cancellation", () => {
	it("forwards abort and keeps a late result from completing the stored task", async () => {
		const controller = new AbortController();
		const late = deferred<A2AExecutionResult>();
		const started = deferred<AbortSignal | undefined>();
		const a2a = server({
			execute: async (_message, _context, _metadata, signal) => {
				started.resolve(signal);
				return late.promise;
			},
		});
		const pending = a2a
			.createHandlers()
			.sendMessage({ message }, controller.signal);
		const received = await started.promise;
		controller.abort();
		const { task } = await (await pending).json();
		late.resolve({ response: "late result" });
		await late.promise;
		expect(received).toBe(controller.signal);
		expect(received?.aborted).toBe(true);
		expect(a2a.getTask(task.id)?.status).toBe("canceled");
		expect(a2a.getTask(task.id)?.messages).toEqual([message]);
	});
	it("completes a connected request", async () => {
		const a2a = server({ execute: async () => ({ response: "done" }) });
		const controller = new AbortController();
		const task = await a2a.handleSendMessage(
			message,
			undefined,
			undefined,
			controller.signal,
		);
		expect(task.status).toBe("completed");
		controller.abort();
		expect(a2a.getTask(task.id)?.status).toBe("completed");
	});
	it("cancels a stream while next is pending without consuming more events", async () => {
		const controller = new AbortController();
		const next = deferred<IteratorResult<A2AStreamEvent>>();
		const started = deferred<AbortSignal | undefined>();
		const nextEvent = vi.fn(() => next.promise);
		const close = vi.fn(async () => ({
			done: true as const,
			value: undefined,
		}));
		const a2a = server({
			execute: async () => ({ response: "unused" }),
			executeStream: (_message, _context, _metadata, signal) => {
				started.resolve(signal);
				return {
					next: nextEvent,
					return: close,
					[Symbol.asyncIterator]() {
						return this;
					},
				} as AsyncGenerator<A2AStreamEvent>;
			},
		});
		const stream = a2a.handleSendMessageStream(
			message,
			undefined,
			undefined,
			controller.signal,
		);
		const submitted = await stream.next();
		await stream.next();
		const pending = stream.next();
		const received = await started.promise;
		controller.abort();
		const canceled = await pending;
		expect(received).toBe(controller.signal);
		expect(canceled.value).toMatchObject({ status: "canceled" });
		expect(a2a.getTask(submitted.value.taskId)?.status).toBe("canceled");
		next.resolve({ done: false, value: { type: "text", text: "late" } });
		expect((await stream.next()).done).toBe(true);
		expect(nextEvent).toHaveBeenCalledTimes(1);
		expect(close).toHaveBeenCalledTimes(1);
	});
	it("does not start an already aborted request", async () => {
		const execute = vi.fn(async () => ({ response: "unused" }));
		const a2a = server({ execute });
		const task = await a2a.handleSendMessage(
			message,
			undefined,
			undefined,
			AbortSignal.abort(),
		);
		expect(task.status).toBe("canceled");
		expect(execute).not.toHaveBeenCalled();
	});
});

it("does not schedule another model or tool node after cancellation", async () => {
	const started = deferred<void>();
	const release = deferred<void>();
	const model = vi.fn(async () => {
		started.resolve();
		await release.promise;
		return {};
	});
	const tool = vi.fn(async () => ({}));
	const graph = new StateGraph(
		Annotation.Root({ response: Annotation<string>() }),
	)
		.addNode("model", model)
		.addNode("tool", tool)
		.addEdge(START, "model")
		.addEdge("model", "tool")
		.addEdge("tool", END)
		.compile();
	let settled!: Promise<unknown>;
	const a2a = server({
		execute: async (_message, _context, _metadata, signal) => {
			const run = graph.invoke({}, { signal });
			settled = run.catch(() => undefined);
			await run;
			return { response: "done" };
		},
	});
	const controller = new AbortController();
	const pending = a2a.handleSendMessage(
		message,
		undefined,
		undefined,
		controller.signal,
	);
	await started.promise;
	controller.abort();
	release.resolve();
	const task = await pending;
	await settled;
	expect(task.status).toBe("canceled");
	expect(model).toHaveBeenCalledTimes(1);
	expect(tool).not.toHaveBeenCalled();
});
