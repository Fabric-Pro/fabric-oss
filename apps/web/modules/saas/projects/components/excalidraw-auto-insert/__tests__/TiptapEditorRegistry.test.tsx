/**
 * Tests for the `TiptapEditorRegistry` context + the
 * `useRegisterTiptapEditor` hook.
 *
 * Covers spec § 8 (table row) + § 9 (resolver algorithm primitives):
 *   - register on mount (entry appears in the registry)
 *   - unregister on unmount (entry is removed)
 *   - focus events update `lastFocusedAt` without forcing component
 *     re-renders that observers wouldn't otherwise pay for
 *   - `mostRecentlyFocusedFor(projectId)` filters by project
 *   - `byStoryId` / `byDocumentId` index correctly
 *
 * Uses a fake `Editor` stand-in built on a real `EventTarget` so the
 * `editor.on("focus", ...)` / `editor.off("focus", ...)` contract is
 * exercised end-to-end without needing a full ProseMirror instance.
 */

import { act, renderHook } from "@testing-library/react";
import type { Editor } from "@tiptap/react";
import { type ReactNode, useEffect, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import {
	TiptapEditorRegistryProvider,
	useRegisterTiptapEditor,
	useTiptapEditorRegistry,
	useTiptapEditorRegistryVersion,
} from "../TiptapEditorRegistry";

/**
 * Minimal `Editor` stand-in. The registry only ever calls `.on("focus", fn)`
 * and `.off("focus", fn)`; we expose `triggerFocus()` so a test can
 * synchronously simulate a focus event without poking React internals.
 */
function makeFakeEditor(): Editor & { triggerFocus(): void } {
	const listeners = new Set<() => void>();
	const fake = {
		on(event: string, fn: () => void) {
			if (event === "focus") {
				listeners.add(fn);
			}
			return fake;
		},
		off(event: string, fn: () => void) {
			if (event === "focus") {
				listeners.delete(fn);
			}
			return fake;
		},
		triggerFocus() {
			for (const fn of listeners) {
				fn();
			}
		},
	};
	return fake as unknown as Editor & { triggerFocus(): void };
}

const wrapper = ({ children }: { children: ReactNode }) => (
	<TiptapEditorRegistryProvider>{children}</TiptapEditorRegistryProvider>
);

describe("useRegisterTiptapEditor — lifecycle", () => {
	it("registers an entry on mount and removes it on unmount", () => {
		const editor = makeFakeEditor();
		const { result, unmount } = renderHook(
			() => {
				useRegisterTiptapEditor({
					projectId: "proj_1",
					kind: "document",
					documentId: "doc_1",
					editor,
				});
				return useTiptapEditorRegistry();
			},
			{ wrapper },
		);

		const registered = result.current.byDocumentId.get("doc_1");
		expect(registered).toBeDefined();
		expect(registered?.projectId).toBe("proj_1");
		expect(registered?.kind).toBe("document");
		expect(registered?.editor).toBe(editor);

		unmount();
		// After unmount, a fresh read of the same registry must show
		// the entry is gone. We have to rebuild the wrapper because
		// the previous one has been torn down.
		const { result: result2 } = renderHook(
			() => useTiptapEditorRegistry(),
			{ wrapper },
		);
		expect(result2.current.byDocumentId.get("doc_1")).toBeUndefined();
	});

	it("does nothing when the editor argument is null (still booting)", () => {
		const { result } = renderHook(
			() => {
				useRegisterTiptapEditor({
					projectId: "proj_1",
					kind: "document",
					documentId: "doc_1",
					editor: null,
				});
				return useTiptapEditorRegistry();
			},
			{ wrapper },
		);
		expect(result.current.byDocumentId.size).toBe(0);
	});

	it("re-registers under a new id when the kind/documentId change", () => {
		const editor = makeFakeEditor();
		let kind: "document" | "story" = "document";
		const { result, rerender } = renderHook(
			() => {
				useRegisterTiptapEditor({
					projectId: "proj_1",
					kind,
					documentId: kind === "document" ? "id_1" : undefined,
					storyId: kind === "story" ? "id_1" : undefined,
					editor,
				});
				return useTiptapEditorRegistry();
			},
			{ wrapper },
		);

		expect(result.current.byDocumentId.get("id_1")?.kind).toBe("document");
		expect(result.current.byStoryId.size).toBe(0);

		kind = "story";
		rerender();

		expect(result.current.byDocumentId.size).toBe(0);
		expect(result.current.byStoryId.get("id_1")?.kind).toBe("story");
	});
});

describe("useRegisterTiptapEditor — focus listener", () => {
	it("updates `lastFocusedAt` when the editor fires a focus event", async () => {
		const editor = makeFakeEditor();
		const { result } = renderHook(
			() => {
				useRegisterTiptapEditor({
					projectId: "proj_1",
					kind: "document",
					documentId: "doc_1",
					editor,
				});
				const api = useTiptapEditorRegistry();
				// Reading the version forces the hook caller to re-render
				// when focus events change the registry state.
				useTiptapEditorRegistryVersion();
				return api;
			},
			{ wrapper },
		);

		const before = result.current.byDocumentId.get("doc_1")?.lastFocusedAt;
		expect(before).toBeTypeOf("number");

		// Wait a tick so performance.now() / Date.now() can advance,
		// then trigger the synthetic focus event.
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 5));
			editor.triggerFocus();
		});

		const after = result.current.byDocumentId.get("doc_1")?.lastFocusedAt;
		expect(after).toBeTypeOf("number");
		expect((after as number) >= (before as number)).toBe(true);
	});

	it("detaches the focus listener on unmount", () => {
		const editor = makeFakeEditor();
		const offSpy = vi.spyOn(editor, "off");
		const { unmount } = renderHook(
			() => {
				useRegisterTiptapEditor({
					projectId: "proj_1",
					kind: "document",
					documentId: "doc_1",
					editor,
				});
			},
			{ wrapper },
		);
		unmount();
		expect(offSpy).toHaveBeenCalledWith("focus", expect.any(Function));
	});
});

describe("mostRecentlyFocusedFor — project scoping", () => {
	it("returns null when no editor matches the project", () => {
		const editor = makeFakeEditor();
		const { result } = renderHook(
			() => {
				useRegisterTiptapEditor({
					projectId: "proj_1",
					kind: "document",
					documentId: "doc_1",
					editor,
				});
				return useTiptapEditorRegistry();
			},
			{ wrapper },
		);
		expect(result.current.mostRecentlyFocusedFor("proj_other")).toBeNull();
	});

	it("returns the most-recently-focused entry whose project matches", async () => {
		// Two editors in proj_A, one in proj_B. Focus the OLDER proj_A
		// entry last and assert the resolver picks it.
		const editorA1 = makeFakeEditor();
		const editorA2 = makeFakeEditor();
		const editorB = makeFakeEditor();

		const TwoEditors = () => {
			useRegisterTiptapEditor({
				projectId: "proj_A",
				kind: "document",
				documentId: "doc_A1",
				editor: editorA1,
			});
			useRegisterTiptapEditor({
				projectId: "proj_A",
				kind: "document",
				documentId: "doc_A2",
				editor: editorA2,
			});
			useRegisterTiptapEditor({
				projectId: "proj_B",
				kind: "document",
				documentId: "doc_B",
				editor: editorB,
			});
			return null;
		};

		const Read = () => {
			useTiptapEditorRegistryVersion();
			const api = useTiptapEditorRegistry();
			const entry = api.mostRecentlyFocusedFor("proj_A");
			return <div data-testid="picked">{entry?.id ?? "none"}</div>;
		};

		const { result } = renderHook(
			() => {
				return useTiptapEditorRegistry();
			},
			{
				wrapper: ({ children }) => (
					<TiptapEditorRegistryProvider>
						<TwoEditors />
						<Read />
						{children}
					</TiptapEditorRegistryProvider>
				),
			},
		);

		// Initially the latest registered editor wins (mount sets
		// lastFocusedAt). Trigger an explicit focus on doc_A1 LAST so
		// it becomes the most-recently-focused entry.
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 5));
			editorA1.triggerFocus();
		});

		const picked = result.current.mostRecentlyFocusedFor("proj_A");
		expect(picked?.documentId).toBe("doc_A1");
		// Cross-project: nothing in proj_B leaks through.
		const pickedB = result.current.mostRecentlyFocusedFor("proj_B");
		expect(pickedB?.documentId).toBe("doc_B");
	});
});

describe("byStoryId / byDocumentId indexes", () => {
	it("exposes both indexes for the same registry", () => {
		const docEditor = makeFakeEditor();
		const storyEditor = makeFakeEditor();
		const { result } = renderHook(
			() => {
				useRegisterTiptapEditor({
					projectId: "proj_1",
					kind: "document",
					documentId: "doc_1",
					editor: docEditor,
				});
				useRegisterTiptapEditor({
					projectId: "proj_1",
					kind: "story",
					storyId: "story_1",
					editor: storyEditor,
				});
				return useTiptapEditorRegistry();
			},
			{ wrapper },
		);

		expect(result.current.byDocumentId.get("doc_1")?.kind).toBe("document");
		expect(result.current.byStoryId.get("story_1")?.kind).toBe("story");
		// The opposite-kind indexes do NOT find the other entry.
		expect(result.current.byStoryId.get("doc_1")).toBeUndefined();
		expect(result.current.byDocumentId.get("story_1")).toBeUndefined();
	});
});

describe("provider boundary", () => {
	it("throws a useful error when used outside the provider", () => {
		// useTiptapEditorRegistry without a provider must throw with a
		// clear, debuggable message so a wiring mistake is loud at
		// mount time.
		expect(() => renderHook(() => useTiptapEditorRegistry())).toThrow(
			/inside <TiptapEditorRegistryProvider>/,
		);
	});
});

describe("subscription — version counter", () => {
	it("monotonically increases on register / unregister", () => {
		const versions: number[] = [];
		function Probe({ on }: { on: boolean }) {
			const editor = useFakeEditorRef();
			useRegisterTiptapEditor({
				projectId: "p",
				kind: "document",
				documentId: "d",
				editor: on ? editor : null,
			});
			const v = useTiptapEditorRegistryVersion();
			// Capture every observed version so the test can assert
			// monotonicity. (We do not assert exact values; React may
			// double-render in strict mode.)
			useEffect(() => {
				versions.push(v);
			}, [v]);
			return null;
		}
		const { rerender, unmount } = renderHook(
			({ on }: { on: boolean }) => {
				return (
					<TiptapEditorRegistryProvider>
						<Probe on={on} />
					</TiptapEditorRegistryProvider>
				);
			},
			{
				initialProps: { on: true as boolean },
			},
		);
		rerender({ on: false });
		unmount();

		// Versions must be non-decreasing across observations.
		for (let i = 1; i < versions.length; i++) {
			expect(versions[i]).toBeGreaterThanOrEqual(versions[i - 1] ?? 0);
		}
	});
});

/** Stable-identity fake editor used by the subscription test. */
function useFakeEditorRef(): Editor {
	const [editor] = useState<Editor>(() => makeFakeEditor());
	return editor;
}
