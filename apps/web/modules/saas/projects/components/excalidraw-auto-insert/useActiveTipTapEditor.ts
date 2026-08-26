"use client";

/**
 * Active-editor resolver. Translates a chat message click into the
 * specific on-page TipTap editor the `<excalidraw-embed>` node should
 * be inserted into.
 *
 * Implements the four-step fallback algorithm in spec § 9 verbatim:
 *
 *   (1) If `surface === "in-feature"` and the launcher carries a
 *       `projectId` + `storyId`, look up the story editor by id from
 *       the registry. If present, return it.
 *   (2) If `surface === "in-document"` and the chat is scoped to a
 *       project, ask the registry for the most-recently-focused editor
 *       whose `projectId` matches. If present, return it.
 *   (3) Defensive cross-tab fallback: regardless of surface, if the
 *       chat has a `projectId` ask the registry for the most-recently-
 *       focused editor whose `projectId` matches. If present, return
 *       it.
 *   (4) Return `null`. The caller (the button hook D1) decides the UX
 *       response — typically: open the picker dialog if the chat has
 *       a project scope, or render the button as disabled.
 *
 * The hook subscribes to the registry's version counter via
 * `useTiptapEditorRegistryVersion()` so it re-runs whenever an editor
 * is added, removed, or focus order changes. This is the safe way to
 * react to registry updates because the underlying registry state is
 * mutable.
 *
 * Pure / side-effect-free. The hook never throws on null inputs —
 * registry can legitimately be empty during initial mount, and the
 * launcher context can be null when the user hasn't opened the
 * floating Fabric Agent panel yet.
 *
 * Standards / spec sections:
 *   - § 8 (table row: `useActiveTipTapEditor`)
 *   - § 9 (active-editor resolution algorithm)
 *   - § 12 (`diagram_auto_insert_blocked { reason: "cross_project" }`
 *           — fired by D1 when the resolver returns a target whose
 *           projectId doesn't match the chat scope; not this hook's
 *           concern.)
 */

import type { FabricAgentLaunchContext } from "@saas/agents/components/FabricAgentLauncher";
import { useMemo } from "react";
import {
	type TiptapEditorRegistryApi,
	useTiptapEditorRegistry,
	useTiptapEditorRegistryVersion,
} from "./TiptapEditorRegistry";
import type { ChatSurface, ResolverTarget } from "./types";

/**
 * Inputs to the resolver. Both fields are nullable because:
 *   - `chatContext` is null when the chat surface isn't bound to a
 *     project (e.g. unauthenticated, or before context hydrates).
 *   - `launcherContext` is null on every surface except the in-feature
 *     AI Assistant (which mounts under `FabricAgentLauncherProvider`).
 */
export interface UseActiveTipTapEditorOptions {
	chatContext: {
		projectId: string | null;
		organizationId: string | null;
		surface: ChatSurface;
	} | null;
	launcherContext: FabricAgentLaunchContext | null;
}

/**
 * Build a `ResolverTarget` from a registry entry. The `documentLabel`
 * field is the editor's "best display name" — for a story editor it's
 * the story identifier + title (already on the launcher context); for
 * a document editor we don't have a label here so we leave it empty
 * and let the caller (D1/D2) read the document title via its own
 * `projects.documents.get` query. The label is filled in opportunistically
 * for the story case below.
 */
function buildTargetFromRegistry(
	entry: NonNullable<
		ReturnType<TiptapEditorRegistryApi["mostRecentlyFocusedFor"]>
	>,
	documentLabel: string,
): ResolverTarget {
	return {
		kind: entry.kind,
		editor: entry.editor,
		projectId: entry.projectId,
		documentLabel,
		documentId: entry.documentId,
		storyId: entry.storyId,
	};
}

/**
 * Resolve the active TipTap editor for the chat surface. Returns
 * `null` when no editor matches — the caller decides the UX path
 * (open picker, render disabled, etc.).
 */
export function useActiveTipTapEditor(
	options: UseActiveTipTapEditorOptions,
): ResolverTarget | null {
	const registry = useTiptapEditorRegistry();
	// Subscribe to registry version bumps so the memo below re-runs
	// when an editor is added/removed/focused.
	const version = useTiptapEditorRegistryVersion();
	const { chatContext, launcherContext } = options;

	return useMemo<ResolverTarget | null>(() => {
		// Reference `version` so the dependency-array tracking has a real
		// data dependency to detect. Without this read, the linter (and a
		// future maintainer) might be tempted to drop `version` from the
		// deps array, breaking the subscription contract.
		void version;

		if (!chatContext) {
			return null;
		}
		const { surface, projectId: chatProjectId } = chatContext;

		// --- Step 1: in-feature launcher context ---------------------
		// Spec § 9 step 1 requires THREE conditions:
		//   - surface is "in-feature"
		//   - launcher.projectId equals chatContext.projectId (otherwise
		//     the launcher is pointing at a different project from the
		//     chat — we ignore it to avoid a cross-project insert)
		//   - registry has a registered editor for launcher.storyId
		// Only then we return the story editor.
		if (
			surface === "in-feature" &&
			launcherContext?.projectId &&
			launcherContext?.storyId &&
			launcherContext.projectId === chatProjectId
		) {
			const launcherStoryId = launcherContext.storyId;
			const launcherProjectId = launcherContext.projectId;
			const storyEntry = registry.byStoryId.get(launcherStoryId);
			if (storyEntry && storyEntry.projectId === launcherProjectId) {
				// Build a "story identifier + title" label from the launcher
				// context when both fields are present; otherwise fall back
				// to just the title or the storyId.
				const identifier = launcherContext.storyIdentifier ?? null;
				const title = launcherContext.storyTitle ?? null;
				const label =
					identifier && title
						? `${identifier} ${title}`
						: (title ?? identifier ?? launcherStoryId);
				return buildTargetFromRegistry(storyEntry, label);
			}
			// Launcher pointed us at a story that isn't (yet) registered —
			// fall through to the cross-tab path so the user still gets an
			// editor target if their previously-focused editor matches the
			// chat project.
		}

		// --- Step 2: in-document same-page focused editor ------------
		if (surface === "in-document" && chatProjectId) {
			const target = registry.mostRecentlyFocusedFor(chatProjectId);
			if (target) {
				// For document targets, we don't have the document title on
				// the registry entry. Leave the label empty; D1/D2 fill it
				// from `projects.documents.get`.
				const label = target.storyId
					? (target.storyId ?? "")
					: (target.documentId ?? "");
				return buildTargetFromRegistry(target, label);
			}
		}

		// --- Step 3: defensive cross-tab fallback --------------------
		if (chatProjectId) {
			const target = registry.mostRecentlyFocusedFor(chatProjectId);
			if (target) {
				const label = target.storyId
					? (target.storyId ?? "")
					: (target.documentId ?? "");
				return buildTargetFromRegistry(target, label);
			}
		}

		// --- Step 4: nothing matched. Caller decides. ----------------
		return null;
	}, [chatContext, launcherContext, registry, version]);
}
