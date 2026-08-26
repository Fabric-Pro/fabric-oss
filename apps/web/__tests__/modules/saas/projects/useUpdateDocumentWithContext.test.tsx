/**
 * Tests for `useUpdateDocumentWithContext` (Flow B — "Update using context").
 *
 * Covers the three hardening guards:
 *   1. `start()` treats a normalized-identical preview as a no-op: it stays in
 *      the "idle" phase, shows an info toast, and never applies a diff.
 *   2. `confirm()` honors the server's `applied: false` backstop with an info
 *      toast (not a phantom success) and exits to idle.
 *   3. `confirm()` refuses to save an empty markdown extraction against a
 *      non-empty baseline: no RPC, an error toast, and the review stays open.
 *
 * We mock the oRPC client and sonner; the two pure guards stay real (they only
 * wrap the canonical comparator).
 */

import { act, renderHook } from "@testing-library/react";
import type { useEditor } from "@tiptap/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockUpdateWithContext, mockToast } = vi.hoisted(() => ({
	mockUpdateWithContext: vi.fn(),
	mockToast: { info: vi.fn(), success: vi.fn(), error: vi.fn() },
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			documents: {
				updateWithContext: (input: unknown) =>
					mockUpdateWithContext(input),
			},
		},
	},
}));

vi.mock("sonner", () => ({ toast: mockToast }));

import { useUpdateDocumentWithContext } from "@saas/projects/components/documents/useUpdateDocumentWithContext";

type EditorLike = ReturnType<typeof useEditor>;

function setup() {
	const setEditable = vi.fn();
	const setContent = vi.fn();
	const editor = {
		setEditable,
		commands: { setContent },
	} as unknown as EditorLike;
	const getEditorMarkdownForSave = vi.fn((_editor: EditorLike | null) => "");
	const fromMarkdown = vi.fn((md: string) => `html:${md}`);
	const diffPartialText = vi.fn(
		(baseline: string, next: string) => `diff:${baseline}=>${next}`,
	);
	const onSaved = vi.fn();

	const { result } = renderHook(() =>
		useUpdateDocumentWithContext({
			projectId: "p1",
			documentId: "d1",
			organizationId: null,
			editor,
			getEditorMarkdownForSave,
			fromMarkdown,
			diffPartialText,
			onSaved,
		}),
	);

	return {
		result,
		setEditable,
		setContent,
		getEditorMarkdownForSave,
		diffPartialText,
		onSaved,
	};
}

beforeEach(() => {
	mockUpdateWithContext.mockReset();
	mockToast.info.mockReset();
	mockToast.success.mockReset();
	mockToast.error.mockReset();
});

describe("useUpdateDocumentWithContext.start()", () => {
	it("treats a normalized-identical preview as a no-op — info toast, no diff, editor unlocked", async () => {
		const { result, setEditable, setContent, getEditorMarkdownForSave } =
			setup();
		getEditorMarkdownForSave.mockReturnValue("# Doc\n\nBody.");
		// Server flags relevant context, but the proposed content differs only
		// in trailing whitespace — the canonical comparator collapses it to a
		// no-op.
		mockUpdateWithContext.mockResolvedValueOnce({
			hasRelevantContext: true,
			summary: "",
			needsHumanResolution: false,
			proposedContent: "# Doc  \n\nBody.   ",
			documentVersion: 2,
		});

		await act(async () => {
			await result.current.start();
		});

		expect(mockToast.info).toHaveBeenCalledTimes(1);
		expect(setContent).not.toHaveBeenCalled();
		expect(result.current.showingDiff).toBe(false);
		expect(result.current.isActive).toBe(false);
		// Editor was locked during the RPC then unlocked on the no-op exit.
		expect(setEditable).toHaveBeenLastCalledWith(true);
	});

	it("enters the diff phase for a real change", async () => {
		const { result, setContent, getEditorMarkdownForSave } = setup();
		getEditorMarkdownForSave.mockReturnValue("# Doc");
		mockUpdateWithContext.mockResolvedValueOnce({
			hasRelevantContext: true,
			summary: "",
			needsHumanResolution: false,
			proposedContent: "# Doc — with a real added sentence.",
			documentVersion: 4,
		});

		await act(async () => {
			await result.current.start();
		});

		expect(result.current.showingDiff).toBe(true);
		expect(setContent).toHaveBeenCalledTimes(1);
		expect(mockToast.info).not.toHaveBeenCalled();
	});
});

describe("useUpdateDocumentWithContext.confirm()", () => {
	async function enterDiffPhase(
		result: ReturnType<typeof setup>["result"],
		getEditorMarkdownForSave: ReturnType<
			typeof setup
		>["getEditorMarkdownForSave"],
		baseline: string,
	) {
		getEditorMarkdownForSave.mockReturnValueOnce(baseline);
		mockUpdateWithContext.mockResolvedValueOnce({
			hasRelevantContext: true,
			summary: "",
			needsHumanResolution: false,
			proposedContent: `${baseline} — changed`,
			documentVersion: 4,
		});
		await act(async () => {
			await result.current.start();
		});
		expect(result.current.showingDiff).toBe(true);
	}

	it("honors applied:false with an info toast and exits to idle", async () => {
		const { result, getEditorMarkdownForSave } = setup();
		await enterDiffPhase(result, getEditorMarkdownForSave, "# Doc");

		// Confirm extraction succeeds (non-empty); server reports a no-op save.
		getEditorMarkdownForSave.mockReturnValueOnce("# Doc — changed");
		mockUpdateWithContext.mockResolvedValueOnce({
			applied: false,
			summary: "No changes were applied — matches current.",
			documentVersion: 4,
			document: { version: 4 },
		});

		await act(async () => {
			await result.current.confirm();
		});

		expect(mockToast.info).toHaveBeenCalledTimes(1);
		expect(mockToast.success).not.toHaveBeenCalled();
		expect(result.current.showingDiff).toBe(false);
		expect(result.current.isActive).toBe(false);
	});

	it("shows a version-bearing success toast on applied:true", async () => {
		const { result, getEditorMarkdownForSave } = setup();
		await enterDiffPhase(result, getEditorMarkdownForSave, "# Doc");

		getEditorMarkdownForSave.mockReturnValueOnce("# Doc — changed");
		mockUpdateWithContext.mockResolvedValueOnce({
			applied: true,
			summary: "Context update applied successfully.",
			documentVersion: 5,
			document: { version: 5 },
		});

		await act(async () => {
			await result.current.confirm();
		});

		expect(mockToast.success).toHaveBeenCalledTimes(1);
		expect(mockToast.success.mock.calls[0][0]).toContain("v5");
		expect(mockToast.info).not.toHaveBeenCalled();
	});

	it("refuses to save an empty extraction — no RPC, error toast, stays in diff", async () => {
		const { result, getEditorMarkdownForSave } = setup();
		await enterDiffPhase(result, getEditorMarkdownForSave, "# Doc");
		// One RPC so far (the preview).
		expect(mockUpdateWithContext).toHaveBeenCalledTimes(1);

		// Extraction fails on confirm — returns "" against a non-empty baseline.
		getEditorMarkdownForSave.mockReturnValueOnce("");

		await act(async () => {
			await result.current.confirm();
		});

		expect(mockToast.error).toHaveBeenCalledTimes(1);
		// No phase-2 RPC was issued.
		expect(mockUpdateWithContext).toHaveBeenCalledTimes(1);
		// Review remains recoverable.
		expect(result.current.showingDiff).toBe(true);
	});
});
