/**
 * Which open editor writes a regenerated body into a shared collaborative
 * document (Fizzy #2801).
 *
 * An editor attached to a run it did not start adopts the run's body when
 * the run completes. Under collaboration every open editor shares one Yjs
 * document, and two editors setting the same body at once each insert it, so
 * the shared document would hold it twice. Each editor therefore publishes
 * in its awareness state whether it started the run or is attached to one,
 * and exactly one writes the body:
 *
 * - the editor that started the run, which writes it through its own review,
 *   so no attached editor writes while that editor is in the room;
 * - otherwise the attached editor with the smallest awareness client id.
 *
 * The others take the body through the room's sync. Without an awareness
 * there is no shared document, and every editor writes its own.
 *
 * A role names the run it is for (Fizzy #2946): a review stays open after
 * its run, and a later run started by a colleague, the API or an agent must
 * not wait on it, or no editor writes that run's body.
 */

import { ROOM_BODY_FRAGMENT } from "../../lib/room-body-fragment";

/** The awareness state field each editor publishes its run role in. */
export const GENERATION_RUN_AWARENESS_FIELD = "generationRun";

/**
 * The awareness state field naming the run that role is for: the run's
 * `generationStartedAt` as an ISO string, or `null` when the editor does not
 * know it. A separate field, so an editor that does not read it still reads
 * the role.
 */
export const GENERATION_RUN_OF_AWARENESS_FIELD = "generationRunOf";

/**
 * `started`: this editor started the run and reviews its body. `attached`:
 * this editor follows a run it did not start and adopts its body.
 */
export type GenerationRunRole = "started" | "attached";

/** The part of a y-protocols `Awareness` the election reads and writes. */
interface GenerationRunAwareness {
	clientID: number;
	getStates(): Map<number, Record<string, unknown>>;
	getLocalState(): Record<string, unknown> | null;
	setLocalStateField(field: string, value: unknown): void;
}

/** The awareness a room's convergence reads, as y-protocols provides it. */
export interface RoomAwareness extends GenerationRunAwareness {
	on?(event: "change", listener: () => void): void;
	off?(event: "change", listener: () => void): void;
}

/**
 * Publish this editor's run role and the run it is for, or clear the role
 * with `null`. Sends nothing when the published role and run are already
 * the ones asked for, so other editors never see a role flicker off and
 * back on.
 */
export function publishGenerationRunRole(
	awareness: GenerationRunAwareness | null | undefined,
	role: GenerationRunRole | null,
	run: string | null = null,
): void {
	if (!awareness) {
		return;
	}
	const local = awareness.getLocalState();
	const ofRun = role ? run : null;
	if ((local?.[GENERATION_RUN_OF_AWARENESS_FIELD] ?? null) !== ofRun) {
		awareness.setLocalStateField(GENERATION_RUN_OF_AWARENESS_FIELD, ofRun);
	}
	if ((local?.[GENERATION_RUN_AWARENESS_FIELD] ?? null) !== role) {
		awareness.setLocalStateField(GENERATION_RUN_AWARENESS_FIELD, role);
	}
}

/**
 * Whether this attached editor is the one that writes the body of `run`
 * (the run's identity, when this editor knows it) into the shared document.
 * A role another editor published for a different run does not count. It
 * counts itself as attached whether or not its own state has reached the
 * room yet.
 */
export function appliesAttachedRunBody(
	awareness: GenerationRunAwareness | null | undefined,
	run: string | null = null,
): boolean {
	if (!awareness) {
		return true;
	}
	const own = awareness.clientID;
	let elected = own;
	for (const [clientId, state] of awareness.getStates()) {
		if (clientId === own) {
			continue;
		}
		const ofRun = state?.[GENERATION_RUN_OF_AWARENESS_FIELD];
		if (run && typeof ofRun === "string" && ofRun !== run) {
			continue;
		}
		const role = state?.[GENERATION_RUN_AWARENESS_FIELD];
		if (role === "started") {
			return false;
		}
		if (role === "attached" && clientId < elected) {
			elected = clientId;
		}
	}
	return elected === own;
}

/*
 * The room's own record of the saved body it holds (Fizzy #2946).
 *
 * A collaborative room outlives every editor that opens it, and the database
 * moves on without it: a generation run's final save, a version restore, a
 * Reject that rewinds the version, a write through the API or the MCP
 * gateway. Without a record of which saved body the room's content descends
 * from, an editor cannot tell a room that is behind from a colleague's
 * unsaved typing, and saves the older body back over the newer one.
 *
 * - The stamp: the version and server-returned `contentHash` of that saved
 *   body, in the room's metadata map. It is written together with every body
 *   an editor puts into the room from the server, and advanced from each
 *   save's answer. Every save from the room names it as its base, so a save
 *   based on an older body is refused rather than written.
 * - A room is behind (stale) only when no run is live, no editor has a save
 *   in flight, the stamp differs from the saved document on two observations
 *   at least one poll interval apart, and the room's body differs from the
 *   saved one. Equal bodies only advance the stamp.
 * - A stale room is brought to the saved body by one editor: only clients
 *   that may edit are candidates, a visible tab before a hidden one, then the
 *   smallest awareness client id. A candidate writes a convergence claim into
 *   the room's metadata map and applies only when, after the claim had time
 *   to meet any concurrent one, the map resolves to its own: map conflicts
 *   resolve the same way on every client, while awareness views can disagree
 *   while a relay is delayed. A candidate further down the order steps in
 *   when the ones before it have not converged the room within a bounded
 *   interval each.
 * - A colleague's save in flight defers the stale rule only when that client
 *   published that it may edit, and colleagues' saves together defer it for
 *   one fall-through interval at most in each stale episode: awareness is
 *   not checked by the collaboration server, so a viewer can publish that it
 *   may edit, rotate the bases it names or speak for invented clients, and a
 *   save that never answers must not hold a stale room forever.
 * - A convergence whose body still did not read back after one more
 *   application is recorded as failed, with the time. It freezes the editor
 *   that wrote it for the rest of that session. Another editor that saw it
 *   fail leaves the room alone for a short while, then makes one more bounded
 *   attempt of its own; an editor opened after it was written, or one whose
 *   person asks to reload the latest version, makes that attempt at once. A
 *   failure the room keeps never freezes everyone who opens it later.
 */

/** The room document's metadata map: the stamp and the convergence claim. */
export const ROOM_META_MAP = "fabricRoom";
const ROOM_STAMP_KEY = "stamp";
const ROOM_CLAIM_KEY = "convergence";

/** The saved body a room's content descends from. */
export interface RoomStamp {
	version: number;
	contentHash: string;
}

/**
 * One editor's claim to bring the room to `target`. The claimant records
 * whether the body it applied read back intact (`verified`) or stayed
 * mismatched after one more application (`failed`), and when it failed
 * (`failedAt`, by the claimant's clock).
 */
export interface ConvergenceClaim {
	clientId: number;
	target: RoomStamp;
	settled?: "verified" | "failed";
	failedAt?: number;
}

/**
 * How long a proposal under review holds the other editors in the room at
 * most, with no input in the editor that reviews it (Fizzy #2946). A review
 * left open — a tab left in the background with its confirm card up — would
 * otherwise hold every other editor still for as long as that tab stays
 * open. Only the reviewing editor releases it, by answering the proposal as
 * rejected: another editor that stopped holding on its own would save the
 * unanswered proposal its room holds.
 */
const PROPOSAL_REVIEW_IDLE_LIMIT_MS = 10 * 60_000;

/** How long each step of the stale rule and the election waits. */
export const ROOM_CONVERGENCE_TIMINGS = {
	/**
	 * Two observations of a differing stamp are at least this far apart: one
	 * poll of a generating document.
	 */
	observationGapMs: 3_000,
	/**
	 * How long after the first look at a room behind the end of a run the
	 * editor, read-only from that look, gives way to the saved body. The
	 * editor that puts the run's body into the room has usually done so by
	 * then, and the page does not swap views for a moment. Shorter than
	 * `observationGapMs`, or the second look decides first.
	 */
	savedBodyGraceMs: 750,
	/**
	 * How long a claim waits, after it is written, for a concurrent claim to
	 * reach it through the room before the map is read for the winner.
	 */
	claimSettleMs: 1_500,
	/**
	 * How long each candidate ahead in the election has to bring the room to
	 * the saved body before the next one steps in. Also how long another
	 * editor's save in flight holds the stale rule back.
	 */
	fallThroughMs: 10_000,
	/**
	 * How long an editor that saw another editor's convergence fail leaves
	 * the room as it is before it makes one more attempt of its own.
	 */
	failedClaimExpiryMs: 30_000,
	/**
	 * How long an assistant proposal may wait for its answer, with nothing
	 * done in the editor that reviews it, before that editor answers it as
	 * rejected (see `PROPOSAL_REVIEW_IDLE_LIMIT_MS`).
	 */
	proposalReviewIdleLimitMs: PROPOSAL_REVIEW_IDLE_LIMIT_MS,
	/**
	 * How long frames the assistant streamed into an editor wait, once its
	 * run ended, for the confirm card its chat announced (Fizzy #2946). A
	 * run that failed after naming the call never runs it, and its frames
	 * would otherwise stay under review for good.
	 */
	proposalCardLateLimitMs: 20_000,
} as const;

/** The part of a Yjs document the room record reads and writes. */
interface RoomDocument {
	getMap(name: string): {
		get(key: string): unknown;
		set(key: string, value: unknown): unknown;
	};
	getXmlFragment(name: string): { length: number };
}

function isRoomStamp(value: unknown): value is RoomStamp {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as RoomStamp).version === "number" &&
		typeof (value as RoomStamp).contentHash === "string" &&
		(value as RoomStamp).contentHash.length > 0
	);
}

/** Whether two stamps name the same saved body. */
export function sameRoomStamp(
	a: RoomStamp | null | undefined,
	b: RoomStamp | null | undefined,
): boolean {
	return (
		!!a && !!b && a.version === b.version && a.contentHash === b.contentHash
	);
}

/** The room's stamp, or `null` for a room that has none yet. */
export function readRoomStamp(ydoc: RoomDocument): RoomStamp | null {
	const stamp = ydoc.getMap(ROOM_META_MAP).get(ROOM_STAMP_KEY);
	return isRoomStamp(stamp)
		? { version: stamp.version, contentHash: stamp.contentHash }
		: null;
}

/**
 * Record the saved body the room's content now descends from. A caller that
 * also changes the body writes both in one transaction, and passes `always`
 * so the stamp travels with the body even when it is unchanged: every editor
 * then sees that the body it holds was replaced from the server.
 */
export function writeRoomStamp(
	ydoc: RoomDocument,
	stamp: RoomStamp,
	{ always = false }: { always?: boolean } = {},
): void {
	if (!always && sameRoomStamp(readRoomStamp(ydoc), stamp)) {
		return;
	}
	ydoc.getMap(ROOM_META_MAP).set(ROOM_STAMP_KEY, {
		version: stamp.version,
		contentHash: stamp.contentHash,
	});
}

/** The convergence claim the room's map resolves to, if any. */
export function readConvergenceClaim(
	ydoc: RoomDocument,
): ConvergenceClaim | null {
	const claim = ydoc.getMap(ROOM_META_MAP).get(ROOM_CLAIM_KEY);
	if (
		typeof claim !== "object" ||
		claim === null ||
		typeof (claim as ConvergenceClaim).clientId !== "number" ||
		!isRoomStamp((claim as ConvergenceClaim).target)
	) {
		return null;
	}
	const { clientId, target, settled, failedAt } = claim as ConvergenceClaim;
	return {
		clientId,
		target: { version: target.version, contentHash: target.contentHash },
		...(settled === "verified" || settled === "failed" ? { settled } : {}),
		...(settled === "failed" && Number.isFinite(failedAt)
			? { failedAt }
			: {}),
	};
}

/** Writes `claim`; `failedAt` goes with a failed claim only. */
export function writeConvergenceClaim(
	ydoc: RoomDocument,
	claim: ConvergenceClaim,
): void {
	ydoc.getMap(ROOM_META_MAP).set(ROOM_CLAIM_KEY, {
		clientId: claim.clientId,
		target: {
			version: claim.target.version,
			contentHash: claim.target.contentHash,
		},
		...(claim.settled ? { settled: claim.settled } : {}),
		...(claim.settled === "failed" && Number.isFinite(claim.failedAt)
			? { failedAt: claim.failedAt }
			: {}),
	});
}

/** Whether the room holds no body at all: a room nobody has written yet. */
export function isRoomBodyEmpty(ydoc: RoomDocument): boolean {
	return ydoc.getXmlFragment(ROOM_BODY_FRAGMENT).length === 0;
}

/**
 * The awareness field each editor publishes whether it may edit and whether
 * its tab is visible, for the convergence election.
 */
export const ROOM_PEER_AWARENESS_FIELD = "roomPeer";

/**
 * The awareness field an editor publishes the base of its save in flight
 * in, cleared once it has advanced the room's stamp from the answer.
 */
export const ROOM_SAVE_AWARENESS_FIELD = "roomSave";

export interface RoomPeer {
	canEdit: boolean;
	visible: boolean;
}

function readRoomPeer(
	state: Record<string, unknown> | null | undefined,
): RoomPeer | null {
	const peer = state?.[ROOM_PEER_AWARENESS_FIELD];
	if (typeof peer !== "object" || peer === null) {
		return null;
	}
	return {
		canEdit: (peer as RoomPeer).canEdit === true,
		visible: (peer as RoomPeer).visible === true,
	};
}

/** Publish whether this editor may edit and whether its tab is visible. */
export function publishRoomPeer(
	awareness: GenerationRunAwareness | null | undefined,
	peer: RoomPeer,
): void {
	if (!awareness) {
		return;
	}
	const published = readRoomPeer(awareness.getLocalState());
	if (
		published?.canEdit === peer.canEdit &&
		published.visible === peer.visible
	) {
		return;
	}
	awareness.setLocalStateField(ROOM_PEER_AWARENESS_FIELD, {
		canEdit: peer.canEdit,
		visible: peer.visible,
	});
}

/** Publish the base of this editor's save in flight, or clear it. */
export function publishRoomSaveInFlight(
	awareness: GenerationRunAwareness | null | undefined,
	base: RoomStamp | null,
): void {
	if (!awareness) {
		return;
	}
	const published =
		awareness.getLocalState()?.[ROOM_SAVE_AWARENESS_FIELD] ?? null;
	if (published === null && base === null) {
		return;
	}
	awareness.setLocalStateField(
		ROOM_SAVE_AWARENESS_FIELD,
		base ? { version: base.version, contentHash: base.contentHash } : null,
	);
}

/** Another editor's save in flight, by the base it names. */
interface PeerRoomSave {
	clientId: number;
	base: RoomStamp;
}

/**
 * The saves other editors in the room have in flight, each with the base it
 * names. Only a client that published that it may edit counts, which is a
 * filter, not a guarantee: awareness is not checked by the collaboration
 * server, so a viewer can publish anything, including states for clients it
 * invents, and its saves are refused anyway. How long these hold the stale
 * rule back, in total, is the caller's to bound (see
 * `ROOM_CONVERGENCE_TIMINGS.fallThroughMs`).
 */
export function peerRoomSavesInFlight(
	awareness: GenerationRunAwareness | null | undefined,
): PeerRoomSave[] {
	if (!awareness) {
		return [];
	}
	const saves: PeerRoomSave[] = [];
	for (const [clientId, state] of awareness.getStates()) {
		if (clientId === awareness.clientID || !readRoomPeer(state)?.canEdit) {
			continue;
		}
		const save = state?.[ROOM_SAVE_AWARENESS_FIELD];
		if (typeof save !== "object" || save === null) {
			continue;
		}
		const { version, contentHash } = save as Partial<RoomStamp>;
		saves.push({
			clientId,
			base: {
				version: typeof version === "number" ? version : 0,
				contentHash: typeof contentHash === "string" ? contentHash : "",
			},
		});
	}
	return saves;
}

/*
 * An assistant proposal under review (Fizzy #2946).
 *
 * A proposal is reviewed in the editor that asked for it: its text, diff
 * marks included, is in that editor's body, so it is in the room, and every
 * other editor shows it before anyone has answered it. A save from any of
 * them would write it, and a later Reject restores the reviewing editor but
 * not the saved document. So the reviewing editor publishes the proposal in
 * its awareness state until it is answered or the editor goes, and every
 * other editor holds still meanwhile: no input, no saves, and no
 * convergence that would replace the proposal.
 *
 * Two editors that begin a review at once settle which one holds the same
 * way everywhere (see `newProposalReview`).
 *
 * A role whose editor is gone does not hold anyone for long: closing the tab
 * withdraws its awareness state, the collaboration server withdraws a
 * client's states when its connection closes, and a client that stops
 * renewing its state (every 15 s) is dropped by every other client 30 s
 * after its last renewal (y-protocols' `outdatedTimeout`). An editor that
 * does not know the field ignores it, and holds nothing.
 */

/**
 * The awareness field an editor publishes the assistant proposal it reviews
 * in: an identity of that review, or `null` when it reviews none.
 */
export const PROPOSAL_REVIEW_AWARENESS_FIELD = "proposalReview";

/**
 * A new review's identity: when it began, by this editor's clock, and a
 * random part — `<ms>:<uuid>`.
 *
 * Two editors can begin a review before either has heard of the other's.
 * Every editor then settles it the same way, from what both published: the
 * review that began first holds, the smaller client id breaking a tie, and
 * the other withdraws its own. Clocks may differ between machines; every
 * editor still picks the same one.
 */
export function newProposalReview(now: number = Date.now()): string {
	return `${now}:${crypto.randomUUID()}`;
}

/**
 * Publish the proposal this editor reviews, by an identity of the review,
 * or clear it with `null`. Sends nothing when that is already published.
 */
export function publishProposalReview(
	awareness: GenerationRunAwareness | null | undefined,
	review: string | null,
): void {
	if (!awareness) {
		return;
	}
	const published =
		awareness.getLocalState()?.[PROPOSAL_REVIEW_AWARENESS_FIELD] ?? null;
	if (published !== review) {
		awareness.setLocalStateField(PROPOSAL_REVIEW_AWARENESS_FIELD, review);
	}
}

function publishedReview(
	state: Record<string, unknown> | null | undefined,
): string | null {
	const review = state?.[PROPOSAL_REVIEW_AWARENESS_FIELD];
	return typeof review === "string" && review.length > 0 ? review : null;
}

/** When a review began; one without a time is taken to begin last. */
function reviewStartedAt(review: string): number {
	const startedAt = Number(review.slice(0, review.indexOf(":")));
	return review.includes(":") && Number.isFinite(startedAt)
		? startedAt
		: Number.POSITIVE_INFINITY;
}

/** Whether review `a`, published by client `aClient`, holds over `b`'s. */
function reviewHoldsOver(
	a: string,
	aClient: number,
	b: string,
	bClient: number,
): boolean {
	const aAt = reviewStartedAt(a);
	const bAt = reviewStartedAt(b);
	return aAt !== bAt ? aAt < bAt : aClient < bClient;
}

/**
 * The reviews other editors in the room publish, by client. Only a client
 * that published that it may edit counts — a filter, not a guarantee, as
 * for `peerRoomSavesInFlight`: a viewer cannot ask for a proposal, and one
 * that publishes a review anyway would hold every editor in the room.
 */
function peerReviews(
	awareness: GenerationRunAwareness,
): Array<{ clientId: number; review: string }> {
	const reviews: Array<{ clientId: number; review: string }> = [];
	for (const [clientId, state] of awareness.getStates()) {
		const review = publishedReview(state);
		if (
			clientId !== awareness.clientID &&
			review !== null &&
			readRoomPeer(state)?.canEdit
		) {
			reviews.push({ clientId, review });
		}
	}
	return reviews;
}

/**
 * Whether another editor's review holds this editor. Its own review never
 * does; another one does unless this editor reviews one of its own that
 * holds over it (see `newProposalReview`) — the editor whose review holds
 * is never held by the one that withdraws.
 */
export function peerReviewsProposal(
	awareness: GenerationRunAwareness | null | undefined,
): boolean {
	if (!awareness) {
		return false;
	}
	const own = publishedReview(awareness.getLocalState());
	return peerReviews(awareness).some(
		({ clientId, review }) =>
			own === null ||
			reviewHoldsOver(review, clientId, own, awareness.clientID),
	);
}

/**
 * The name of the person whose review holds this editor (see
 * `peerReviewsProposal`), as their editor publishes it with its cursor:
 * the earliest of those reviews, as every editor settles it. `null` when no
 * review holds this editor, or the one that does names nobody — no name,
 * or the "Anonymous" an editor publishes without one.
 */
export function proposalReviewerName(
	awareness: GenerationRunAwareness | null | undefined,
): string | null {
	if (!awareness) {
		return null;
	}
	const own = publishedReview(awareness.getLocalState());
	let holding: { clientId: number; review: string } | null = null;
	for (const peer of peerReviews(awareness)) {
		if (
			(own === null ||
				reviewHoldsOver(
					peer.review,
					peer.clientId,
					own,
					awareness.clientID,
				)) &&
			(holding === null ||
				reviewHoldsOver(
					peer.review,
					peer.clientId,
					holding.review,
					holding.clientId,
				))
		) {
			holding = peer;
		}
	}
	if (holding === null) {
		return null;
	}
	const user = awareness.getStates().get(holding.clientId)?.user as
		| { name?: unknown }
		| null
		| undefined;
	const name = typeof user?.name === "string" ? user.name.trim() : "";
	// What an editor without a signed-in name publishes names nobody.
	return name.length > 0 && name !== "Anonymous" ? name : null;
}

/**
 * Whether another client in the room published that it may edit: someone
 * a proposal under review here holds still (see `peerReviews` for what the
 * filter guarantees).
 */
export function roomHasOtherEditor(
	awareness: GenerationRunAwareness | null | undefined,
): boolean {
	if (!awareness) {
		return false;
	}
	for (const [clientId, state] of awareness.getStates()) {
		if (clientId !== awareness.clientID && readRoomPeer(state)?.canEdit) {
			return true;
		}
	}
	return false;
}

/**
 * The other editors whose reviews this editor's own review holds over:
 * they withdraw theirs, and what they wrote into the room before they did
 * is theirs to be replaced (see `newProposalReview`). Empty when this
 * editor reviews nothing.
 */
export function peerReviewsHeldOver(
	awareness: GenerationRunAwareness | null | undefined,
): Set<number> {
	const held = new Set<number>();
	const own = awareness ? publishedReview(awareness.getLocalState()) : null;
	if (!awareness || own === null) {
		return held;
	}
	for (const { clientId, review } of peerReviews(awareness)) {
		if (reviewHoldsOver(own, awareness.clientID, review, clientId)) {
			held.add(clientId);
		}
	}
	return held;
}

/**
 * Whether any editor in the room, this one included, reviews an assistant
 * proposal: the room holds text nobody has answered yet, which a convergence
 * must not take for a room behind the saved document.
 */
export function roomReviewsProposal(
	awareness: GenerationRunAwareness | null | undefined,
): boolean {
	return (
		!!awareness &&
		(publishedReview(awareness.getLocalState()) !== null ||
			peerReviews(awareness).length > 0)
	);
}

/**
 * The part of the room's awareness the convergence reads, as one string:
 * who is in the room, and what each client published as its peer state,
 * its save in flight, its run role and the proposal it reviews. Equal
 * strings mean nothing the convergence reads changed — a cursor or a
 * selection moved, say.
 */
export function roomAwarenessSignature(
	awareness: GenerationRunAwareness | null | undefined,
): string {
	if (!awareness) {
		return "";
	}
	const entries = [...awareness.getStates().entries()]
		.sort(([a], [b]) => a - b)
		.map(([clientId, state]) => [
			clientId,
			state?.[ROOM_PEER_AWARENESS_FIELD] ?? null,
			state?.[ROOM_SAVE_AWARENESS_FIELD] ?? null,
			state?.[GENERATION_RUN_AWARENESS_FIELD] ?? null,
			state?.[PROPOSAL_REVIEW_AWARENESS_FIELD] ?? null,
		]);
	return JSON.stringify(entries);
}

/**
 * This editor's place in the order the convergence election tries editors
 * in, or `null` when it may not edit: a read-only client never writes the
 * room. Only clients that published that they may edit are candidates — a
 * viewer is never elected, whatever its client id or the run role it
 * claims — then a visible tab before a hidden one, then the smaller client
 * id. This editor counts with what it is about to publish, whether or not
 * its state has reached the room yet.
 */
export function convergenceRank(
	awareness: GenerationRunAwareness | null | undefined,
	own: RoomPeer,
): number | null {
	if (!own.canEdit) {
		return null;
	}
	if (!awareness) {
		return 0;
	}
	const ownId = awareness.clientID;
	const ahead = (clientId: number, peer: RoomPeer) =>
		peer.visible !== own.visible ? peer.visible : clientId < ownId;
	let rank = 0;
	for (const [clientId, state] of awareness.getStates()) {
		if (clientId === ownId) {
			continue;
		}
		const peer = readRoomPeer(state);
		if (peer?.canEdit && ahead(clientId, peer)) {
			rank += 1;
		}
	}
	return rank;
}

export function roomStampKey(stamp: RoomStamp): string {
	return `${stamp.version}:${stamp.contentHash}`;
}

/** One failed claim, told apart from a later one for the same body. */
export function failedClaimKey(claim: ConvergenceClaim): string {
	return `${claim.clientId}:${roomStampKey(claim.target)}:${claim.failedAt ?? ""}`;
}
