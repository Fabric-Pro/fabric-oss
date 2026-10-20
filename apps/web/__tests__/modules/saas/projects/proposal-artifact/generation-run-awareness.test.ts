/**
 * Which open editor writes a regenerated body into a shared collaborative
 * document (Fizzy #2801).
 *
 * Every editor attached to a run it did not start takes the regenerated body
 * when the run completes. Under collaboration they share one Yjs document,
 * and two editors setting the body at once each insert it, so the shared
 * document ends up holding it twice. Each editor therefore says in its
 * awareness state whether it started the run or is attached to one, and
 * exactly one writes:
 *
 * - the editor that started the run, which writes it through its own review,
 *   so no attached editor writes while it is present;
 * - otherwise the attached editor with the smallest awareness client id.
 *
 * Without an awareness there is nothing shared to duplicate into, and every
 * editor takes the body itself.
 */

import {
	appliesAttachedRunBody,
	convergenceRank,
	GENERATION_RUN_AWARENESS_FIELD,
	type GenerationRunRole,
	isRoomBodyEmpty,
	peerRoomSavesInFlight,
	publishGenerationRunRole,
	publishRoomPeer,
	publishRoomSaveInFlight,
	ROOM_PEER_AWARENESS_FIELD,
	ROOM_SAVE_AWARENESS_FIELD,
	type RoomPeer,
	readConvergenceClaim,
	readRoomStamp,
	roomAwarenessSignature,
	sameRoomStamp,
	writeConvergenceClaim,
	writeRoomStamp,
} from "@saas/projects/components/proposal-artifact/generation-run-awareness";
import { ROOM_BODY_FRAGMENT } from "@saas/projects/lib/room-body-fragment";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

/**
 * An awareness as y-protocols keeps it: one state per client id. `ownRole`
 * "absent" leaves out this editor's own state, as before it reaches the room.
 */
function fakeAwareness(
	clientID: number,
	others: Record<number, GenerationRunRole | null> = {},
	ownRole: GenerationRunRole | null | "absent" = "attached",
) {
	const states = new Map<number, Record<string, unknown>>();
	for (const [id, role] of Object.entries(others)) {
		states.set(Number(id), {
			user: { name: `Reader ${id}` },
			...(role ? { [GENERATION_RUN_AWARENESS_FIELD]: role } : {}),
		});
	}
	if (ownRole !== "absent") {
		states.set(clientID, {
			user: { name: "Me" },
			[GENERATION_RUN_AWARENESS_FIELD]: ownRole,
		});
	}
	return {
		clientID,
		getStates: () => states,
		getLocalState: () => states.get(clientID) ?? null,
		setLocalStateField: vi.fn((field: string, value: unknown) => {
			states.set(clientID, {
				...(states.get(clientID) ?? {}),
				[field]: value,
			});
		}),
	};
}

describe("appliesAttachedRunBody", () => {
	it("applies without an awareness: no shared document to duplicate into", () => {
		expect(appliesAttachedRunBody(null)).toBe(true);
		expect(appliesAttachedRunBody(undefined)).toBe(true);
	});

	it("applies when it is the only attached editor", () => {
		expect(appliesAttachedRunBody(fakeAwareness(7))).toBe(true);
	});

	it("leaves the body to an attached editor with a smaller client id", () => {
		expect(
			appliesAttachedRunBody(fakeAwareness(7, { 3: "attached" })),
		).toBe(false);
	});

	it("applies when every other attached editor has a larger client id", () => {
		expect(
			appliesAttachedRunBody(
				fakeAwareness(3, { 7: "attached", 11: "attached" }),
			),
		).toBe(true);
	});

	it("is elected by the attached editors only: a reader that is not attached does not count", () => {
		expect(appliesAttachedRunBody(fakeAwareness(7, { 3: null }))).toBe(
			true,
		);
	});

	it("leaves the body to the editor that started the run, whatever the client ids", () => {
		expect(appliesAttachedRunBody(fakeAwareness(3, { 7: "started" }))).toBe(
			false,
		);
	});

	it("counts itself before its own state has gone out", () => {
		expect(
			appliesAttachedRunBody(
				fakeAwareness(3, { 7: "attached" }, "absent"),
			),
		).toBe(true);
		expect(
			appliesAttachedRunBody(
				fakeAwareness(7, { 3: "attached" }, "absent"),
			),
		).toBe(false);
	});
});

describe("publishGenerationRunRole", () => {
	it("publishes the role in the editor's awareness state, then clears it", () => {
		const awareness = fakeAwareness(7, {}, null);

		publishGenerationRunRole(awareness, "attached");
		expect(awareness.getLocalState()).toMatchObject({
			[GENERATION_RUN_AWARENESS_FIELD]: "attached",
		});

		publishGenerationRunRole(awareness, null);
		expect(
			awareness.getLocalState()?.[GENERATION_RUN_AWARENESS_FIELD],
		).toBeNull();
		expect(awareness.setLocalStateField).toHaveBeenCalledTimes(2);
	});

	it("does not send the role again when it has not changed", () => {
		const awareness = fakeAwareness(7, {}, "started");

		publishGenerationRunRole(awareness, "started");

		expect(awareness.setLocalStateField).not.toHaveBeenCalled();
	});

	it("sends nothing to clear a role that was never published", () => {
		const awareness = fakeAwareness(7, {}, "absent");

		publishGenerationRunRole(awareness, null);

		expect(awareness.setLocalStateField).not.toHaveBeenCalled();
	});

	it("does nothing without an awareness", () => {
		expect(() => publishGenerationRunRole(null, "attached")).not.toThrow();
		expect(() =>
			publishGenerationRunRole(undefined, "attached"),
		).not.toThrow();
	});
});

/*
 * The room's record of the saved body it holds, and the election that brings
 * a stale room to the saved body (Fizzy #2946).
 */

/** An awareness whose states are the room peers each client published. */
function roomAwareness(
	clientID: number,
	peers: Record<number, Record<string, unknown>>,
) {
	const states = new Map<number, Record<string, unknown>>();
	for (const [id, state] of Object.entries(peers)) {
		states.set(Number(id), state);
	}
	return {
		clientID,
		getStates: () => states,
		getLocalState: () => states.get(clientID) ?? null,
		setLocalStateField: vi.fn((field: string, value: unknown) => {
			states.set(clientID, {
				...(states.get(clientID) ?? {}),
				[field]: value,
			});
		}),
	};
}

function peer(canEdit: boolean, visible = true): Record<string, unknown> {
	return { [ROOM_PEER_AWARENESS_FIELD]: { canEdit, visible } };
}

const EDITOR: RoomPeer = { canEdit: true, visible: true };

describe("the room stamp", () => {
	it("is absent from a room nobody stamped", () => {
		expect(readRoomStamp(new Y.Doc())).toBeNull();
	});

	it("reaches every copy of the room with the body written in the same transaction", () => {
		const room = new Y.Doc();
		const other = new Y.Doc();
		room.transact(() => {
			room.getXmlFragment(ROOM_BODY_FRAGMENT).insert(0, [
				new Y.XmlElement("paragraph"),
			]);
			writeRoomStamp(room, { version: 4, contentHash: "hash-b" });
		});
		Y.applyUpdate(other, Y.encodeStateAsUpdate(room));

		expect(readRoomStamp(other)).toEqual({
			version: 4,
			contentHash: "hash-b",
		});
		expect(isRoomBodyEmpty(other)).toBe(false);
		expect(isRoomBodyEmpty(new Y.Doc())).toBe(true);
	});

	it("ignores a malformed stamp rather than trusting half of it", () => {
		const room = new Y.Doc();
		room.getMap("fabricRoom").set("stamp", { version: 4 });
		expect(readRoomStamp(room)).toBeNull();
		room.getMap("fabricRoom").set("stamp", { version: 4, contentHash: "" });
		expect(readRoomStamp(room)).toBeNull();
	});

	it("writes nothing when the stamp is already the one asked for", () => {
		const room = new Y.Doc();
		writeRoomStamp(room, { version: 4, contentHash: "hash-b" });
		const updates: Uint8Array[] = [];
		room.on("update", (update: Uint8Array) => updates.push(update));

		writeRoomStamp(room, { version: 4, contentHash: "hash-b" });

		expect(updates).toHaveLength(0);
	});

	it("compares version and body identity together", () => {
		const stamp = { version: 4, contentHash: "hash-b" };
		expect(sameRoomStamp(stamp, { ...stamp })).toBe(true);
		// The run's final save writes a new body at the old version.
		expect(
			sameRoomStamp(stamp, { version: 4, contentHash: "hash-a" }),
		).toBe(false);
		expect(
			sameRoomStamp(stamp, { version: 5, contentHash: "hash-b" }),
		).toBe(false);
		expect(sameRoomStamp(stamp, null)).toBe(false);
		expect(sameRoomStamp(null, null)).toBe(false);
	});
});

describe("the convergence claim", () => {
	it("resolves to the same claim on every client after concurrent claims meet", () => {
		const a = new Y.Doc();
		const b = new Y.Doc();
		const target = { version: 9, contentHash: "hash-b" };
		writeConvergenceClaim(a, { clientId: a.clientID, target });
		writeConvergenceClaim(b, { clientId: b.clientID, target });
		Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
		Y.applyUpdate(b, Y.encodeStateAsUpdate(a));

		const resolvedA = readConvergenceClaim(a);
		expect(resolvedA).toEqual(readConvergenceClaim(b));
		expect([a.clientID, b.clientID]).toContain(resolvedA?.clientId);
	});

	it("carries how the claimant's application read back", () => {
		const room = new Y.Doc();
		const target = { version: 9, contentHash: "hash-b" };
		writeConvergenceClaim(room, {
			clientId: 3,
			target,
			settled: "verified",
		});
		expect(readConvergenceClaim(room)).toEqual({
			clientId: 3,
			target,
			settled: "verified",
		});
	});

	it("carries when a failed claim failed, and drops that time once the claim settles otherwise", () => {
		const room = new Y.Doc();
		const target = { version: 9, contentHash: "hash-b" };
		writeConvergenceClaim(room, {
			clientId: 3,
			target,
			settled: "failed",
			failedAt: 1_000,
		});
		const failed = readConvergenceClaim(room);
		expect(failed).toEqual({
			clientId: 3,
			target,
			settled: "failed",
			failedAt: 1_000,
		});

		writeConvergenceClaim(room, {
			...(failed as NonNullable<typeof failed>),
			settled: "verified",
		});
		expect(readConvergenceClaim(room)).toEqual({
			clientId: 3,
			target,
			settled: "verified",
		});
	});

	it("reads a failed claim without a time, as an older editor wrote it, without inventing one", () => {
		const room = new Y.Doc();
		const target = { version: 9, contentHash: "hash-b" };
		room.getMap("fabricRoom").set("convergence", {
			clientId: 3,
			target,
			settled: "failed",
		});
		expect(readConvergenceClaim(room)).toEqual({
			clientId: 3,
			target,
			settled: "failed",
		});
	});
});

describe("convergenceRank", () => {
	it("never elects a client that may not edit", () => {
		expect(
			convergenceRank(roomAwareness(1, {}), {
				canEdit: false,
				visible: true,
			}),
		).toBeNull();
	});

	it("puts this editor first when it is the only one that may edit, whatever a viewer's client id or claimed run role", () => {
		const awareness = roomAwareness(5, {
			1: {
				...peer(false),
				[GENERATION_RUN_AWARENESS_FIELD]: "started",
			},
		});
		expect(convergenceRank(awareness, EDITOR)).toBe(0);
	});

	it("orders editors by visibility, then by client id", () => {
		const awareness = roomAwareness(5, {
			3: peer(true, false),
			7: peer(true, true),
			9: peer(true, true),
		});
		// 7 and 9 are visible but larger; 3 is smaller but hidden.
		expect(convergenceRank(awareness, EDITOR)).toBe(0);
		expect(
			convergenceRank(awareness, { canEdit: true, visible: false }),
		).toBe(3);
		expect(
			convergenceRank(roomAwareness(8, { 7: peer(true, true) }), EDITOR),
		).toBe(1);
	});

	it("does not count a client from before the election, which published no peer state", () => {
		const awareness = roomAwareness(5, {
			1: { [GENERATION_RUN_AWARENESS_FIELD]: "attached" },
		});
		expect(convergenceRank(awareness, EDITOR)).toBe(0);
	});
});

describe("room awareness fields", () => {
	it("publishes the peer state once and again only when it changes", () => {
		const awareness = roomAwareness(5, {});
		publishRoomPeer(awareness, EDITOR);
		publishRoomPeer(awareness, EDITOR);
		publishRoomPeer(awareness, { canEdit: true, visible: false });
		expect(awareness.setLocalStateField).toHaveBeenCalledTimes(2);
		expect(awareness.getLocalState()?.[ROOM_PEER_AWARENESS_FIELD]).toEqual({
			canEdit: true,
			visible: false,
		});
	});

	it("tells the other editors about a save in flight until it is cleared", () => {
		const mine = roomAwareness(5, {});
		const base = { version: 4, contentHash: "hash-b" };
		publishRoomSaveInFlight(mine, base);
		expect(mine.getLocalState()?.[ROOM_SAVE_AWARENESS_FIELD]).toEqual(base);
		// Not counted by the editor that published it.
		expect(peerRoomSavesInFlight(mine)).toEqual([]);

		const theirs = roomAwareness(7, {
			5: { ...peer(true), [ROOM_SAVE_AWARENESS_FIELD]: base },
		});
		expect(peerRoomSavesInFlight(theirs)).toEqual([{ clientId: 5, base }]);

		publishRoomSaveInFlight(mine, null);
		expect(mine.getLocalState()?.[ROOM_SAVE_AWARENESS_FIELD]).toBeNull();
		publishRoomSaveInFlight(mine, null);
		expect(mine.setLocalStateField).toHaveBeenCalledTimes(2);
	});

	it("counts a save in flight only from a client that published that it may edit", () => {
		const base = { version: 4, contentHash: "hash-b" };
		const awareness = roomAwareness(7, {
			// A viewer, which the collaboration server lets publish anything.
			1: { ...peer(false), [ROOM_SAVE_AWARENESS_FIELD]: base },
			// A client from before the election, which published no peer state.
			2: { [ROOM_SAVE_AWARENESS_FIELD]: base },
			9: { ...peer(true, false), [ROOM_SAVE_AWARENESS_FIELD]: base },
			11: { ...peer(true), [ROOM_SAVE_AWARENESS_FIELD]: null },
		});
		expect(peerRoomSavesInFlight(awareness)).toEqual([
			{ clientId: 9, base },
		]);
	});
});

describe("roomAwarenessSignature", () => {
	it("changes with what the convergence reads, and not with a cursor or a selection", () => {
		const states: Record<number, Record<string, unknown>> = {
			5: { ...peer(true), cursor: { anchor: 1, head: 1 } },
			7: { ...peer(true), user: { name: "Reader 7" } },
		};
		const signature = () =>
			roomAwarenessSignature(roomAwareness(5, { ...states }));
		const before = signature();

		states[7] = { ...states[7], cursor: { anchor: 40, head: 52 } };
		expect(signature()).toBe(before);

		states[7] = {
			...states[7],
			[ROOM_SAVE_AWARENESS_FIELD]: { version: 4, contentHash: "hash-b" },
		};
		const withSave = signature();
		expect(withSave).not.toBe(before);

		states[7] = {
			...states[7],
			[GENERATION_RUN_AWARENESS_FIELD]: "attached",
		};
		const withRole = signature();
		expect(withRole).not.toBe(withSave);

		// A client joining the room.
		states[9] = {};
		expect(signature()).not.toBe(withRole);
		expect(roomAwarenessSignature(null)).toBe("");
	});
});
