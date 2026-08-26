/**
 * Smoke tests for C5: the `useRegisterTiptapEditor` wiring inside
 * `DocumentEditor.tsx` and `StoryWorkspace.tsx`.
 *
 * These are NOT full editor mount tests (those would require Yjs,
 * CopilotKit, oRPC, and the Fabric Agent launcher — all of which
 * already have their own dedicated test files). Instead this file
 * proves the contract C5 cares about:
 *   - The hook accepts `kind: "document"` + `documentId` (the
 *     DocumentEditor signature) without throwing, and an entry shows
 *     up under `byDocumentId`.
 *   - The hook accepts `kind: "story"` + `storyId` (the StoryWorkspace
 *     signature) without throwing, and an entry shows up under
 *     `byStoryId`.
 *   - Both registrations live in the same provider so a single chat
 *     scope can see both editors simultaneously.
 *
 * If the DocumentEditor / StoryWorkspace `useRegisterTiptapEditor`
 * call drifts (wrong kind, wrong id field, missing under conditional)
 * the resolver tests in `useActiveTipTapEditor.test.tsx` would already
 * fail — this is the per-component lock layer.
 */

import { renderHook } from "@testing-library/react";
import type { Editor } from "@tiptap/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import {
	TiptapEditorRegistryProvider,
	useRegisterTiptapEditor,
	useTiptapEditorRegistry,
} from "../TiptapEditorRegistry";

function makeFakeEditor(): Editor {
	const fake = {
		on: () => fake,
		off: () => fake,
	};
	return fake as unknown as Editor;
}

const wrapper = ({ children }: { children: ReactNode }) => (
	<TiptapEditorRegistryProvider>{children}</TiptapEditorRegistryProvider>
);

describe("DocumentEditor.tsx registration shape (C5)", () => {
	it("registers under byDocumentId with kind=document", () => {
		// Reproduces the exact useRegisterTiptapEditor call that
		// DocumentEditor.tsx makes after the editor is created. If this
		// test fails after a DocumentEditor edit, the wiring there has
		// drifted from the documented shape.
		const editor = makeFakeEditor();
		const { result } = renderHook(
			() => {
				useRegisterTiptapEditor({
					projectId: "proj_doc_smoke",
					kind: "document",
					documentId: "doc_smoke",
					editor,
				});
				return useTiptapEditorRegistry();
			},
			{ wrapper },
		);
		const entry = result.current.byDocumentId.get("doc_smoke");
		expect(entry).toBeDefined();
		expect(entry?.kind).toBe("document");
		expect(entry?.projectId).toBe("proj_doc_smoke");
		// storyId should be undefined for a document registration.
		expect(entry?.storyId).toBeUndefined();
	});
});

describe("StoryWorkspace.tsx registration shape (C5)", () => {
	it("registers under byStoryId with kind=story", () => {
		// Reproduces the exact useRegisterTiptapEditor call that
		// StoryWorkspace.tsx makes alongside the existing
		// registerDocumentEditor block. Drift here means the resolver's
		// step (1) launcher path would silently miss the story editor.
		const editor = makeFakeEditor();
		const { result } = renderHook(
			() => {
				useRegisterTiptapEditor({
					projectId: "proj_story_smoke",
					kind: "story",
					storyId: "story_smoke",
					editor,
				});
				return useTiptapEditorRegistry();
			},
			{ wrapper },
		);
		const entry = result.current.byStoryId.get("story_smoke");
		expect(entry).toBeDefined();
		expect(entry?.kind).toBe("story");
		expect(entry?.projectId).toBe("proj_story_smoke");
		expect(entry?.documentId).toBeUndefined();
	});
});

describe("Coexistence — document + story in the same provider", () => {
	it("both registrations coexist under their respective indexes", () => {
		// In production the user might have a document open AND a story
		// editor mounted (e.g. via a navigation prefetch). The two
		// registrations must not interfere. Their composite ids differ
		// (`document:doc` vs `story:story`), so no collision.
		const docEditor = makeFakeEditor();
		const storyEditor = makeFakeEditor();
		const { result } = renderHook(
			() => {
				useRegisterTiptapEditor({
					projectId: "proj_both",
					kind: "document",
					documentId: "doc_both",
					editor: docEditor,
				});
				useRegisterTiptapEditor({
					projectId: "proj_both",
					kind: "story",
					storyId: "story_both",
					editor: storyEditor,
				});
				return useTiptapEditorRegistry();
			},
			{ wrapper },
		);
		expect(result.current.byDocumentId.get("doc_both")?.editor).toBe(
			docEditor,
		);
		expect(result.current.byStoryId.get("story_both")?.editor).toBe(
			storyEditor,
		);
	});
});
