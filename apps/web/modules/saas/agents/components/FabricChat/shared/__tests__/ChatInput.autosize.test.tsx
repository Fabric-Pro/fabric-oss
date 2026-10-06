/**
 * The chat composer grows with its text up to 200px and only scrolls past
 * that. Before this, the default variant kept its two-row height, so a long
 * prompt scrolled inside a sliver of a text box.
 */

import { render, screen } from "@testing-library/react";
import { TooltipProvider } from "@ui/components/tooltip";
import { describe, expect, it, vi } from "vitest";
import { ChatInput } from "../ChatInput";

vi.mock("next-intl", () => ({
	useTranslations: () => (key: string) => key,
}));

const { mentionStub } = vi.hoisted(() => ({
	mentionStub: () => ({
		setSearchQuery: vi.fn(),
		isOpen: false,
		setIsOpen: vi.fn(),
		selectedIndex: 0,
		setSelectedIndex: vi.fn(),
		results: [],
		isLoading: false,
		selectItem: vi.fn(),
		handleKeyDown: vi.fn(() => false),
	}),
}));

vi.mock("../../../../hooks/useFileMention", () => ({
	useFileMention: mentionStub,
}));
vi.mock("../../../../hooks/useStoryMention", () => ({
	useStoryMention: mentionStub,
}));
vi.mock("../../../../hooks/useUserMention", () => ({
	useUserMention: mentionStub,
}));
vi.mock("../../../../hooks/useTemplateMention", () => ({
	useTemplateMention: () => ({
		...mentionStub(),
		selectedTemplates: [],
		mergedInstructions: null,
		mergedIntegrationIds: [],
		mergedMcpConfigIds: [],
		mergedFabricToolIds: [],
		selectTemplate: vi.fn(),
		removeTemplate: vi.fn(),
	}),
}));

// jsdom does no layout, so scrollHeight is always 0. Model it the way a
// browser does once height is "auto": the larger of the text's line count and
// the textarea's rows (two when unset), so a variant switch changes it too.
const LINE_HEIGHT = 24;
Object.defineProperty(HTMLTextAreaElement.prototype, "scrollHeight", {
	configurable: true,
	get(this: HTMLTextAreaElement) {
		const lines = this.value.split("\n").length;
		return (
			Math.max(lines, Number(this.getAttribute("rows") ?? 2)) *
			LINE_HEIGHT
		);
	},
});

function ui(value: string, variant: "default" | "hero") {
	return (
		<TooltipProvider>
			<ChatInput
				value={value}
				onChange={vi.fn()}
				onSend={vi.fn()}
				variant={variant}
			/>
		</TooltipProvider>
	);
}

function renderInput(value: string, variant: "default" | "hero" = "default") {
	const { rerender } = render(ui(value, variant));
	return {
		textarea: screen.getByRole("textbox") as HTMLTextAreaElement,
		rerender: (next: string, nextVariant = variant) =>
			rerender(ui(next, nextVariant)),
	};
}

const LONG_TEXT = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");

describe("ChatInput textarea auto-size", () => {
	it("grows the default variant to fit its text without scrolling", () => {
		const { textarea } = renderInput("one\ntwo\nthree\nfour");

		expect(textarea.style.height).toBe(`${4 * LINE_HEIGHT}px`);
		expect(textarea.style.overflowY).toBe("hidden");
	});

	it("caps the height at 200px and scrolls beyond it", () => {
		const { textarea } = renderInput(LONG_TEXT);

		expect(textarea.style.height).toBe("200px");
		expect(textarea.style.overflowY).toBe("auto");
	});

	it("shrinks back once the text is cleared after sending", () => {
		const { textarea, rerender } = renderInput(LONG_TEXT);
		rerender("");

		expect(textarea.style.height).toBe(`${2 * LINE_HEIGHT}px`);
		expect(textarea.style.overflowY).toBe("hidden");
	});

	it("still sizes the hero variant from one line", () => {
		const { textarea } = renderInput("", "hero");

		expect(textarea.style.height).toBe(`${LINE_HEIGHT}px`);
		expect(textarea.style.overflowY).toBe("hidden");
	});

	it("re-measures when only the variant changes", () => {
		const { textarea, rerender } = renderInput("", "hero");
		rerender("", "default");

		expect(textarea.style.height).toBe(`${2 * LINE_HEIGHT}px`);
	});
});
