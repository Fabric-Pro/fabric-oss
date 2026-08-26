"use client";

/**
 * `usePickerIntentConsumer` -- destination-page hook that completes the
 * picker handoff started by `ChatMessageInsertDiagramButton` + E1 picker.
 *
 * Flow (spec § 10.4 / § 11 row 8):
 *   1. Picker writes an intent under
 *      `excalidraw-auto-insert:${diagramRequestId}` then `router.push`es
 *      to the destination route.
 *   2. Destination editor mounts (`DocumentEditor.tsx` /
 *      `StoryWorkspace.tsx`). When its TipTap `editor` becomes non-null
 *      this hook scans sessionStorage for a matching intent.
 *   3. If found AND the intent's `targetKind` + `targetId` match the
 *      page, the consumer builds a `ResolverTarget` from the live editor
 *      and triggers `useInsertDiagramAction.click()` exactly once.
 *   4. If the intent has expired (read returns `null` because the entry
 *      was older than 60s -- see `pickerHandoff.ts`), fire the
 *      `diagram_auto_insert_picker_timeout` telemetry event.
 *   5. Mismatched intent (right id, wrong target) is consumed-and-ignored
 *      defensively so it doesn't linger and replay on a later page.
 *
 * Spec sections:
 *   - § 10.4   Picker dialog cross-page idempotency
 *   - § 11 row 8   60s expiry + timeout telemetry
 *   - § 12     `diagram_auto_insert_picker_timeout`
 *   - § 17     Trust model -- server validates the cuids on `createFromChat`
 *
 * Ordering:
 *   - Must run AFTER `useRegisterTiptapEditor` (C5) so the registry
 *     entry is in place by the time `useInsertDiagramAction` performs
 *     its insertion. The registration effect runs in a layout-style
 *     `useEffect` on `editor` becoming non-null; we defer our own
 *     consume + click to the NEXT animation frame so React has flushed
 *     the registration commit.
 *   - SSR-safe: every storage access goes through the helpers in
 *     `pickerHandoff.ts`, which guard on `typeof window`. The hook is
 *     a no-op until `editor` becomes non-null (which, by definition,
 *     only happens on the client because TipTap is client-only).
 */

import { useAnalytics } from "@analytics";
import type { Editor } from "@tiptap/react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
	consumePickerIntent,
	type PickerIntent,
	type PickerIntentTargetKind,
} from "./pickerHandoff";
import type { ChatSurface, ResolverTarget } from "./types";
import { useInsertDiagramAction } from "./useInsertDiagramAction";

/**
 * Inputs to the consumer hook. The page that mounts the editor knows
 * the `projectId` + `kind` from its own router params; passing them in
 * lets the hook verify the intent matches the page BEFORE triggering
 * the insertion (defensive against router races).
 */
export interface UsePickerIntentConsumerOptions {
	/** The live TipTap editor instance, or `null` while booting. */
	editor: Editor | null;
	/** Project id the page belongs to. Used to short-circuit mismatches. */
	projectId: string;
	/**
	 * Whether the destination editor is a project document or a story
	 * workspace. HARDCODED per editor type -- DocumentEditor passes
	 * `"document"`, StoryWorkspace passes `"story"`. Making this
	 * configurable would let an intent leak across page navigations.
	 */
	kind: PickerIntentTargetKind;
	/** Set when `kind === "document"`. The intent's `targetId` must equal this. */
	documentId?: string;
	/** Set when `kind === "story"`. The intent's `targetId` must equal this. */
	storyId?: string;
	/**
	 * Best-effort title of the destination document/story for the
	 * success toast + the `ResolverTarget.documentLabel` field. The page
	 * already fetches this for its own UI -- pass it through so the
	 * toast says "Diagram inserted into Architecture" instead of
	 * "Diagram inserted into doc_xyz".
	 */
	documentLabel?: string;
}

/**
 * Build the synthetic `ResolverTarget` the action hook expects. The
 * resolver normally returns a registry-derived target during a chat
 * click; here we synthesize one from the live `editor` + the intent's
 * scope so the insertion lands on this exact page.
 */
function buildResolverTarget(
	editor: Editor,
	intent: PickerIntent,
	documentLabel: string,
): ResolverTarget {
	return {
		kind: intent.targetKind === "story" ? "story" : "document",
		editor,
		projectId: intent.projectId,
		documentLabel,
		documentId:
			intent.targetKind === "document" ? intent.targetId : undefined,
		storyId: intent.targetKind === "story" ? intent.targetId : undefined,
	};
}

export function usePickerIntentConsumer(
	options: UsePickerIntentConsumerOptions,
): void {
	const { editor, projectId, kind, documentId, storyId, documentLabel } =
		options;
	const { trackEvent } = useAnalytics();

	/**
	 * Hold the consumed intent in state so the `useInsertDiagramAction`
	 * hook can be wired with stable per-intent options across renders
	 * until the click resolves. Setting this from inside an effect
	 * triggers a re-render; the action's options are then derived from
	 * the populated intent and the action `.click()` is dispatched in a
	 * second effect that gates on `enabled === true`.
	 */
	const [consumedIntent, setConsumedIntent] = useState<PickerIntent | null>(
		null,
	);

	/** Belt-and-suspenders -- guarantee at-most-once click dispatch. */
	const clickDispatchedRef = useRef<string | null>(null);

	// ----- Scan sessionStorage for our intent ---------------------------
	// We scan once per `editor` becoming non-null. Deferred to the next
	// animation frame so the C5 `useRegisterTiptapEditor` effect has
	// committed before we start the insertion machinery.
	useEffect(() => {
		if (editor === null) {
			return;
		}
		// SSR safety: any code reading sessionStorage must be browser-only.
		// `editor` is created client-side, but be defensive anyway.
		if (typeof window === "undefined") {
			return;
		}
		let cancelled = false;

		const raf = window.requestAnimationFrame(() => {
			if (cancelled) {
				return;
			}
			// Walk sessionStorage looking for a key prefixed with the
			// intent storage prefix. There may be more than one stashed
			// entry (e.g. user opened the picker twice) -- we consume each
			// one in turn and only commit the FIRST one that matches our
			// page. Non-matching entries are still removed (defensive).
			const matchedIntent = findAndConsumeMatchingIntent({
				projectId,
				kind,
				documentId,
				storyId,
				trackEvent,
			});
			if (matchedIntent) {
				setConsumedIntent(matchedIntent);
			}
		});

		return () => {
			cancelled = true;
			window.cancelAnimationFrame(raf);
		};
		// Only re-run when `editor` becomes non-null. Re-running on every
		// prop change would re-consume sessionStorage entries during the
		// user's normal page interactions.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [editor]);

	// ----- Derive the action hook's options from the consumed intent ----
	const actionOptions = useMemo(() => {
		if (!consumedIntent || !editor) {
			return null;
		}
		const target = buildResolverTarget(
			editor,
			consumedIntent,
			documentLabel ?? consumedIntent.title,
		);
		return {
			surface: consumedIntent.surface,
			chatMessageId: consumedIntent.diagramRequestId,
			projectId: consumedIntent.projectId,
			organizationId: consumedIntent.organizationId,
			title: consumedIntent.title,
			resolverTarget: target,
			toolResult: {
				elements: consumedIntent.elements,
				appState: consumedIntent.appState,
				checkpointId: consumedIntent.checkpointId,
				mcpConfigId: consumedIntent.mcpConfigId,
				// The resource URI is reconstructable from the configId on
				// the destination page; the embed NodeView fetches via the
				// MCP server with `configId` as the canonical handle. The
				// intent payload doesn't carry the URI because it isn't
				// needed for the editor insertion (the embed's NodeView
				// resolves it lazily).
				resourceUri: `ui://excalidraw/${consumedIntent.checkpointId}`,
			},
		};
	}, [consumedIntent, editor, documentLabel]);

	// Always mount the action hook -- React's rules-of-hooks forbid
	// conditionally calling it. When there's no consumed intent we feed
	// it stable empty values; `enabled` returns false and `.click()` is
	// a no-op.
	const inertOptions = useMemo(
		() => ({
			surface: "in-document" satisfies ChatSurface as ChatSurface,
			chatMessageId: "picker-consumer-idle",
			projectId: null,
			organizationId: null,
			title: "",
			resolverTarget: null,
			toolResult: {
				elements: [],
				checkpointId: "",
				mcpConfigId: "",
				resourceUri: "",
			},
		}),
		[],
	);

	const action = useInsertDiagramAction(actionOptions ?? inertOptions);

	// ----- Dispatch the click exactly once once the action is enabled --
	useEffect(() => {
		if (!consumedIntent) {
			return;
		}
		if (clickDispatchedRef.current === consumedIntent.diagramRequestId) {
			return;
		}
		if (!action.enabled) {
			return;
		}
		clickDispatchedRef.current = consumedIntent.diagramRequestId;
		void action.click();
	}, [action, consumedIntent]);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface FindAndConsumeOptions {
	projectId: string;
	kind: PickerIntentTargetKind;
	documentId?: string;
	storyId?: string;
	trackEvent: (event: string, payload: Record<string, unknown>) => void;
}

/**
 * Walk sessionStorage looking for the entry that matches the current
 * page. Consumes every entry it inspects (at-most-once handoff per
 * spec § 10.4) and fires the timeout telemetry for entries that have
 * already expired. Returns the first MATCHING intent, or `null` if
 * none was found.
 *
 * Defensive against:
 *   - Multiple stale intents (consume all, return first match).
 *   - Wrong-page intents (consume + skip without triggering insertion).
 *   - Wrong-project intents (consume + skip).
 *   - Expired entries (consume + fire timeout telemetry).
 *
 * SSR-safe: returns `null` when called outside a browser.
 */
function findAndConsumeMatchingIntent(
	options: FindAndConsumeOptions,
): PickerIntent | null {
	if (typeof window === "undefined") {
		return null;
	}
	const storage = window.sessionStorage;
	if (!storage) {
		return null;
	}
	const prefix = "excalidraw-auto-insert:";
	// Snapshot the keys first because consume mutates the storage.
	const matchingKeys: string[] = [];
	for (let i = 0; i < storage.length; i++) {
		const key = storage.key(i);
		if (!key) {
			continue;
		}
		if (key.startsWith(prefix)) {
			matchingKeys.push(key);
		}
	}

	let match: PickerIntent | null = null;
	for (const key of matchingKeys) {
		const diagramRequestId = key.slice(prefix.length);
		// Peek at the entry to detect the "expired" case (consume returns
		// `null` for both "not found" and "expired"). We need to fire
		// the timeout telemetry for the expired case specifically.
		let preview: Record<string, unknown> | null = null;
		try {
			const raw = storage.getItem(key);
			if (raw) {
				const parsed: unknown = JSON.parse(raw);
				if (typeof parsed === "object" && parsed !== null) {
					preview = parsed as Record<string, unknown>;
				}
			}
		} catch {
			preview = null;
		}
		const intent = consumePickerIntent(diagramRequestId);
		if (intent === null) {
			// Either malformed or expired. If we have a parsed preview with
			// a createdAt that proves it expired (older than 60s), fire
			// the timeout event.
			const previewCreatedAt = preview?.createdAt;
			if (
				typeof previewCreatedAt === "number" &&
				Date.now() - previewCreatedAt > 60_000
			) {
				const previewSurface = preview?.surface;
				const previewProjectId = preview?.projectId;
				options.trackEvent("diagram_auto_insert_picker_timeout", {
					surface:
						typeof previewSurface === "string"
							? previewSurface
							: "nexus",
					projectId:
						typeof previewProjectId === "string"
							? previewProjectId
							: options.projectId,
				});
			}
			continue;
		}
		// Verify the intent targets THIS page. Non-matching intents are
		// consumed (already removed by `consumePickerIntent`) but don't
		// trigger insertion.
		if (intent.projectId !== options.projectId) {
			continue;
		}
		if (intent.targetKind !== options.kind) {
			continue;
		}
		const expectedTargetId =
			options.kind === "document" ? options.documentId : options.storyId;
		if (!expectedTargetId || intent.targetId !== expectedTargetId) {
			continue;
		}
		// First match wins; later ones are still consumed by the loop.
		if (match === null) {
			match = intent;
		}
	}
	return match;
}
