/**
 * Tests for `useActiveTipTapEditor` — the active-editor resolver.
 *
 * Spec § 9 locks the four-step fallback order:
 *   (1) in-feature launcher context -> story editor by storyId
 *   (2) in-document same-page focused editor by projectId
 *   (3) defensive cross-tab fallback (any focused editor with matching
 *       projectId)
 *   (4) null
 *
 * Each test covers one branch + a fallback case. Together they lock the
 * exact algorithm so future tweaks have to update both the source and
 * this test in lockstep.
 */

import type { FabricAgentLaunchContext } from "@saas/agents/components/FabricAgentLauncher";
import { renderHook } from "@testing-library/react";
import type { Editor } from "@tiptap/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import {
	TiptapEditorRegistryProvider,
	useRegisterTiptapEditor,
} from "../TiptapEditorRegistry";
import { useActiveTipTapEditor } from "../useActiveTipTapEditor";

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

function makeWrapper(setup: () => void) {
	return ({ children }: { children: ReactNode }) => {
		const Inner = () => {
			setup();
			return null;
		};
		return (
			<TiptapEditorRegistryProvider>
				<Inner />
				{children}
			</TiptapEditorRegistryProvider>
		);
	};
}

describe("useActiveTipTapEditor — step 1: in-feature launcher path", () => {
	it("returns the story editor when launcher carries projectId + storyId", () => {
		const storyEditor = makeFakeEditor();
		const launcher: FabricAgentLaunchContext = {
			projectId: "proj_story",
			storyId: "story_xyz",
			storyIdentifier: "F-007",
			storyTitle: "Build the dashboard",
		};
		const wrapper = makeWrapper(() => {
			useRegisterTiptapEditor({
				projectId: "proj_story",
				kind: "story",
				storyId: "story_xyz",
				editor: storyEditor,
			});
		});

		const { result } = renderHook(
			() =>
				useActiveTipTapEditor({
					chatContext: {
						projectId: "proj_story",
						organizationId: "org_1",
						surface: "in-feature",
					},
					launcherContext: launcher,
				}),
			{ wrapper },
		);

		expect(result.current).not.toBeNull();
		expect(result.current?.kind).toBe("story");
		expect(result.current?.editor).toBe(storyEditor);
		expect(result.current?.projectId).toBe("proj_story");
		expect(result.current?.storyId).toBe("story_xyz");
		expect(result.current?.documentLabel).toBe("F-007 Build the dashboard");
	});

	it("falls through to step 3 when launcher story isn't registered", () => {
		// Launcher points at a story we never registered; resolver should
		// fall through to the cross-tab fallback. With a doc editor in the
		// same project the resolver returns that.
		const docEditor = makeFakeEditor();
		const launcher: FabricAgentLaunchContext = {
			projectId: "proj_a",
			storyId: "story_not_registered",
		};
		const wrapper = makeWrapper(() => {
			useRegisterTiptapEditor({
				projectId: "proj_a",
				kind: "document",
				documentId: "doc_a",
				editor: docEditor,
			});
		});

		const { result } = renderHook(
			() =>
				useActiveTipTapEditor({
					chatContext: {
						projectId: "proj_a",
						organizationId: "org_1",
						surface: "in-feature",
					},
					launcherContext: launcher,
				}),
			{ wrapper },
		);

		// Falls through to step (3) — the doc editor in proj_a is the
		// most-recently-focused match.
		expect(result.current?.editor).toBe(docEditor);
		expect(result.current?.kind).toBe("document");
	});
});

describe("useActiveTipTapEditor — step 2: in-document same-page path", () => {
	it("returns the same-page document editor", () => {
		const docEditor = makeFakeEditor();
		const wrapper = makeWrapper(() => {
			useRegisterTiptapEditor({
				projectId: "proj_doc",
				kind: "document",
				documentId: "doc_xyz",
				editor: docEditor,
			});
		});

		const { result } = renderHook(
			() =>
				useActiveTipTapEditor({
					chatContext: {
						projectId: "proj_doc",
						organizationId: "org_1",
						surface: "in-document",
					},
					launcherContext: null,
				}),
			{ wrapper },
		);

		expect(result.current?.editor).toBe(docEditor);
		expect(result.current?.kind).toBe("document");
		expect(result.current?.projectId).toBe("proj_doc");
	});
});

describe("useActiveTipTapEditor — step 3: defensive cross-tab fallback", () => {
	it("returns any focused editor in the chat project for non-matching surfaces", () => {
		// Surface is "nexus" — neither step 1 nor step 2 trigger. Step 3
		// must still find the editor by projectId.
		const editor = makeFakeEditor();
		const wrapper = makeWrapper(() => {
			useRegisterTiptapEditor({
				projectId: "proj_nexus",
				kind: "document",
				documentId: "doc_n",
				editor,
			});
		});

		const { result } = renderHook(
			() =>
				useActiveTipTapEditor({
					chatContext: {
						projectId: "proj_nexus",
						organizationId: "org_1",
						surface: "nexus",
					},
					launcherContext: null,
				}),
			{ wrapper },
		);

		expect(result.current?.editor).toBe(editor);
	});
});

describe("useActiveTipTapEditor — step 4: returns null on no match", () => {
	it("returns null when chatContext is null", () => {
		const wrapper = makeWrapper(() => undefined);
		const { result } = renderHook(
			() =>
				useActiveTipTapEditor({
					chatContext: null,
					launcherContext: null,
				}),
			{ wrapper },
		);
		expect(result.current).toBeNull();
	});

	it("returns null when no editor matches the chat scope", () => {
		// Editor exists for proj_A; chat is scoped to proj_B.
		const editor = makeFakeEditor();
		const wrapper = makeWrapper(() => {
			useRegisterTiptapEditor({
				projectId: "proj_A",
				kind: "document",
				documentId: "doc_a",
				editor,
			});
		});
		const { result } = renderHook(
			() =>
				useActiveTipTapEditor({
					chatContext: {
						projectId: "proj_B",
						organizationId: "org_1",
						surface: "in-document",
					},
					launcherContext: null,
				}),
			{ wrapper },
		);
		expect(result.current).toBeNull();
	});

	it("returns null when the registry is empty", () => {
		const wrapper = makeWrapper(() => undefined);
		const { result } = renderHook(
			() =>
				useActiveTipTapEditor({
					chatContext: {
						projectId: "proj_x",
						organizationId: "org_1",
						surface: "in-document",
					},
					launcherContext: null,
				}),
			{ wrapper },
		);
		expect(result.current).toBeNull();
	});

	it("returns null when chatContext has no projectId (personal scope)", () => {
		const editor = makeFakeEditor();
		const wrapper = makeWrapper(() => {
			useRegisterTiptapEditor({
				projectId: "proj_x",
				kind: "document",
				documentId: "doc",
				editor,
			});
		});
		const { result } = renderHook(
			() =>
				useActiveTipTapEditor({
					chatContext: {
						projectId: null,
						organizationId: null,
						surface: "in-document",
					},
					launcherContext: null,
				}),
			{ wrapper },
		);
		expect(result.current).toBeNull();
	});
});

describe("useActiveTipTapEditor — fallback order", () => {
	it("prefers step 1 (launcher) over step 2 / 3 when all are viable", () => {
		// Two editors in proj_p: a story editor (matches launcher) AND a
		// doc editor (matches step 3). Resolver MUST pick the story
		// because step 1 has priority.
		const storyEditor = makeFakeEditor();
		const docEditor = makeFakeEditor();
		const launcher: FabricAgentLaunchContext = {
			projectId: "proj_p",
			storyId: "the_story",
		};
		const wrapper = makeWrapper(() => {
			useRegisterTiptapEditor({
				projectId: "proj_p",
				kind: "story",
				storyId: "the_story",
				editor: storyEditor,
			});
			useRegisterTiptapEditor({
				projectId: "proj_p",
				kind: "document",
				documentId: "doc_n",
				editor: docEditor,
			});
		});
		const { result } = renderHook(
			() =>
				useActiveTipTapEditor({
					chatContext: {
						projectId: "proj_p",
						organizationId: "org_1",
						surface: "in-feature",
					},
					launcherContext: launcher,
				}),
			{ wrapper },
		);
		expect(result.current?.kind).toBe("story");
		expect(result.current?.editor).toBe(storyEditor);
	});

	it("does not return story editors when launcher project mismatches", () => {
		// Launcher points at a story in proj_other; chat scope is proj_a.
		// Step 1's guard `storyEntry.projectId === launcherProjectId`
		// fails, so we fall through. The registered story editor itself
		// is in proj_other so step 3 won't find it either — null.
		const storyEditor = makeFakeEditor();
		const launcher: FabricAgentLaunchContext = {
			projectId: "proj_other",
			storyId: "the_story",
		};
		const wrapper = makeWrapper(() => {
			useRegisterTiptapEditor({
				projectId: "proj_other",
				kind: "story",
				storyId: "the_story",
				editor: storyEditor,
			});
		});
		const { result } = renderHook(
			() =>
				useActiveTipTapEditor({
					chatContext: {
						projectId: "proj_a",
						organizationId: "org_1",
						surface: "in-feature",
					},
					launcherContext: launcher,
				}),
			{ wrapper },
		);
		expect(result.current).toBeNull();
	});
});
