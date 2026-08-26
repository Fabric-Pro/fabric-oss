import { act, renderHook } from "@testing-library/react";
import type { Editor } from "@tiptap/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DOCUMENT_TOC_DEBOUNCE_MS } from "../../lib/document-toc";
import { useDocumentToc } from "../use-document-toc";

interface FakeHeading {
	text: string;
	level: number;
	pos: number;
}

/**
 * Structural stand-in for `editor.state.doc`: enough surface for
 * `extractDocumentToc` (descendants) and click-time validation (nodeAt,
 * content.size).
 */
function makeDoc(headings: FakeHeading[], size = 10_000) {
	return {
		content: { size },
		descendants(
			callback: (node: unknown, pos: number) => boolean | undefined,
		) {
			for (const heading of headings) {
				callback(
					{
						type: { name: "heading" },
						attrs: { level: heading.level },
						textContent: heading.text,
					},
					heading.pos,
				);
			}
		},
		nodeAt(pos: number) {
			const match = headings.find((heading) => heading.pos === pos);
			return match
				? { type: { name: "heading" }, textContent: match.text }
				: null;
		},
	};
}

function makeFakeEditor(headings: FakeHeading[]) {
	const updateHandlers = new Set<() => void>();
	const headingDom = document.createElement("h2");
	const chain = {
		setTextSelection: vi.fn(),
		focus: vi.fn(),
		run: vi.fn(),
	};
	chain.setTextSelection.mockReturnValue(chain);
	chain.focus.mockReturnValue(chain);

	const editor = {
		isDestroyed: false,
		state: { doc: makeDoc(headings) },
		view: {
			nodeDOM: vi.fn(() => headingDom),
		},
		commands: { scrollIntoView: vi.fn() },
		chain: vi.fn(() => chain),
		on: vi.fn((event: string, handler: () => void) => {
			if (event === "update") {
				updateHandlers.add(handler);
			}
		}),
		off: vi.fn((event: string, handler: () => void) => {
			if (event === "update") {
				updateHandlers.delete(handler);
			}
		}),
	};

	return {
		editor: editor as unknown as Editor,
		raw: editor,
		chain,
		headingDom,
		setHeadings(next: FakeHeading[]) {
			editor.state = { doc: makeDoc(next) };
		},
		fireUpdate() {
			for (const handler of updateHandlers) {
				handler();
			}
		},
		get updateHandlerCount() {
			return updateHandlers.size;
		},
	};
}

describe("useDocumentToc", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("computes the ToC synchronously on mount", () => {
		const fake = makeFakeEditor([
			{ text: "Overview", level: 1, pos: 0 },
			{ text: "Scope", level: 2, pos: 20 },
		]);

		const { result } = renderHook(() => useDocumentToc(fake.editor));

		expect(result.current.items.map((item) => item.id)).toEqual([
			"overview",
			"scope",
		]);
	});

	it("returns no items and a no-op navigator for a null editor", () => {
		const { result } = renderHook(() => useDocumentToc(null));

		expect(result.current.items).toEqual([]);
		expect(
			result.current.navigateToHeading({
				id: "overview",
				text: "Overview",
				level: 1,
				pos: 0,
			}),
		).toBe(false);
	});

	it("coalesces rapid updates into one debounced recompute", () => {
		const fake = makeFakeEditor([{ text: "Overview", level: 1, pos: 0 }]);
		const { result } = renderHook(() => useDocumentToc(fake.editor));

		fake.setHeadings([
			{ text: "Overview", level: 1, pos: 0 },
			{ text: "Details", level: 2, pos: 30 },
		]);
		act(() => {
			fake.fireUpdate();
			fake.fireUpdate();
			fake.fireUpdate();
		});

		// Still the old list inside the debounce window.
		expect(result.current.items).toHaveLength(1);

		act(() => {
			vi.advanceTimersByTime(DOCUMENT_TOC_DEBOUNCE_MS);
		});

		expect(result.current.items.map((item) => item.id)).toEqual([
			"overview",
			"details",
		]);
	});

	it("keeps the same items reference when only positions shift, but navigates with fresh positions", () => {
		const fake = makeFakeEditor([{ text: "Overview", level: 1, pos: 10 }]);
		const { result } = renderHook(() => useDocumentToc(fake.editor));
		const initialItems = result.current.items;

		fake.setHeadings([{ text: "Overview", level: 1, pos: 250 }]);
		act(() => {
			fake.fireUpdate();
			vi.advanceTimersByTime(DOCUMENT_TOC_DEBOUNCE_MS);
		});

		expect(result.current.items).toBe(initialItems);

		const navigated = result.current.navigateToHeading(initialItems[0]);
		expect(navigated).toBe(true);
		expect(fake.raw.view.nodeDOM).toHaveBeenCalledWith(250);
	});

	it("scrolls the heading DOM node and places the selection inside the heading", () => {
		const fake = makeFakeEditor([{ text: "Overview", level: 1, pos: 40 }]);
		const scrollSpy = vi.spyOn(fake.headingDom, "scrollIntoView");
		const { result } = renderHook(() => useDocumentToc(fake.editor));

		const navigated = result.current.navigateToHeading(
			result.current.items[0],
		);

		expect(navigated).toBe(true);
		expect(scrollSpy).toHaveBeenCalledWith({
			block: "start",
			behavior: "smooth",
		});
		expect(fake.chain.setTextSelection).toHaveBeenCalledWith(41);
		expect(fake.chain.focus).toHaveBeenCalledWith(undefined, {
			scrollIntoView: false,
		});
		expect(fake.chain.run).toHaveBeenCalled();
	});

	it("uses an instant scroll when the user prefers reduced motion", () => {
		const fake = makeFakeEditor([{ text: "Overview", level: 1, pos: 0 }]);
		const scrollSpy = vi.spyOn(fake.headingDom, "scrollIntoView");
		vi.mocked(window.matchMedia).mockImplementation(
			(query: string) =>
				({
					matches: query === "(prefers-reduced-motion: reduce)",
					media: query,
					addEventListener: vi.fn(),
					removeEventListener: vi.fn(),
				}) as unknown as MediaQueryList,
		);
		const { result } = renderHook(() => useDocumentToc(fake.editor));

		result.current.navigateToHeading(result.current.items[0]);

		expect(scrollSpy).toHaveBeenCalledWith({
			block: "start",
			behavior: "auto",
		});
	});

	it("recovers from a stale position by re-extracting and matching by id", () => {
		const fake = makeFakeEditor([{ text: "Overview", level: 1, pos: 10 }]);
		const { result } = renderHook(() => useDocumentToc(fake.editor));
		const item = result.current.items[0];

		// The heading moved, but no update event has fired yet (mid-debounce).
		fake.setHeadings([{ text: "Overview", level: 1, pos: 300 }]);

		const navigated = result.current.navigateToHeading(item);

		expect(navigated).toBe(true);
		expect(fake.raw.view.nodeDOM).toHaveBeenCalledWith(300);
	});

	it("refuses a cached position that a different heading has shifted onto", () => {
		const fake = makeFakeEditor([
			{ text: "Overview", level: 1, pos: 10 },
			{ text: "Scope", level: 2, pos: 90 },
		]);
		const { result } = renderHook(() => useDocumentToc(fake.editor));
		const overview = result.current.items[0];

		// Content between them is deleted inside the debounce window and
		// "Scope" lands exactly on the position "Overview" used to hold.
		fake.setHeadings([{ text: "Scope", level: 2, pos: 10 }]);

		// Type alone would accept pos 10 and scroll to the wrong section;
		// the text check rejects it and no id match remains.
		expect(result.current.navigateToHeading(overview)).toBe(false);
		expect(fake.raw.view.nodeDOM).not.toHaveBeenCalled();
	});

	it("survives an extraction failure instead of breaking the editor tree", () => {
		const fake = makeFakeEditor([{ text: "Overview", level: 1, pos: 0 }]);
		fake.raw.state = {
			doc: {
				content: { size: 100 },
				descendants() {
					throw new Error("malformed node");
				},
				nodeAt: () => null,
			},
		} as unknown as typeof fake.raw.state;

		expect(() =>
			renderHook(() => useDocumentToc(fake.editor)),
		).not.toThrow();
	});

	it("returns false without scrolling when the heading was deleted", () => {
		const fake = makeFakeEditor([{ text: "Overview", level: 1, pos: 10 }]);
		const { result } = renderHook(() => useDocumentToc(fake.editor));
		const item = result.current.items[0];

		fake.setHeadings([]);

		expect(result.current.navigateToHeading(item)).toBe(false);
		expect(fake.raw.view.nodeDOM).not.toHaveBeenCalled();
		expect(fake.chain.run).not.toHaveBeenCalled();
	});

	it("falls back to the editor's own scroll when the heading has no DOM node", () => {
		const fake = makeFakeEditor([{ text: "Overview", level: 1, pos: 10 }]);
		fake.raw.view.nodeDOM.mockReturnValue(null);
		const { result } = renderHook(() => useDocumentToc(fake.editor));

		expect(result.current.navigateToHeading(result.current.items[0])).toBe(
			true,
		);
		expect(fake.raw.commands.scrollIntoView).toHaveBeenCalled();
	});

	it("returns false when scrolling throws instead of surfacing the error", () => {
		const fake = makeFakeEditor([{ text: "Overview", level: 1, pos: 10 }]);
		fake.raw.view.nodeDOM.mockImplementation(() => {
			throw new Error("detached view");
		});
		const { result } = renderHook(() => useDocumentToc(fake.editor));

		expect(result.current.navigateToHeading(result.current.items[0])).toBe(
			false,
		);
	});

	it("unsubscribes and cancels the pending recompute on unmount", () => {
		const fake = makeFakeEditor([{ text: "Overview", level: 1, pos: 0 }]);
		const { unmount } = renderHook(() => useDocumentToc(fake.editor));

		act(() => {
			fake.fireUpdate();
		});
		unmount();

		expect(fake.updateHandlerCount).toBe(0);
		expect(fake.raw.off).toHaveBeenCalledWith(
			"update",
			expect.any(Function),
		);
		// The pending debounce timer was cleared with the effect.
		expect(vi.getTimerCount()).toBe(0);
	});
});
