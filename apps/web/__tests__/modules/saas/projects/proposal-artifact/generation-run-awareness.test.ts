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
	GENERATION_RUN_OF_AWARENESS_FIELD,
	type GenerationRunRole,
	isRoomBodyEmpty,
	newProposalReview,
	PROPOSAL_REVIEW_AWARENESS_FIELD,
	peerReviewsHeldOver,
	peerReviewsProposal,
	peerRoomSavesInFlight,
	proposalReviewerName,
	publishGenerationRunRole,
	publishProposalReview,
	publishRoomPeer,
	publishRoomSaveInFlight,
	ROOM_PEER_AWARENESS_FIELD,
	ROOM_SAVE_AWARENESS_FIELD,
	type RoomPeer,
	readConvergenceClaim,
	readRoomStamp,
	roomAwarenessSignature,
	roomHasOtherEditor,
	roomReviewsProposal,
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

	// A review left open on an earlier run while a later one, started by a
	// colleague, the API or an agent, ends (Fizzy #2946).
	it("does not count a role published for another run", () => {
		const awareness = fakeAwareness(7, { 3: "started", 5: "attached" });
		const states = awareness.getStates();
		states.set(3, {
			...states.get(3),
			[GENERATION_RUN_OF_AWARENESS_FIELD]: "2026-10-21T10:00:00.000Z",
		});
		states.set(5, {
			...states.get(5),
			[GENERATION_RUN_OF_AWARENESS_FIELD]: "2026-10-21T10:00:00.000Z",
		});

		expect(
			appliesAttachedRunBody(awareness, "2026-10-21T11:00:00.000Z"),
		).toBe(true);
		expect(
			appliesAttachedRunBody(awareness, "2026-10-21T10:00:00.000Z"),
		).toBe(false);
	});

	it("counts a role when either side does not name its run", () => {
		const unnamed = fakeAwareness(7, { 3: "started" });
		expect(
			appliesAttachedRunBody(unnamed, "2026-10-21T11:00:00.000Z"),
		).toBe(false);

		const named = fakeAwareness(7, { 3: "started" });
		const states = named.getStates();
		states.set(3, {
			...states.get(3),
			[GENERATION_RUN_OF_AWARENESS_FIELD]: "2026-10-21T10:00:00.000Z",
		});
		expect(appliesAttachedRunBody(named)).toBe(false);
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

	it("publishes the run the role is for, and clears it with the role", () => {
		const awareness = fakeAwareness(7, {}, null);

		publishGenerationRunRole(
			awareness,
			"started",
			"2026-10-21T10:00:00.000Z",
		);
		expect(awareness.getLocalState()).toMatchObject({
			[GENERATION_RUN_AWARENESS_FIELD]: "started",
			[GENERATION_RUN_OF_AWARENESS_FIELD]: "2026-10-21T10:00:00.000Z",
		});

		publishGenerationRunRole(
			awareness,
			"started",
			"2026-10-21T10:00:00.000Z",
		);
		expect(awareness.setLocalStateField).toHaveBeenCalledTimes(2);

		publishGenerationRunRole(awareness, null, "2026-10-21T10:00:00.000Z");
		expect(awareness.getLocalState()).toMatchObject({
			[GENERATION_RUN_AWARENESS_FIELD]: null,
			[GENERATION_RUN_OF_AWARENESS_FIELD]: null,
		});
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

describe("an assistant proposal under review (Fizzy #2946)", () => {
	it("is published once, and cleared", () => {
		const mine = roomAwareness(5, { 5: peer(true) });
		publishProposalReview(mine, "review-1");
		publishProposalReview(mine, "review-1");
		expect(mine.getLocalState()?.[PROPOSAL_REVIEW_AWARENESS_FIELD]).toBe(
			"review-1",
		);
		publishProposalReview(mine, null);
		publishProposalReview(mine, null);
		expect(
			mine.getLocalState()?.[PROPOSAL_REVIEW_AWARENESS_FIELD],
		).toBeNull();
		expect(mine.setLocalStateField).toHaveBeenCalledTimes(2);
		publishProposalReview(null, "review-2");
	});

	it("holds the other editors, never the one reviewing it", () => {
		const reviewing = roomAwareness(5, {
			5: { ...peer(true), [PROPOSAL_REVIEW_AWARENESS_FIELD]: "review-1" },
			7: peer(true),
		});
		expect(peerReviewsProposal(reviewing)).toBe(false);
		expect(roomReviewsProposal(reviewing)).toBe(true);

		const other = roomAwareness(7, {
			5: { ...peer(true), [PROPOSAL_REVIEW_AWARENESS_FIELD]: "review-1" },
			7: peer(true),
		});
		expect(peerReviewsProposal(other)).toBe(true);
		expect(roomReviewsProposal(other)).toBe(true);
	});

	it("counts a review only from a client that published that it may edit", () => {
		const awareness = roomAwareness(7, {
			// A viewer, which the collaboration server lets publish anything.
			1: { ...peer(false), [PROPOSAL_REVIEW_AWARENESS_FIELD]: "forged" },
			// A client from before the election, which published no peer state.
			2: { [PROPOSAL_REVIEW_AWARENESS_FIELD]: "old" },
			9: { ...peer(true), [PROPOSAL_REVIEW_AWARENESS_FIELD]: null },
			11: { ...peer(true), [PROPOSAL_REVIEW_AWARENESS_FIELD]: "" },
		});
		expect(peerReviewsProposal(awareness)).toBe(false);
		expect(roomReviewsProposal(awareness)).toBe(false);
		expect(peerReviewsProposal(null)).toBe(false);
		expect(roomReviewsProposal(undefined)).toBe(false);
	});

	it("names a review by when it began, then a random part", () => {
		expect(newProposalReview(1_700_000_000_000)).toMatch(
			/^1700000000000:[0-9a-f-]{36}$/,
		);
	});

	it("between two reviews begun before either editor heard of the other, holds the earlier one's editor never, and the later one's", () => {
		const earlier = "1000:review-a";
		const later = "2000:review-b";
		const reviewingEarlier = roomAwareness(5, {
			5: { ...peer(true), [PROPOSAL_REVIEW_AWARENESS_FIELD]: earlier },
			7: { ...peer(true), [PROPOSAL_REVIEW_AWARENESS_FIELD]: later },
		});
		expect(peerReviewsProposal(reviewingEarlier)).toBe(false);
		expect([...peerReviewsHeldOver(reviewingEarlier)]).toEqual([7]);

		const reviewingLater = roomAwareness(7, {
			5: { ...peer(true), [PROPOSAL_REVIEW_AWARENESS_FIELD]: earlier },
			7: { ...peer(true), [PROPOSAL_REVIEW_AWARENESS_FIELD]: later },
		});
		expect(peerReviewsProposal(reviewingLater)).toBe(true);
		expect([...peerReviewsHeldOver(reviewingLater)]).toEqual([]);
		// Any other editor is held, whichever holds.
		const third = roomAwareness(9, {
			5: { ...peer(true), [PROPOSAL_REVIEW_AWARENESS_FIELD]: earlier },
			7: { ...peer(true), [PROPOSAL_REVIEW_AWARENESS_FIELD]: later },
		});
		expect(peerReviewsProposal(third)).toBe(true);
		expect([...peerReviewsHeldOver(third)]).toEqual([]);
	});

	it("settles reviews begun in the same millisecond by the smaller client id, and takes one without a time to begin last", () => {
		const tie = (own: number) =>
			roomAwareness(own, {
				5: {
					...peer(true),
					[PROPOSAL_REVIEW_AWARENESS_FIELD]: "1000:a",
				},
				7: {
					...peer(true),
					[PROPOSAL_REVIEW_AWARENESS_FIELD]: "1000:b",
				},
			});
		expect(peerReviewsProposal(tie(5))).toBe(false);
		expect(peerReviewsProposal(tie(7))).toBe(true);

		const untimed = roomAwareness(5, {
			5: { ...peer(true), [PROPOSAL_REVIEW_AWARENESS_FIELD]: "9999:a" },
			3: { ...peer(true), [PROPOSAL_REVIEW_AWARENESS_FIELD]: "no-time" },
		});
		expect(peerReviewsProposal(untimed)).toBe(false);
	});

	it("stops holding once the reviewing editor's state leaves the room", () => {
		const states: Record<number, Record<string, unknown>> = {
			5: { ...peer(true), [PROPOSAL_REVIEW_AWARENESS_FIELD]: "review-1" },
			7: peer(true),
		};
		const other = roomAwareness(7, states);
		expect(peerReviewsProposal(other)).toBe(true);
		other.getStates().delete(5);
		expect(peerReviewsProposal(other)).toBe(false);
	});

	it("names the person whose review holds this editor: the earliest one, never a review it holds over, and nobody when that editor names nobody", () => {
		const named = (name: unknown) => ({ user: { name } });
		const states: Record<number, Record<string, unknown>> = {
			5: {
				...peer(true),
				...named("Example Reviewer"),
				[PROPOSAL_REVIEW_AWARENESS_FIELD]: "1000:a",
			},
			7: {
				...peer(true),
				...named("Later Reviewer"),
				[PROPOSAL_REVIEW_AWARENESS_FIELD]: "2000:b",
			},
			9: { ...peer(true), ...named("Me") },
		};
		expect(proposalReviewerName(roomAwareness(9, states))).toBe(
			"Example Reviewer",
		);
		// The later review's own editor is held by the earlier one's.
		expect(proposalReviewerName(roomAwareness(7, states))).toBe(
			"Example Reviewer",
		);
		// The earlier review's editor is held by nobody.
		expect(proposalReviewerName(roomAwareness(5, states))).toBeNull();

		// A viewer's review holds nobody, so it names nobody either.
		expect(
			proposalReviewerName(
				roomAwareness(9, {
					3: {
						...peer(false),
						...named("Viewer"),
						[PROPOSAL_REVIEW_AWARENESS_FIELD]: "500:v",
					},
					9: peer(true),
				}),
			),
		).toBeNull();
		for (const user of [
			undefined,
			named(""),
			named("  "),
			named(42),
			named("Anonymous"),
		]) {
			expect(
				proposalReviewerName(
					roomAwareness(9, {
						5: {
							...peer(true),
							...(user ?? {}),
							[PROPOSAL_REVIEW_AWARENESS_FIELD]: "1000:a",
						},
						9: peer(true),
					}),
				),
			).toBeNull();
		}
		expect(proposalReviewerName(null)).toBeNull();
	});
});

describe("roomHasOtherEditor", () => {
	it("counts another client that published that it may edit, never this one or a viewer", () => {
		expect(roomHasOtherEditor(roomAwareness(5, { 5: peer(true) }))).toBe(
			false,
		);
		expect(
			roomHasOtherEditor(
				roomAwareness(5, {
					5: peer(true),
					3: peer(false),
					// A client from before the election, which published no peer state.
					4: { user: { name: "Reader" } },
				}),
			),
		).toBe(false);
		expect(
			roomHasOtherEditor(
				roomAwareness(5, { 5: peer(true), 7: peer(true) }),
			),
		).toBe(true);
		expect(roomHasOtherEditor(null)).toBe(false);
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

		states[7] = {
			...states[7],
			[PROPOSAL_REVIEW_AWARENESS_FIELD]: "review-1",
		};
		const withReview = signature();
		expect(withReview).not.toBe(withRole);

		// A client joining the room.
		states[9] = {};
		expect(signature()).not.toBe(withReview);
		expect(roomAwarenessSignature(null)).toBe("");
	});
});
