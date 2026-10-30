import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { TopicAssistantVisibility } from "../../modules/saas/projects/components/publishing-suite/TopicAssistantVisibility";
import {
	ChatContextProvider,
	useChatContext,
} from "../../node_modules/@copilotkit/react-ui/src/components/chat/ChatContext";
import { Input } from "../../node_modules/@copilotkit/react-ui/src/components/chat/Input";
import { Window } from "../../node_modules/@copilotkit/react-ui/src/components/chat/Window";

vi.mock(
	"@copilotkit/react-ui",
	() =>
		import(
			"../../node_modules/@copilotkit/react-ui/src/components/chat/ChatContext"
		),
);
vi.mock("@copilotkit/react-core", () => ({
	useCopilotMessagesContext: () => ({ messages: [] }),
	useCopilotContext: () => ({ copilotApiConfig: {} }),
	useCopilotChatInternal: () => ({ isLoading: false }),
}));

function Surface({ active }: { active: boolean }) {
	const [open, setOpen] = useState(true);
	return (
		<ChatContextProvider open={open} setOpen={setOpen}>
			<Controls active={active} />
		</ChatContextProvider>
	);
}
function Controls({ active }: { active: boolean }) {
	const { open, setOpen } = useChatContext();
	return (
		<>
			<output aria-label="Assistant open">{String(open)}</output>
			<button type="button" onClick={() => setOpen(false)}>
				Close
			</button>
			<TopicAssistantVisibility isActive={active} />
			<div hidden={!active} inert={!active}>
				<Window
					clickOutsideToClose={false}
					hitEscapeToClose={active}
					shortcut={active ? "/" : ""}
				>
					<Input inProgress={false} chatReady onSend={vi.fn()} />
				</Window>
			</div>
		</>
	);
}
afterEach(() => {
	vi.unstubAllGlobals();
	document.body.removeAttribute("style");
});
it.each([true, false])(
	"releases mobile scroll lock, blocks keys and restores composer and prior open=%s",
	(wasOpen) => {
		const vv = new EventTarget();
		Object.assign(vv, { height: 600, offsetLeft: 0, offsetTop: 0 });
		vi.stubGlobal("visualViewport", vv);
		vi.stubGlobal("innerWidth", 1000);
		const page = render(<Surface active />);
		const input = screen.getByRole("textbox");
		fireEvent.change(input, {
			target: { value: "Example unsent composer" },
		});
		if (!wasOpen)
			fireEvent.click(screen.getByRole("button", { name: "Close" }));
		vi.stubGlobal("innerWidth", 375);
		fireEvent(vv, new Event("resize"));
		if (wasOpen) expect(document.body.style.position).toBe("fixed");
		page.rerender(<Surface active={false} />);
		fireEvent(vv, new Event("resize"));
		for (const key of [
			{ key: "Escape" },
			{ key: "/", ctrlKey: true },
			{ key: "/", metaKey: true },
		])
			fireEvent.keyDown(document.body, key);
		expect(screen.getByLabelText("Assistant open")).toHaveTextContent(
			"false",
		);
		expect(document.body.style.position).not.toBe("fixed");
		expect(document.body.style.overflow).not.toBe("hidden");
		const touch = new Event("touchmove", { cancelable: true });
		document.body.dispatchEvent(touch);
		expect(touch.defaultPrevented).toBe(false);
		page.rerender(<Surface active />);
		expect(screen.getByLabelText("Assistant open")).toHaveTextContent(
			String(wasOpen),
		);
		expect(input).toBeInTheDocument();
		expect(input).toHaveValue("Example unsent composer");
	},
);
