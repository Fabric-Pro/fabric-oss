import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DIFF_VIEW_MODE_STORAGE_KEY } from "../../lib/diff-view-modes";
import { useDiffPreview, useDiffViewMode } from "../use-diff-view-mode";

afterEach(() => {
	window.localStorage.clear();
	vi.restoreAllMocks();
});

describe("useDiffViewMode", () => {
	it("defaults to inline when storage is empty", () => {
		const { result } = renderHook(() => useDiffViewMode());
		expect(result.current.mode).toBe("inline");
	});

	it("persists a chosen mode and reads it back on a fresh instance", async () => {
		const first = renderHook(() => useDiffViewMode());
		act(() => {
			first.result.current.setMode("sideBySide");
		});
		expect(first.result.current.mode).toBe("sideBySide");
		expect(window.localStorage.getItem(DIFF_VIEW_MODE_STORAGE_KEY)).toBe(
			"sideBySide",
		);
		first.unmount();

		// Simulate reload / re-login: a brand-new hook instance.
		const second = renderHook(() => useDiffViewMode());
		await waitFor(() => {
			expect(second.result.current.mode).toBe("sideBySide");
		});
	});

	it("falls back to inline for an unknown stored value", async () => {
		window.localStorage.setItem(DIFF_VIEW_MODE_STORAGE_KEY, "garbage");
		const { result } = renderHook(() => useDiffViewMode());
		await waitFor(() => {
			expect(result.current.mode).toBe("inline");
		});
	});

	it("normalizes an invalid argument passed to setMode", () => {
		const { result } = renderHook(() => useDiffViewMode());
		act(() => {
			(result.current.setMode as (m: string) => void)("not-a-mode");
		});
		expect(result.current.mode).toBe("inline");
	});

	it("does not crash when localStorage.getItem throws", () => {
		vi.spyOn(window.localStorage, "getItem").mockImplementation(() => {
			throw new Error("storage disabled");
		});
		expect(() => renderHook(() => useDiffViewMode())).not.toThrow();
		const { result } = renderHook(() => useDiffViewMode());
		expect(result.current.mode).toBe("inline");
	});

	it("does not crash when localStorage.setItem throws; mode still updates", () => {
		vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
			throw new Error("quota exceeded");
		});
		const { result } = renderHook(() => useDiffViewMode());
		act(() => {
			result.current.setMode("fullPreview");
		});
		// In-memory state still advances even though persistence failed.
		expect(result.current.mode).toBe("fullPreview");
	});
});

const DIFF_PREVIEW_HTML =
	'<p>keep <ins class="diff-ins">added </ins><del class="diff-del">gone </del>text</p>';

function fakeEditor(html: string) {
	return {
		getHTML: () => html,
		state: { doc: {} },
	} as unknown as Parameters<typeof useDiffPreview>[0];
}

describe("useDiffPreview", () => {
	it("returns inline / no panes when the review is not active", () => {
		const { result } = renderHook(() =>
			useDiffPreview(fakeEditor(DIFF_PREVIEW_HTML), false),
		);
		expect(result.current.diffViews).toBeNull();
		expect(result.current.effectiveDiffViewMode).toBe("inline");
		expect(result.current.showDiffPreviewPanes).toBe(false);
	});

	it("returns inline / no panes for a null editor", () => {
		const { result } = renderHook(() => useDiffPreview(null, true));
		expect(result.current.diffViews).toBeNull();
		expect(result.current.showDiffPreviewPanes).toBe(false);
	});

	it("stays inline (no derivation) when the stored mode is the default", () => {
		const { result } = renderHook(() =>
			useDiffPreview(fakeEditor(DIFF_PREVIEW_HTML), true),
		);
		expect(result.current.diffViewMode).toBe("inline");
		expect(result.current.diffViews).toBeNull();
		expect(result.current.showDiffPreviewPanes).toBe(false);
	});

	it("derives panes when active and a non-inline mode is stored", async () => {
		window.localStorage.setItem(DIFF_VIEW_MODE_STORAGE_KEY, "sideBySide");
		const { result } = renderHook(() =>
			useDiffPreview(fakeEditor(DIFF_PREVIEW_HTML), true),
		);
		await waitFor(() => {
			expect(result.current.diffViewMode).toBe("sideBySide");
		});
		expect(result.current.effectiveDiffViewMode).toBe("sideBySide");
		expect(result.current.showDiffPreviewPanes).toBe(true);
		expect(result.current.diffViews?.originalHtml).toContain("gone ");
		expect(result.current.diffViews?.originalHtml).not.toContain("added ");
		expect(result.current.diffViews?.proposedHtml).toContain("added ");
		expect(result.current.diffViews?.cleanProposedHtml).not.toContain(
			"<ins",
		);
	});
});
