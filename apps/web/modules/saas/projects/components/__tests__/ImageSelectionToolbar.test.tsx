/**
 * Component tests for ImageSelectionToolbar.
 *
 * Tests rendering of size controls, caption editing,
 * delete action, and visibility logic.
 *
 * Since this component manages DOM overlays on TipTap editor images, we test
 * against a mock editor DOM rather than full TipTap integration.
 */

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImageSelectionToolbar } from "../ImageSelectionToolbar";

/**
 * Create a mock TipTap editor DOM with an image available for overlay creation.
 */
function createMockEditor(
	options: {
		includeImage?: boolean;
		imageAttrs?: Record<string, string>;
	} = {},
) {
	const { includeImage = true, imageAttrs = {} } = options;
	const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
	const editorDom = document.createElement("div");
	const imageWrapper = document.createElement("div");

	if (includeImage) {
		const img = document.createElement("img");
		img.setAttribute("src", "/test.png");
		img.setAttribute("alt", "Test image");
		img.setAttribute("data-width", "50%");
		for (const [key, value] of Object.entries(imageAttrs)) {
			img.setAttribute(key, value);
		}
		imageWrapper.appendChild(img);
		editorDom.appendChild(imageWrapper);
	}

	document.body.appendChild(editorDom);

	const editor = {
		isEditable: true,
		state: {
			doc: {
				nodeAt: vi.fn(() => ({ attrs: { caption: "" } })),
			},
		},
		commands: {
			focus: vi.fn(),
		},
		view: {
			dom: editorDom,
			posAtDOM: vi.fn(() => 0),
		},
		chain: vi.fn(() => {
			const chainMethods = {
				focus: vi.fn(() => chainMethods),
				setNodeSelection: vi.fn(() => chainMethods),
				updateAttributes: vi.fn(() => chainMethods),
				deleteSelection: vi.fn(() => chainMethods),
				run: vi.fn(),
			};
			return chainMethods;
		}),
		on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
			if (!listeners.has(event)) {
				listeners.set(event, new Set());
			}
			listeners.get(event)?.add(cb);
		}),
		off: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
			listeners.get(event)?.delete(cb);
		}),
		_emit: (event: string) => {
			for (const cb of listeners.get(event) ?? []) {
				cb();
			}
		},
	};

	return editor as unknown as Parameters<
		typeof ImageSelectionToolbar
	>[0]["editor"];
}

afterEach(() => {
	cleanup();
	document.body.innerHTML = "";
});

describe("ImageSelectionToolbar", () => {
	it("renders size buttons when an image is present", () => {
		const editor = createMockEditor();

		render(<ImageSelectionToolbar editor={editor} />);

		expect(
			screen.getByRole("button", { name: /image size s/i }),
		).toBeTruthy();
		expect(
			screen.getByRole("button", { name: /image size m/i }),
		).toBeTruthy();
		expect(
			screen.getByRole("button", { name: /image size l/i }),
		).toBeTruthy();
	});

	it("renders delete button when an image is present", () => {
		const editor = createMockEditor();

		render(<ImageSelectionToolbar editor={editor} />);

		expect(
			screen.getByRole("button", { name: /delete image/i }),
		).toBeTruthy();
	});

	it("renders caption edit button when an image is present", () => {
		const editor = createMockEditor();

		render(<ImageSelectionToolbar editor={editor} />);

		expect(
			screen.getByRole("button", { name: /add or edit caption/i }),
		).toBeTruthy();
	});

	it("does not render toolbar when no image exists", () => {
		const editor = createMockEditor({ includeImage: false });

		render(<ImageSelectionToolbar editor={editor} />);

		expect(screen.queryByRole("toolbar")).toBeNull();
	});

	it("has toolbar role with correct aria-label", () => {
		const editor = createMockEditor();

		render(<ImageSelectionToolbar editor={editor} />);

		const toolbar = screen.getByRole("toolbar");
		expect(toolbar.getAttribute("aria-label")).toBe("Image options");
	});

	it("shows caption input when edit caption button is clicked", async () => {
		const user = userEvent.setup();
		const editor = createMockEditor();

		render(<ImageSelectionToolbar editor={editor} />);

		await user.click(
			screen.getByRole("button", { name: /add or edit caption/i }),
		);

		expect(screen.getByRole("textbox", { name: /caption/i })).toBeTruthy();
	});
});
