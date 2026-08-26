"use client";

/**
 * In-memory registry of the TipTap `Editor` instances currently mounted
 * in the SaaS shell. Used by the active-editor resolution algorithm in
 * `useActiveTipTapEditor.ts` to translate a chat message
 * click into "the editor on the page the user is looking at".
 *
 * Why a registry instead of a global ref?
 *   - Multiple editors can be mounted simultaneously (a doc page may
 *     have the document editor + the in-document Copilot's sidebar, or
 *     a feature page may have a story editor + a nested tooltip
 *     editor). The resolver picks the most-recently-focused one whose
 *     `projectId` matches the chat scope.
 *   - The registry exposes a `byStoryId` lookup for the in-feature
 *     launcher path (spec § 9 step 1), where the launcher hands the
 *     resolver a `storyId` directly.
 *
 * Performance contract:
 *   - Registry state is a mutable `Map` held in a `useRef`. Subscribers
 *     read it through `subscribe` + a monotonically-increasing version
 *     counter; the resolver hook uses `useSyncExternalStore` to opt in
 *     to re-renders only when entries actually change.
 *   - Updating `lastFocusedAt` on every focus event MUST NOT cause a
 *     re-render of editor components. We bump the version counter, and
 *     consumers that care about focus order subscribe explicitly via
 *     `useTiptapEditorRegistry()` -> `mostRecentlyFocusedFor(...)`.
 *
 * Multi-tenant note: the registry holds `Editor` references and
 * `projectId` strings — no XOR-sensitive data lives here. The resolver
 * still filters by `projectId` so cross-project lookups are impossible
 * even if a stale entry leaks.
 *
 * Standards / spec sections:
 *   - § 8 (table row: TiptapEditorRegistry)
 *   - § 9 (active-editor resolution algorithm)
 *   - § 22.1 (mirror the registerDocumentEditor ergonomics at
 *             DocumentEditor.tsx:1232-1243)
 */

import type { Editor } from "@tiptap/react";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useSyncExternalStore,
} from "react";
import type { ResolverTargetKind } from "./types";

/**
 * Stable identifier for a registered editor. Composite of the kind and
 * the document or story id, so a document/story page that mounts more
 * than one editor entry never collides with itself across kinds.
 */
function makeRegistryId(input: {
	kind: ResolverTargetKind;
	documentId?: string | null;
	storyId?: string | null;
}): string {
	const targetId = input.documentId ?? input.storyId ?? "";
	return `${input.kind}:${targetId}`;
}

/** Internal shape of a registry entry. */
type TiptapEditorRegistryEntry = {
	id: string;
	kind: ResolverTargetKind;
	projectId: string;
	documentId?: string;
	storyId?: string;
	editor: Editor;
	/**
	 * `performance.now()` timestamp of the last focus event observed
	 * on this editor. Updated by the focus listener wired by
	 * `useRegisterTiptapEditor`. Initialised to the mount timestamp so
	 * a newly-registered editor is the most-recently-focused entry
	 * until another editor receives focus.
	 */
	lastFocusedAt: number;
};

/**
 * Public read API exposed via context. Consumers (the resolver hook)
 * call these methods inside their own re-render scopes; the registry
 * itself does not force re-renders on focus events — see file header.
 */
export type TiptapEditorRegistryApi = {
	/**
	 * Return the most-recently-focused entry whose `projectId` matches
	 * the supplied scope, or `null` if no matching entry is registered.
	 * Used by the resolver step (3) — defensive cross-tab fallback.
	 */
	mostRecentlyFocusedFor(projectId: string): TiptapEditorRegistryEntry | null;

	/**
	 * Direct-lookup `Map` for the in-feature launcher path. Keyed by
	 * `storyId`; the value is the latest registry entry for that story
	 * (a story page only ever registers one editor at a time).
	 */
	byStoryId: ReadonlyMap<string, TiptapEditorRegistryEntry>;

	/**
	 * Direct-lookup `Map` for the in-document Copilot path. Keyed by
	 * `documentId`; same constraints as `byStoryId`.
	 */
	byDocumentId: ReadonlyMap<string, TiptapEditorRegistryEntry>;

	/**
	 * Snapshot of every registered entry. Stable reference between
	 * version bumps — re-rendered consumers can iterate without
	 * worrying about reference equality during a focus event.
	 */
	entries(): readonly TiptapEditorRegistryEntry[];
};

/**
 * Subscription contract used by `useSyncExternalStore`-style consumers
 * that need to re-read the registry whenever entries are added,
 * removed, or their focus order changes.
 */
type RegistrySubscription = {
	subscribe(listener: () => void): () => void;
	getSnapshot(): number;
};

type RegistryContextValue = {
	api: TiptapEditorRegistryApi;
	subscription: RegistrySubscription;
	__internalRegister(entry: TiptapEditorRegistryEntry): () => void;
	__internalUpdateFocus(id: string, when: number): void;
};

const TiptapEditorRegistryContext = createContext<RegistryContextValue | null>(
	null,
);

/**
 * Mount this provider near the SaaS shell so every chat surface +
 * editor surface lives inside the same registry. Spec § 8 requires it
 * to wrap the same subtree as `FabricAgentLauncherProvider`.
 *
 * The provider's value is `useMemo`-stable: the API + subscription
 * objects do not change identity across re-renders, so React's
 * `useContext` consumers never re-render solely because the provider
 * re-rendered.
 */
export function TiptapEditorRegistryProvider({
	children,
}: {
	children: ReactNode;
}): JSX.Element {
	// Mutable map + listener list live in refs so updates do not
	// schedule re-renders. The version counter is the only thing that
	// drives subscriber re-runs, and we increment it from imperative
	// register / unregister / focus paths.
	const entriesRef = useRef<Map<string, TiptapEditorRegistryEntry>>(
		new Map(),
	);
	const listenersRef = useRef<Set<() => void>>(new Set());
	const versionRef = useRef<number>(0);

	// Cache the latest entries snapshot so `entries()` returns a stable
	// reference between version bumps. Re-built lazily inside the
	// reader, not on every register call -- subscribers may not care
	// about entries() at all.
	const cachedEntriesRef = useRef<
		readonly TiptapEditorRegistryEntry[] | null
	>(null);

	const bumpVersion = useCallback(() => {
		versionRef.current = versionRef.current + 1;
		cachedEntriesRef.current = null;
		// Notify subscribers AFTER updating the version so a listener
		// that immediately calls `getSnapshot()` sees the new value.
		// Copy the listener set first so a listener that unsubscribes
		// inside the callback does not mutate the iteration we're
		// currently walking.
		const listeners = Array.from(listenersRef.current);
		for (const listener of listeners) {
			listener();
		}
	}, []);

	const internalRegister = useCallback(
		(entry: TiptapEditorRegistryEntry): (() => void) => {
			entriesRef.current.set(entry.id, entry);
			bumpVersion();
			return () => {
				const existing = entriesRef.current.get(entry.id);
				// Only delete if the entry we registered is still the one
				// in the map. A remount between unmount-effect-fired and
				// effect-cleanup-running could have replaced it with a
				// fresh entry for the same id.
				if (existing === entry) {
					entriesRef.current.delete(entry.id);
					bumpVersion();
				}
			};
		},
		[bumpVersion],
	);

	const internalUpdateFocus = useCallback(
		(id: string, when: number) => {
			const entry = entriesRef.current.get(id);
			if (!entry) {
				return;
			}
			// In-place mutation is safe because the entries() snapshot
			// is invalidated on every version bump.
			entry.lastFocusedAt = when;
			bumpVersion();
		},
		[bumpVersion],
	);

	const subscription = useMemo<RegistrySubscription>(
		() => ({
			subscribe(listener) {
				listenersRef.current.add(listener);
				return () => {
					listenersRef.current.delete(listener);
				};
			},
			getSnapshot() {
				return versionRef.current;
			},
		}),
		[],
	);

	const api = useMemo<TiptapEditorRegistryApi>(
		() => ({
			mostRecentlyFocusedFor(projectId: string) {
				let best: TiptapEditorRegistryEntry | null = null;
				for (const entry of entriesRef.current.values()) {
					if (entry.projectId !== projectId) {
						continue;
					}
					if (!best || entry.lastFocusedAt > best.lastFocusedAt) {
						best = entry;
					}
				}
				return best;
			},
			get byStoryId() {
				const map = new Map<string, TiptapEditorRegistryEntry>();
				for (const entry of entriesRef.current.values()) {
					if (entry.storyId) {
						map.set(entry.storyId, entry);
					}
				}
				return map;
			},
			get byDocumentId() {
				const map = new Map<string, TiptapEditorRegistryEntry>();
				for (const entry of entriesRef.current.values()) {
					if (entry.documentId) {
						map.set(entry.documentId, entry);
					}
				}
				return map;
			},
			entries() {
				if (cachedEntriesRef.current) {
					return cachedEntriesRef.current;
				}
				const snapshot = Array.from(entriesRef.current.values());
				cachedEntriesRef.current = snapshot;
				return snapshot;
			},
		}),
		[],
	);

	const value = useMemo<RegistryContextValue>(
		() => ({
			api,
			subscription,
			__internalRegister: internalRegister,
			__internalUpdateFocus: internalUpdateFocus,
		}),
		[api, subscription, internalRegister, internalUpdateFocus],
	);

	return (
		<TiptapEditorRegistryContext.Provider value={value}>
			{children}
		</TiptapEditorRegistryContext.Provider>
	);
}

/**
 * Read-only access to the registry. Throws if called outside the
 * provider so a wiring mistake fails loudly at mount time rather than
 * silently producing a null resolver target.
 *
 * Consumers that need to RE-RENDER when the registry changes should
 * pair this with `useTiptapEditorRegistryVersion()` (below) under
 * `useSyncExternalStore`, since the API methods alone do not trigger
 * re-renders on focus updates.
 */
export function useTiptapEditorRegistry(): TiptapEditorRegistryApi {
	const ctx = useContext(TiptapEditorRegistryContext);
	if (!ctx) {
		throw new Error(
			"useTiptapEditorRegistry() must be called inside <TiptapEditorRegistryProvider>",
		);
	}
	return ctx.api;
}

/**
 * Subscribe to registry version bumps. Useful for the resolver hook,
 * which needs to re-run whenever an editor is added/removed or its
 * focus order changes.
 *
 * Returns the current version number; consumers typically just want
 * the side-effect of being re-rendered.
 */
export function useTiptapEditorRegistryVersion(): number {
	const ctx = useContext(TiptapEditorRegistryContext);
	if (!ctx) {
		throw new Error(
			"useTiptapEditorRegistryVersion() must be called inside <TiptapEditorRegistryProvider>",
		);
	}
	return useSyncExternalStore(
		ctx.subscription.subscribe,
		ctx.subscription.getSnapshot,
		ctx.subscription.getSnapshot, // server snapshot — same as client; we register zero entries during SSR
	);
}

/** Argument shape for `useRegisterTiptapEditor`. */
export type RegisterTiptapEditorOptions = {
	projectId: string;
	kind: ResolverTargetKind;
	editor: Editor | null;
	documentId?: string | null;
	storyId?: string | null;
};

/**
 * Effect-driven editor registration. Pattern-matched on the existing
 * `registerDocumentEditor` ergonomics at `DocumentEditor.tsx:1232-1243`,
 * but extended to carry `projectId`, `kind`, and the document or
 * story id so the resolver can pick the right editor for a chat scope.
 *
 * Wires a `focus` listener on the editor so `lastFocusedAt` stays in
 * sync. Returns nothing — the hook is purely side-effectful. The
 * registration and the focus listener are both torn down on unmount or
 * on any input change.
 *
 * No-op when `editor` is `null` (the editor is still booting) — this
 * matches the existing `DocumentEditor.tsx` pattern, which gates the
 * effect on `if (!editor) return;` before calling
 * `registerDocumentEditor`.
 */
export function useRegisterTiptapEditor(
	options: RegisterTiptapEditorOptions,
): void {
	// Tolerate missing provider — DocumentEditor / StoryWorkspace are
	// rendered from many test harnesses that don't wrap in the SaaS shell.
	// In production the provider is mounted in AppWrapper.tsx; if it's
	// absent the registration is a no-op (the resolver will simply find
	// no entries and the UI button falls back to the picker path).
	const ctx = useContext(TiptapEditorRegistryContext);

	const { projectId, kind, editor, documentId, storyId } = options;
	const documentIdNormalized = documentId ?? undefined;
	const storyIdNormalized = storyId ?? undefined;

	useEffect(() => {
		if (!editor || !ctx) {
			return;
		}
		const id = makeRegistryId({
			kind,
			documentId: documentIdNormalized,
			storyId: storyIdNormalized,
		});
		// Initial focus timestamp: the mount moment. The resolver's
		// "most recently focused" sort then naturally prefers the
		// newest mount among same-project entries, which matches the
		// in-document Copilot UX (the editor user just opened is the
		// target).
		const initialFocusedAt =
			typeof performance !== "undefined" ? performance.now() : Date.now();
		const entry: TiptapEditorRegistryEntry = {
			id,
			kind,
			projectId,
			documentId: documentIdNormalized,
			storyId: storyIdNormalized,
			editor,
			lastFocusedAt: initialFocusedAt,
		};

		const unregister = ctx.__internalRegister(entry);
		const onFocus = () => {
			const now =
				typeof performance !== "undefined"
					? performance.now()
					: Date.now();
			ctx.__internalUpdateFocus(id, now);
		};
		editor.on("focus", onFocus);

		return () => {
			editor.off("focus", onFocus);
			unregister();
		};
	}, [ctx, editor, kind, projectId, documentIdNormalized, storyIdNormalized]);
}
