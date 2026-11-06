"use client";

import { visualSourceHash } from "@repo/utils/proposal-artifact/visual-identity";
import { createContext, useContext, useEffect, useState } from "react";

/**
 * Edit with instructions' open panels, kept outside the diagrams' node views
 * (Fizzy #2946).
 *
 * A collaborative editor that loses its room is unmounted until the room is
 * back, and a new editor then draws every diagram again. A panel's state in
 * its node view went with it: a candidate the server had returned vanished
 * without a word, and a request in flight was aborted. Here a panel lives as
 * long as the page's document editor, keyed by the diagram's marker id, and
 * the node view drawn again for that diagram shows the same panel. Applying
 * still checks the diagram as it is then, so a candidate the diagram has
 * moved on from reads as stale rather than being applied.
 *
 * A diagram's key can change form once the specs load after the first
 * draw: a marker the specs do not vouch for gives way to position and
 * source, and a diagram known only by those may get its marker id. A panel
 * opened under the other form moves to the current one when a view finds
 * it there (`rekey`), request and all. Panels of another document are dropped when the editor
 * moves to a new one (`retainDocument`): their diagrams are not on the page.
 */

/** What the diagram holds as the request goes: its source and position. */
export interface VisualEditTarget {
	/** The node's text, marker line included. */
	code: string;
	/** 0-based index among the document's diagrams, in document order. */
	ordinal: number;
	/** The marker id the request names; none for a detached diagram. */
	visualId?: string;
}

export type VisualEditOutcome =
	| "stale"
	| "refused"
	| "unsupported"
	| "providerMissing"
	| "rateLimited"
	| "forbidden"
	| "error";

export type VisualEditPhase =
	| { kind: "idle" }
	| { kind: "generating" }
	| {
			kind: "candidate";
			fence: string;
			sentHash: string;
			sectionFingerprint: string;
			visualId: string;
			svg: string | null;
			renderFailed: boolean;
	  }
	| { kind: "outcome"; outcome: VisualEditOutcome };

/** One diagram's open panel. */
interface VisualEditEntry {
	instruction: string;
	phase: VisualEditPhase;
}

/**
 * What the node view drawing a diagram now lends its panel's request: a
 * request outlives the view it started in, and reads the diagram, draws the
 * candidate and speaks through whichever view draws the diagram when it
 * gets there.
 */
interface VisualEditHost {
	readTarget: () => VisualEditTarget | null;
	renderCandidate: (code: string) => Promise<string>;
	announce: (message: string) => void;
}

/** A panel's request: its abort signal, and whether it is still the one. */
interface VisualEditRequest {
	signal: AbortSignal;
	/** False once a newer request, a cancel or a close replaced it. */
	current: () => boolean;
	/** The response is in: it can no longer be aborted. */
	finish: () => void;
}

export interface VisualEditStore {
	subscribe: (listener: () => void) => () => void;
	get: (key: string) => VisualEditEntry | undefined;
	/** Opens the panel, with nothing typed yet, unless it is open. */
	open: (key: string) => void;
	update: (key: string, patch: Partial<VisualEditEntry>) => void;
	/** Starts a request, aborting the panel's earlier one. */
	begin: (key: string) => VisualEditRequest;
	/** Aborts the panel's request, keeping the panel. */
	stop: (key: string) => void;
	/** Aborts the panel's request and forgets the panel. */
	close: (key: string) => void;
	/** Lends the diagram's view to its panel; returns the release. */
	setHost: (key: string, host: VisualEditHost) => () => void;
	host: (key: string) => VisualEditHost | undefined;
	/**
	 * Moves a panel, and its request, from `from` to `to`, unless `to` has
	 * one already; true when `to` holds it afterwards.
	 */
	rekey: (from: string, to: string) => boolean;
	/** Aborts the requests of, and forgets, every other document's panels. */
	retainDocument: (documentId: string) => void;
	/** Aborts every request and forgets every panel. */
	dispose: () => void;
}

export function createVisualEditStore(): VisualEditStore {
	const entries = new Map<string, VisualEditEntry>();
	const requests = new Map<string, AbortController>();
	const hosts = new Map<string, VisualEditHost>();
	const listeners = new Set<() => void>();
	const emit = () => {
		for (const listener of listeners) {
			listener();
		}
	};
	const stop = (key: string) => {
		requests.get(key)?.abort();
		requests.delete(key);
	};
	return {
		subscribe: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		get: (key) => entries.get(key),
		open: (key) => {
			if (entries.has(key)) {
				return;
			}
			entries.set(key, { instruction: "", phase: { kind: "idle" } });
			emit();
		},
		update: (key, patch) => {
			const entry = entries.get(key);
			if (!entry) {
				return;
			}
			entries.set(key, { ...entry, ...patch });
			emit();
		},
		begin: (key) => {
			stop(key);
			const controller = new AbortController();
			requests.set(key, controller);
			// Under whichever key the panel holds it now: `rekey` may have
			// moved it while it ran.
			const heldAt = () => {
				for (const [at, held] of requests) {
					if (held === controller) {
						return at;
					}
				}
				return undefined;
			};
			return {
				signal: controller.signal,
				current: () => heldAt() !== undefined,
				finish: () => {
					const at = heldAt();
					if (at !== undefined) {
						requests.delete(at);
					}
				},
			};
		},
		stop,
		close: (key) => {
			stop(key);
			if (entries.delete(key)) {
				emit();
			}
		},
		setHost: (key, host) => {
			hosts.set(key, host);
			return () => {
				if (hosts.get(key) === host) {
					hosts.delete(key);
				}
			};
		},
		host: (key) => hosts.get(key),
		rekey: (from, to) => {
			if (entries.has(to)) {
				return true;
			}
			const entry = entries.get(from);
			if (!entry) {
				return false;
			}
			entries.delete(from);
			entries.set(to, entry);
			const request = requests.get(from);
			if (request) {
				requests.delete(from);
				requests.set(to, request);
			}
			// The view that lent it under the old key is gone.
			hosts.delete(from);
			emit();
			return true;
		},
		retainDocument: (documentId) => {
			const own = `${documentId}:`;
			let dropped = false;
			for (const key of [...entries.keys()]) {
				if (!key.startsWith(own)) {
					stop(key);
					entries.delete(key);
					dropped = true;
				}
			}
			for (const key of [...requests.keys()]) {
				if (!key.startsWith(own)) {
					stop(key);
				}
			}
			for (const key of [...hosts.keys()]) {
				if (!key.startsWith(own)) {
					hosts.delete(key);
				}
			}
			if (dropped) {
				emit();
			}
		},
		dispose: () => {
			for (const controller of requests.values()) {
				controller.abort();
			}
			requests.clear();
			hosts.clear();
			if (entries.size > 0) {
				entries.clear();
				emit();
			}
		},
	};
}

/**
 * The key of a diagram's panel: its marker id, or, for a diagram without
 * one, its position and source, which hold while it is drawn again
 * unchanged.
 */
export function visualEditKey(
	documentId: string,
	target: VisualEditTarget,
): string {
	return target.visualId
		? `${documentId}:${target.visualId}`
		: `${documentId}:fence-${target.ordinal}-${visualSourceHash(target.code)}`;
}

/**
 * A store for the calling component's lifetime, disposed on unmount, that
 * keeps only `documentId`'s panels.
 */
export function useOwnedVisualEditStore(documentId: string): VisualEditStore {
	const [store] = useState(createVisualEditStore);
	useEffect(() => () => store.dispose(), [store]);
	useEffect(() => {
		store.retainDocument(documentId);
	}, [store, documentId]);
	return store;
}

const VisualEditSessionContext = createContext<VisualEditStore | null>(null);

/**
 * Hands the diagrams below a store that outlives the editor: a
 * collaborative editor provides it from above the part of the page a lost
 * room unmounts.
 */
export const VisualEditSessionProvider = VisualEditSessionContext.Provider;

export function useVisualEditSession(): VisualEditStore | null {
	return useContext(VisualEditSessionContext);
}
