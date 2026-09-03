/**
 * `CopilotChatSessionProvider` — the whole point of this component is that
 * `useCopilotChatInternal()` runs ONCE per surface no matter how many
 * consumers read the chat state, because on CopilotKit 1.70 every call of that
 * hook opens its own `agent/connect` (Fizzy #2389: 16 connects on opening a
 * feature, one agent run mirrored into 5 response streams).
 *
 * So the call count is the assertion that matters here — if a future refactor
 * reintroduces a per-consumer hook call, this test goes red before the network
 * tab does.
 */

import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const useCopilotChatInternalMock = vi.fn();

vi.mock("@copilotkit/react-core", () => ({
	useCopilotChatInternal: () => useCopilotChatInternalMock(),
}));

// Import AFTER vi.mock so the provider sees the stubbed hook.
import {
	CopilotChatSessionProvider,
	useCopilotChatSession,
} from "../CopilotChatSessionProvider";

const SESSION = {
	messages: [{ id: "m1", role: "user", content: "hi" }],
	visibleMessages: [],
	isLoading: false,
	appendMessage: async () => {},
	setMessages: () => {},
	interrupt: null,
	agent: { isRunning: false },
};

function Consumer({ label }: { label: string }) {
	const { messages, isLoading } = useCopilotChatSession();
	return (
		<div data-testid={label}>
			{messages.length}:{String(isLoading)}
		</div>
	);
}

afterEach(() => {
	useCopilotChatInternalMock.mockReset();
});

describe("CopilotChatSessionProvider", () => {
	it("calls useCopilotChatInternal once no matter how many consumers read it", () => {
		useCopilotChatInternalMock.mockReturnValue(SESSION);

		render(
			<CopilotChatSessionProvider>
				<Consumer label="a" />
				<Consumer label="b" />
				<Consumer label="c" />
				<Consumer label="d" />
				<Consumer label="e" />
			</CopilotChatSessionProvider>,
		);

		expect(useCopilotChatInternalMock).toHaveBeenCalledTimes(1);
		for (const label of ["a", "b", "c", "d", "e"]) {
			expect(screen.getByTestId(label)).toHaveTextContent("1:false");
		}
	});

	it("hands every consumer the same session object", () => {
		useCopilotChatInternalMock.mockReturnValue(SESSION);
		const seen: unknown[] = [];

		function Collector() {
			seen.push(useCopilotChatSession());
			return null;
		}

		render(
			<CopilotChatSessionProvider>
				<Collector />
				<Collector />
			</CopilotChatSessionProvider>,
		);

		expect(seen).toHaveLength(2);
		expect(seen[0]).toBe(SESSION);
		expect(seen[1]).toBe(SESSION);
	});

	it("throws a provider-naming error when used outside the provider", () => {
		useCopilotChatInternalMock.mockReturnValue(SESSION);
		// React logs the render error to console.error before rethrowing;
		// silence it so the failure output stays readable.
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});

		try {
			expect(() => render(<Consumer label="orphan" />)).toThrow(
				/CopilotChatSessionProvider/,
			);
		} finally {
			consoleError.mockRestore();
		}

		// The orphan never reached the hook's provider, so nothing connected.
		expect(useCopilotChatInternalMock).not.toHaveBeenCalled();
	});
});
