import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => {
	const listeners = new Set<Record<string, (args: any) => void>>();
	const agent = {
		state: {} as Record<string, unknown>,
		subscribe: (subscriber: any) => {
			listeners.add(subscriber);
			return { unsubscribe: () => listeners.delete(subscriber) };
		},
		setState: (state: any) => {
			agent.state = structuredClone(state);
			for (const s of listeners) {
				s.onStateChanged?.({ state });
			}
		},
	};
	const runtimeListeners = new Set<Record<string, (args: any) => void>>();
	const runtime = {
		agents: { example: agent },
		subscribe: (subscriber: any) => {
			runtimeListeners.add(subscriber);
			return { unsubscribe: () => runtimeListeners.delete(subscriber) };
		},
	};
	return { agent, listeners, runtime, runtimeListeners };
});
vi.mock("@copilotkit/react-core/v2", () => ({
	useAgent: vi.fn(() => ({ agent: fake.agent })),
	useCopilotKit: () => ({ copilotkit: fake.runtime }),
}));
vi.mock("@copilotkit/react-core/v2/context", () => ({
	useCopilotKit: () => ({ copilotkit: fake.runtime }),
}));

import { useAgent } from "@copilotkit/react-core/v2";
import { usePageAgent } from "../use-page-agent";

const seed = {
	document: "",
	focusAnchor: "",
	error: undefined,
	proposalPatchedSectionKeys: ["example-section"] as string[] | undefined,
};
function emit(name: string, args = {}) {
	act(() => {
		for (const s of fake.listeners) {
			s[name]?.(args);
		}
	});
}
beforeEach(() => {
	fake.listeners.clear();
	fake.runtimeListeners.clear();
	fake.agent.state = { ...seed };
});
describe("page agent render cost", () => {
	for (const [page, keys] of [
		["StoryWorkspace", ["document", "focusAnchor"]],
		[
			"DocumentEditorInner",
			["document", "focusAnchor", "error", "proposalPatchedSectionKeys"],
		],
	] as const) {
		it(`usePageAgent with ${page} fields ignores unread state and observes document and node changes`, () => {
			let renders = 0;
			const hook = renderHook(() => {
				renders++;
				return usePageAgent("example", seed, keys);
			});
			expect(useAgent).toHaveBeenLastCalledWith({
				agentId: "example",
				updates: [],
			});
			const before = renders;
			for (let i = 0; i < 8; i++) {
				act(() =>
					fake.agent.setState({
						...fake.agent.state,
						reasoningByTurn: { i },
					}),
				);
				emit("onMessagesChanged");
				emit("onRunInitialized", { state: fake.agent.state });
			}
			expect(renders).toBe(before);
			act(() =>
				fake.agent.setState({
					...fake.agent.state,
					document: "updated",
				}),
			);
			expect(renders).toBe(before + 1);
			emit("onStepStartedEvent", { event: { stepName: "write" } });
			expect(hook.result.current.nodeName).toBe("write");
			emit("onCustomEvent", { event: { name: "on_interrupt" } });
			emit("onRunFinishedEvent", { outcome: "success" });
			expect(hook.result.current.nodeName).toBe("write");
			emit("onRunStartedEvent");
			expect(hook.result.current.nodeName).toBe("start");
			emit("onRunFinishedEvent", { outcome: "success" });
			expect(hook.result.current.nodeName).toBe("end");
			hook.unmount();
			expect(fake.listeners.size).toBe(0);
		});
	}
	it("merges partial writes with live state and replaces functional writes", () => {
		const hook = renderHook(() =>
			usePageAgent("example", seed, ["document"]),
		);
		act(() => fake.agent.setState({ document: "old", extra: true }));
		act(() =>
			hook.result.current.setState({ document: "new" } as typeof seed),
		);
		expect(fake.agent.state).toEqual({ document: "new", extra: true });
		act(() =>
			hook.result.current.setState((prev) => ({
				...seed,
				document: `${prev.document}!`,
			})),
		);
		expect(fake.agent.state).toEqual({ ...seed, document: "new!" });
	});
});

it("seeds an empty run before send and retains existing state", () => {
	const hook = renderHook(() => usePageAgent("example", seed, ["document"]));
	act(() => {
		fake.agent.state = {};
		for (const listener of fake.runtimeListeners) {
			listener.onAgentRunStarted?.({
				agent: { ...fake.agent, agentId: "example" },
			});
		}
	});
	expect(fake.agent.state).toEqual(seed);
	emit("onRunInitialized", { state: { document: "existing" } });
	expect(fake.agent.state.document).toBe("existing");
	hook.unmount();
	expect(fake.runtimeListeners.size).toBe(0);
});
