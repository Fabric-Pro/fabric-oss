"use client";

/**
 * `AttachmentRegistry` — bridge between the upload pipeline / SSR hydration
 * and the live `<CopilotUserMessage>` renderer so attachments survive the
 * round trip from input → CopilotKit message → bubble → persistence.
 *
 * Why a registry instead of carrying attachments on the CopilotKit message
 * itself? CopilotKit 1.52's message envelope only exposes the standard
 * fields (id, role, content, image, createdAt, status). There's no
 * arbitrary metadata slot we can write to, so we can't pin per-message
 * attachments on the message object. The persistence pipeline solves this
 * server-side by stamping `attachments[]` on the `AgentConversation.messages`
 * blob, but the LIVE bubble needs the data BEFORE persistence fires
 * (otherwise the in-session preview only shows up after a page reload —
 * which defeats the point).
 *
 * The registry is a `Map<messageId, MessageAttachmentListItem[]>` exposed
 * via React context. Three writers:
 *
 *  1. `<AttachmentRegistryProvider>` — pre-populates entries from
 *     `initialAttachmentsByMessageId` (derived from the SSR-loaded
 *     conversation blob) at mount, so historical user bubbles rendered
 *     by `<CustomMessages>` have signed previewUrls ready on first paint.
 *  2. `<AttachmentRegistryProvider>` — drains the `pendingAttachmentsRef`
 *     FIFO when it observes a new user-role message land in
 *     `useCopilotChatInternal().messages`. Position matches send order
 *     (CopilotKit disables the input during stream), so a positional pop
 *     is correct under normal use.
 *  3. The persistence layer — reads (does NOT write) by message id when
 *     building the `appendTurnForDocument` payload.
 *
 * Surfaces without a provider (e.g. the standalone Fabric AI page) call
 * `useAttachmentRegistry()` and get back `null`; `<CopilotUserMessage>`
 * falls back to the legacy `[Attached: …]` filename caption in that case
 * so no consumer breaks.
 */

import { useCopilotChatInternal } from "@copilotkit/react-core";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type { MessageAttachmentListItem } from "./MessageAttachmentList";

interface AttachmentRegistryApi {
	/** Look up attachments for a given message id. Undefined when none. */
	get: (messageId: string) => MessageAttachmentListItem[] | undefined;
	/**
	 * Imperatively register a batch for a message id. Used by the
	 * hydrator (pre-populates from SSR) and any future surface that
	 * needs to seed the registry out-of-band.
	 */
	set: (messageId: string, batch: MessageAttachmentListItem[]) => void;
}

const AttachmentRegistryContext = createContext<AttachmentRegistryApi | null>(
	null,
);

interface AttachmentRegistryProviderProps {
	/**
	 * The FIFO queue of attachment batches the input pipeline pushes via
	 * `onAttachmentsForNextMessage`. The provider shifts the oldest batch
	 * the first time it sees a new user-role message in
	 * `useCopilotChatInternal().messages`. Pass the same ref you pass to
	 * `<CopilotPersistenceHook pendingAttachmentsRef>` so both consumers
	 * share the same source of truth.
	 */
	pendingAttachmentsRef?: React.RefObject<MessageAttachmentListItem[][]>;
	/**
	 * Optional SSR-hydration seed. The page-level loader hands the
	 * full conversation envelope to the editor; for any user-role
	 * message that has a persisted `attachments[]` array, an entry is
	 * pre-populated into the registry map so the live bubble
	 * (`<CopilotUserMessage>`) can render the rich
	 * `<MessageAttachmentList>` (inline image previews + file chips)
	 * the moment `<CustomMessages>` renders the historical bubble.
	 * Without it the hydrated bubble would fall back to the legacy
	 * filename caption until the next live upload populates the map.
	 */
	initialAttachmentsByMessageId?: ReadonlyMap<
		string,
		MessageAttachmentListItem[]
	>;
	children: ReactNode;
}

export function AttachmentRegistryProvider({
	pendingAttachmentsRef,
	initialAttachmentsByMessageId,
	children,
}: AttachmentRegistryProviderProps) {
	const [map, setMap] = useState<Map<string, MessageAttachmentListItem[]>>(
		() => {
			// Pre-populate from SSR seed on first render. Subsequent
			// updates (live sends) go through `setMap` from the
			// useLayoutEffect below.
			if (
				initialAttachmentsByMessageId &&
				initialAttachmentsByMessageId.size > 0
			) {
				return new Map(initialAttachmentsByMessageId);
			}
			return new Map();
		},
	);
	const seenUserIdsRef = useRef<Set<string>>(new Set());

	// `messages` is the live array CopilotKit's `<CopilotSidebar>` renders
	// from. We subscribe ONLY to watch for new user-role ids appearing —
	// the registry is a derivation of (FIFO queue, messages stream), not a
	// new source of truth.
	const { messages } = useCopilotChatInternal();

	// CopilotKit's `useCopilotChatInternal` returns the messages array via
	// `useMemo([agent?.messages])`. When the live `agent.addMessage` runs,
	// the agent does `this.messages.push(e)` — IN-PLACE MUTATION. The
	// array REFERENCE stays the same, the useMemo returns the cached
	// value, and a plain `useEffect([messages])` doesn't re-fire because
	// Object.is on the reference is true.
	//
	// We therefore key the effect off the primitive `messages.length`
	// and trailing id, which BOTH change whenever a new message lands.
	// This catches every relevant edge: live user send, assistant turn
	// arrival, hydrator backfill, and "+ New conversation" clear.
	const msgCount = messages.length;
	const lastMsgId =
		messages.length > 0
			? (messages[messages.length - 1] as { id?: string }).id
			: undefined;

	// `useLayoutEffect` (not `useEffect`) so this runs BEFORE
	// `CopilotPersistenceHook`'s downstream `useEffect`. Persistence
	// reads attachments via `attachmentRegistry.get(messageId)` — if the
	// provider's effect hasn't yet popped the FIFO + stored the batch,
	// persistence falls back to draining the FIFO itself (legacy path
	// for surfaces without a provider). Under React 18's effect order,
	// child useEffects fire before parent useEffects — so a plain
	// useEffect here would lose the race against the persistence read
	// inside the editor. `useLayoutEffect` fires synchronously after
	// commit, BEFORE any useEffect anywhere in the tree, so the registry
	// is populated by the time persistence walks the messages array.
	useLayoutEffect(() => {
		if (!pendingAttachmentsRef) {
			return;
		}
		// Walk new user-role messages in append order. Each new id pops one
		// batch off the FIFO queue. Batches that are empty (defensive — the
		// input only pushes when uploads succeed) still consume a slot so
		// positional alignment stays right.
		for (const m of messages as ReadonlyArray<{
			id?: string;
			role?: string;
		}>) {
			if (!m || m.role !== "user" || typeof m.id !== "string") {
				continue;
			}
			if (seenUserIdsRef.current.has(m.id)) {
				continue;
			}
			seenUserIdsRef.current.add(m.id);
			const batch = pendingAttachmentsRef.current?.shift();
			if (batch && batch.length > 0) {
				setMap((prev) => {
					const next = new Map(prev);
					next.set(m.id as string, batch);
					return next;
				});
			}
		}
		// Primitive deps survive in-place array mutations — `useMemo`
		// caches the messages reference across in-place pushes, so we
		// can't depend on the array reference itself. `messages` is
		// read inside the loop; not including it in deps is intentional.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [msgCount, lastMsgId]);

	const set = useCallback(
		(messageId: string, batch: MessageAttachmentListItem[]) => {
			if (!batch || batch.length === 0) {
				return;
			}
			setMap((prev) => {
				const existing = prev.get(messageId);
				// Cheap identity check so the hydrator doesn't keep
				// thrashing the map on parent re-renders.
				if (existing && existing.length === batch.length) {
					return prev;
				}
				const next = new Map(prev);
				next.set(messageId, batch);
				return next;
			});
		},
		[],
	);

	const api = useMemo<AttachmentRegistryApi>(
		() => ({
			get: (id: string) => map.get(id),
			set,
		}),
		[map, set],
	);

	return (
		<AttachmentRegistryContext.Provider value={api}>
			{children}
		</AttachmentRegistryContext.Provider>
	);
}

/**
 * Read-only hook for consumers. Returns `null` when no provider is
 * mounted above (e.g. the standalone Fabric AI surface) so the caller
 * can degrade gracefully — `<CopilotUserMessage>` falls back to the
 * legacy `[Attached: …]` caption in that case.
 */
export function useAttachmentRegistry(): AttachmentRegistryApi | null {
	return useContext(AttachmentRegistryContext);
}
