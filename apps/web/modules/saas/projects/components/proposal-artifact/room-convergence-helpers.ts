import { normalizeForComparison } from "@repo/utils/normalize-for-comparison";
import { Editor as DetachedEditor, type Editor } from "@tiptap/core";
import type * as Y from "yjs";
import { fromMarkdown } from "../../lib/diff-utils";
import { getEditorMarkdownForSave } from "../../lib/editor-markdown-save";
import {
	peerRoomSavesInFlight,
	ROOM_CONVERGENCE_TIMINGS,
	type RoomAwareness,
	roomStampKey,
} from "./generation-run-awareness";

/**
 * Whether a Yjs transaction changed `root` or anything inside it. The types
 * a transaction records are the innermost it changed — a paragraph's text,
 * say — so each is followed up to its root.
 */
export function transactionTouches(
	transaction: Y.Transaction,
	root: unknown,
): boolean {
	for (const changed of transaction.changed.keys()) {
		let type: unknown = changed;
		while (type) {
			if (type === root) {
				return true;
			}
			const parent = (type as { _item?: { parent?: unknown } | null })
				._item?.parent;
			type =
				typeof parent === "object" &&
				parent !== null &&
				"_item" in parent
					? parent
					: null;
		}
	}
	return false;
}

export function sameBody(a: string, b: string): boolean {
	return normalizeForComparison(a) === normalizeForComparison(b);
}

/**
 * The saved body as this editor's schema and serializer write it back, for
 * comparing with what the room holds: a saved body never reads back byte for
 * byte. A detached editor with the room editor's extensions, less the room
 * binding, renders it. `null` when it cannot be rendered.
 */
export function savedBodyAsEditorWritesIt(
	markdown: string,
	editor: Editor,
): string | null {
	let detached: DetachedEditor | null = null;
	try {
		detached = new DetachedEditor({
			// The list the room editor was built from, not the resolved one:
			// a new editor resolves it, and adds its own core extensions.
			extensions: editor.options.extensions.filter(
				(extension) =>
					extension.name !== "collaboration" &&
					extension.name !== "collaborationCaret",
			),
			content: markdown ? fromMarkdown(markdown) : "",
		});
		return getEditorMarkdownForSave(detached);
	} catch {
		return null;
	} finally {
		detached?.destroy();
	}
}

/**
 * Until when colleagues' saves in flight hold the stale rule back, or `null`
 * when none does (Fizzy #2946): each for one fall-through interval from when
 * this editor first saw it, by client and base, in `seen`. A save gone for
 * longer than that is forgotten.
 */
export function peerRoomSavesHoldUntil(
	awareness: RoomAwareness | null | undefined,
	seen: Map<string, number>,
	now: number,
): number | null {
	const windowMs = ROOM_CONVERGENCE_TIMINGS.fallThroughMs;
	const present = new Set<string>();
	let until: number | null = null;
	for (const save of peerRoomSavesInFlight(awareness)) {
		const key = `${save.clientId}:${roomStampKey(save.base)}`;
		present.add(key);
		const seenAt = seen.get(key) ?? now;
		seen.set(key, seenAt);
		const endsAt = seenAt + windowMs;
		if (endsAt > now && (until === null || endsAt < until)) {
			until = endsAt;
		}
	}
	for (const [key, seenAt] of seen) {
		if (!present.has(key) && seenAt + windowMs <= now) {
			seen.delete(key);
		}
	}
	return until;
}
