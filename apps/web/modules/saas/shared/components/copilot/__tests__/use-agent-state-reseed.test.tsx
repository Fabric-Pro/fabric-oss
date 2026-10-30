import { act, renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useReseedAgentStateOnRunStart } from "../use-agent-state-reseed";

const reseedHarness = vi.hoisted(() => ({
	subscriber: undefined as any,
	unsubscribe: vi.fn(),
	subscribe: vi.fn(),
}));
vi.mock("@copilotkit/react-core/v2", () => ({
	useCopilotKit: () => ({ copilotkit: reseedHarness }),
}));
reseedHarness.subscribe.mockImplementation((subscriber: any) => {
	reseedHarness.subscriber = subscriber;
	return { unsubscribe: reseedHarness.unsubscribe };
});

it("reseeds matching agents with live state, uses the latest callback, and cleans up", () => {
	const first = vi.fn((state) => ({ ...state, value: 1 }));
	const latest = vi.fn((state) => ({ ...state, value: 2 }));
	const { rerender, unmount } = renderHook(
		({ seed }) => useReseedAgentStateOnRunStart("example", seed),
		{ initialProps: { seed: first } },
	);
	const agent = {
		agentId: "example",
		state: { live: true },
		setState: vi.fn(),
	};
	act(() => reseedHarness.subscriber.onAgentRunStarted({ agent }));
	expect(first).toHaveBeenCalledWith(agent.state);
	expect(agent.setState).toHaveBeenLastCalledWith({ live: true, value: 1 });
	const other = { ...agent, agentId: "other", setState: vi.fn() };
	act(() => reseedHarness.subscriber.onAgentRunStarted({ agent: other }));
	expect(other.setState).not.toHaveBeenCalled();
	rerender({ seed: latest });
	act(() => reseedHarness.subscriber.onAgentRunStarted({ agent }));
	expect(agent.setState).toHaveBeenLastCalledWith({ live: true, value: 2 });
	expect(reseedHarness.subscribe).toHaveBeenCalledTimes(1);
	unmount();
	expect(reseedHarness.unsubscribe).toHaveBeenCalledTimes(1);
});
