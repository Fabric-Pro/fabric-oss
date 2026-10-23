import type { Editor } from "@tiptap/core";
import { useCallback, useEffect, useRef, useState } from "react";
import type * as Y from "yjs";
import { getEditorMarkdownForSave } from "../../lib/editor-markdown-save";
import { ROOM_BODY_FRAGMENT } from "../../lib/room-body-fragment";
import {
	type ConvergenceClaim,
	convergenceRank,
	failedClaimKey,
	isRoomBodyEmpty,
	ROOM_CONVERGENCE_TIMINGS,
	ROOM_META_MAP,
	type RoomAwareness,
	type RoomStamp,
	readConvergenceClaim,
	readRoomStamp,
	roomAwarenessSignature,
	roomStampKey,
	sameRoomStamp,
	writeConvergenceClaim,
	writeRoomStamp,
} from "./generation-run-awareness";
import {
	peerRoomSavesHoldUntil,
	sameBody,
	savedBodyAsEditorWritesIt,
	transactionTouches,
} from "./room-convergence-helpers";

/**
 * Where a collaborative editor's room stands against the saved document
 * (Fizzy #2946), while `DOCUMENT_ROOM_CONVERGENCE` is on. The rule itself is
 * described with the room stamp in `generation-run-awareness.ts`.
 *
 * - `inSync`: the room's stamp names the saved body (or nothing is checked).
 * - `checking`: the stamp differed once; a second look, a poll interval
 *   later, decides. Saves wait. What the editor shows meanwhile is
 *   `CheckingView`.
 * - `updating`: the room is behind and is being brought to the saved body,
 *   by this editor or another. Saves wait and the editor is read-only.
 * - `failed`: the room still differed from the saved body after one more
 *   application. Saves stay frozen and reloading is offered.
 * - `behindReadOnly`: the room is behind and this client may not edit. It
 *   shows the saved body and never writes the room.
 */
export type RoomStatus =
	| "inSync"
	| "checking"
	| "updating"
	| "failed"
	| "behindReadOnly";

/**
 * What the editor shows while the room is `checking` (Fizzy #2946). A run
 * that ended is usually put into the room by the editor that follows it, a
 * moment after this one learned of the end — or a poll later, or never, when
 * no editor follows it. Until then the room holds the body from before the
 * run, so the editor stops taking input at once (`frozen`) and gives way to
 * the saved body after `savedBodyGraceMs` (`savedBody`): nobody types into a
 * body about to be replaced, and the page does not swap views for the moment
 * a following editor takes. Only for the end of a run this room has not
 * taken in. An editor that has not seen the room in step yet cannot tell
 * that from a rewind, and only holds still. For anything else, and in an
 * editor with typing of its own, the room's body stays as it is (`room`).
 */
export type CheckingView = "room" | "frozen" | "savedBody";

interface RoomConvergenceOptions {
	/** Flag on, collaborative, provider ready and synced. */
	active: boolean;
	ydoc: Y.Doc | null;
	awareness: RoomAwareness | null | undefined;
	editor: Editor | null;
	/** `null` while the project, which says so, has not loaded. */
	canEdit: boolean | null;
	visible: boolean;
	/** The saved document's stamp, from the document query. */
	savedStamp: RoomStamp | null;
	savedBody: string | null;
	/**
	 * The saved document's latest run, by its identity, or `null` when it
	 * names none.
	 */
	savedRun?: string | null;
	/** When the document query last answered. */
	savedAt: number;
	runLive: boolean;
	ownSaveInFlight: boolean;
	/** Typed in this editor since its last save. */
	hasLocalTyping: () => boolean;
	refetchSaved: () => void;
	/** Puts a saved body into the room together with its stamp. */
	applySavedBody: (markdown: string, stamp: RoomStamp) => void;
	/** The editor now holds this saved body: nothing in it is unsaved. */
	adoptSavedBody: (markdown: string, stamp: RoomStamp) => void;
	/** Offers text the room is about to lose back to this person, once. */
	offerBack: (text: string) => void;
	/**
	 * What this person has typed here, as it would be offered back: the raw
	 * view's text while it holds edits of its own. The editor's when absent.
	 */
	readLocalText?: () => string | null;
}

interface RoomConvergenceMemo {
	/** The first look that found the stamp differing. */
	observation: { at: number; savedAt: number } | null;
	staleSince: number | null;
	/** When this editor first saw another editor's claim for the target. */
	claimSeenAt: number | null;
	claimTarget: RoomStamp | null;
	claimedAt: number | null;
	/** The body this editor applied and the form it read back right after. */
	applied: {
		target: RoomStamp;
		form: string;
		at: number;
		reapplied: boolean;
	} | null;
	/**
	 * Another editor's convergence merged into the room since this editor
	 * last read back the body it applied.
	 */
	recheckApplied: boolean;
	adoptedFor: string | null;
	/** A convergence this editor saw under way, before it was read back. */
	witnessedFor: string | null;
	/**
	 * The stamp of the last saved body another editor put into the room
	 * together with its stamp — a run's review, a rewind, a convergence —
	 * moved on with that body's later versions.
	 */
	serverBody: RoomStamp | null;
	offeredFor: string | null;
	/** The saved document as this editor last saw the room hold it. */
	inSyncAt: RoomStamp | null;
	/**
	 * The run the saved document named when this editor last saw the room
	 * hold it with no run under way; `undefined` before that. Kept through a
	 * run, unlike `inSyncAt`.
	 */
	inSyncRun: string | null | undefined;
	/**
	 * The run under way when this editor last saw the room hold the saved
	 * document: until that run ends, the saved body is the one from before
	 * it. Cleared once the room is seen in step outside a run.
	 */
	inSyncBeforeRun: string | null;
	/** The fetch made when the room moved on alone, and which stamp moved. */
	roomAheadFetch: { stamp: RoomStamp; savedAt: number } | null;
	/** The room's stamp at the last look; `undefined` before the first. */
	lastStamp: RoomStamp | null | undefined;
	savedForm: { body: string; form: string | null } | null;
	/**
	 * When this editor first saw each colleague's save in flight, by client
	 * and base: one holds the stale rule back for one fall-through interval.
	 */
	peerSavesSeen: Map<string, number>;
	/**
	 * When colleagues' saves in flight first held this stale episode back:
	 * together they hold it for one fall-through interval at most, whatever
	 * bases or clients they name. Cleared once the room is in sync.
	 */
	peerHoldSince: number | null;
	/**
	 * The failed claim this editor last saw and when, by its own clock: a
	 * claim's `failedAt` is the claimant's clock, so the hold is timed from
	 * here and `failedAt` only tells two failures apart.
	 */
	failedClaimSeen: { key: string; at: number } | null;
	/**
	 * The failed claim the room held at this editor's first look, which it
	 * does not honour: one more bounded attempt is this editor's to make.
	 * `undefined` before the first look.
	 */
	failedClaimAtMount: string | null | undefined;
	/** The saved body this editor's own convergence failed to put in. */
	failedHere: string | null;
	/** A failed claim the person asked to try again past. */
	failedClaimDismissed: string | null;
}

/** Forgets the looks and the claim this editor was waiting on. */
function resetWaiting(memo: RoomConvergenceMemo): void {
	memo.observation = null;
	memo.staleSince = null;
	memo.claimSeenAt = null;
}

/**
 * Brings a collaborative room that fell behind the saved document back to it
 * (Fizzy #2946). The stale rule, the claim and the election are described
 * with the room stamp in `generation-run-awareness.ts`; this hook runs them
 * against the editor, the room and the document query.
 *
 * Its memory lives in the editor below the sync branch, so a sync loss
 * starts the looks again: a room that just reconnected is looked at twice
 * before anything is replaced.
 */
export function useRoomConvergence(options: RoomConvergenceOptions): {
	status: RoomStatus;
	/** What the editor shows while `status` is `checking`. */
	checkingView: CheckingView;
	/**
	 * A save named the room's stamp and the server refused it with CONFLICT
	 * while the stamp had not moved: the first look at a room behind the
	 * saved document.
	 */
	noteConflict: () => void;
	/**
	 * The person asked for the latest saved version after a failed update:
	 * one more bounded attempt to bring the room to it.
	 */
	reloadLatest: () => void;
} {
	const [status, setStatus] = useState<RoomStatus>("inSync");
	const [checkingView, setCheckingView] = useState<CheckingView>("room");
	const [roomTick, setRoomTick] = useState(0);
	const optionsRef = useRef(options);
	optionsRef.current = options;
	const memoRef = useRef<RoomConvergenceMemo>({
		observation: null,
		staleSince: null,
		claimSeenAt: null,
		claimTarget: null,
		claimedAt: null,
		applied: null,
		recheckApplied: false,
		adoptedFor: null,
		witnessedFor: null,
		serverBody: null,
		offeredFor: null,
		inSyncAt: null,
		inSyncRun: undefined,
		inSyncBeforeRun: null,
		roomAheadFetch: null,
		lastStamp: undefined,
		savedForm: null,
		peerSavesSeen: new Map(),
		peerHoldSince: null,
		failedClaimSeen: null,
		failedClaimAtMount: undefined,
		failedHere: null,
		failedClaimDismissed: null,
	});
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const evaluateRef = useRef<() => void>(() => {});
	const { active, ydoc, awareness } = options;

	const clearTimer = () => {
		if (timerRef.current) {
			clearTimeout(timerRef.current);
			timerRef.current = null;
		}
	};
	const schedule = (ms: number, refetchFirst = false) => {
		clearTimer();
		timerRef.current = setTimeout(
			() => {
				timerRef.current = null;
				if (refetchFirst) {
					optionsRef.current.refetchSaved();
				}
				evaluateRef.current();
			},
			Math.max(ms, 0),
		);
	};

	// Text the room is about to lose, offered back once per replacement, to
	// the person who typed it after their last save — or to whoever is here
	// when the room predates its stamp (Fizzy #2946). Read before the
	// replacement reaches the editor.
	const offerBackBeforeReplacement = (
		target: RoomStamp,
		roomWasUnstamped: boolean,
	) => {
		const o = optionsRef.current;
		const memo = memoRef.current;
		const key = roomStampKey(target);
		if (memo.offeredFor === key || !o.editor || o.editor.isDestroyed) {
			return;
		}
		if (!roomWasUnstamped && !o.hasLocalTyping()) {
			return;
		}
		const text = o.readLocalText
			? o.readLocalText()
			: getEditorMarkdownForSave(o.editor);
		if (!text?.trim()) {
			return;
		}
		memo.offeredFor = key;
		o.offerBack(text);
	};

	evaluateRef.current = () => {
		const o = optionsRef.current;
		const memo = memoRef.current;
		const { editor } = o;
		const room = o.ydoc;
		if (!o.active || !room || !editor || editor.isDestroyed) {
			clearTimer();
			memo.observation = null;
			memo.staleSince = null;
			memo.peerHoldSince = null;
			setStatus("inSync");
			return;
		}
		const saved = o.savedStamp;
		const savedBody = o.savedBody;
		if (!saved || savedBody === null) {
			clearTimer();
			setStatus("inSync");
			return;
		}
		const timings = ROOM_CONVERGENCE_TIMINGS;
		const now = Date.now();
		const ownId = room.clientID;
		const stamp = readRoomStamp(room);
		const claim = readConvergenceClaim(room);
		const claimForSaved =
			claim && sameRoomStamp(claim.target, saved) ? claim : null;
		const roomWasUnstamped = memo.lastStamp === null;
		memo.lastStamp = stamp;
		if (memo.failedClaimAtMount === undefined) {
			memo.failedClaimAtMount =
				claim?.settled === "failed" ? failedClaimKey(claim) : null;
		}
		// Until when a failed claim keeps this editor frozen, or `null` when
		// it does not (see the room stamp in `generation-run-awareness.ts`):
		// for good in the session that wrote it and in an editor whose own
		// attempt failed; for a short while in an editor that saw another
		// one's fail, timed from when this editor first saw it; not in an
		// editor opened after it was written, nor once the person asked to
		// reload the latest version.
		const failedClaimHoldsUntil = (
			failed: ConvergenceClaim,
		): number | null => {
			const key = failedClaimKey(failed);
			if (memo.failedClaimDismissed === key) {
				return null;
			}
			if (
				failed.clientId === ownId ||
				memo.failedHere === roomStampKey(failed.target)
			) {
				return Number.POSITIVE_INFINITY;
			}
			if (
				memo.failedClaimAtMount === key ||
				failed.failedAt === undefined
			) {
				return null;
			}
			if (memo.failedClaimSeen?.key !== key) {
				memo.failedClaimSeen = { key, at: now };
			}
			const until = memo.failedClaimSeen.at + timings.failedClaimExpiryMs;
			return until > now ? until : null;
		};

		if (sameRoomStamp(stamp, saved)) {
			memo.observation = null;
			memo.peerHoldSince = null;
			memo.inSyncAt = saved;
			memo.roomAheadFetch = null;
			if (o.runLive) {
				memo.inSyncBeforeRun = o.savedRun ?? null;
			} else {
				memo.inSyncRun = o.savedRun ?? null;
				memo.inSyncBeforeRun = null;
			}
			const failedClaim =
				claimForSaved?.settled === "failed" ? claimForSaved : null;
			const failedHoldsUntil = failedClaim
				? failedClaimHoldsUntil(failedClaim)
				: null;
			if (failedHoldsUntil !== null) {
				memo.staleSince = null;
				if (Number.isFinite(failedHoldsUntil)) {
					schedule(failedHoldsUntil - now);
				} else {
					clearTimer();
				}
				setStatus("failed");
				return;
			}
		}
		// Past here, a failed claim is one this editor does not honour: its
		// claimant gave up, so neither branch below runs and the body is
		// checked at once, as for a stale room — one more bounded attempt,
		// which replaces the claim.
		if (
			sameRoomStamp(stamp, saved) &&
			claimForSaved?.settled !== "failed"
		) {
			const applied =
				memo.applied && sameRoomStamp(memo.applied.target, saved)
					? memo.applied
					: null;
			if (applied && claimForSaved?.clientId === ownId) {
				// This editor's convergence: its body is read back once the
				// claim had time to meet a concurrent one, and again whenever
				// another editor's convergence merges in — two editors that
				// applied the same body at once leave it in the room twice,
				// and the claim's winner replaces it once more.
				const recheck = memo.recheckApplied;
				memo.recheckApplied = false;
				if (claimForSaved.settled === "verified" && !recheck) {
					clearTimer();
					setStatus("inSync");
					return;
				}
				const waited = now - applied.at;
				if (!claimForSaved.settled && waited < timings.claimSettleMs) {
					schedule(timings.claimSettleMs - waited);
					setStatus("updating");
					return;
				}
				const form = getEditorMarkdownForSave(editor) ?? "";
				if (sameBody(form, applied.form)) {
					if (claimForSaved.settled !== "verified") {
						writeConvergenceClaim(room, {
							...claimForSaved,
							settled: "verified",
						});
					}
					clearTimer();
					setStatus("inSync");
					return;
				}
				if (!applied.reapplied) {
					room.transact(() => {
						writeConvergenceClaim(room, {
							clientId: ownId,
							target: saved,
						});
						o.applySavedBody(savedBody, saved);
					});
					memo.applied = {
						target: saved,
						form: getEditorMarkdownForSave(editor) ?? "",
						at: now,
						reapplied: true,
					};
					schedule(timings.claimSettleMs);
					setStatus("updating");
					return;
				}
				// Still not the saved body after one more application: saves
				// stay frozen and reloading is offered. The time lets the
				// editors that see it fail make one more attempt later.
				writeConvergenceClaim(room, {
					...claimForSaved,
					settled: "failed",
					failedAt: now,
				});
				memo.failedHere = roomStampKey(saved);
				clearTimer();
				setStatus("failed");
				return;
			}
			if (!claimForSaved || claimForSaved.settled === "verified") {
				clearTimer();
				memo.staleSince = null;
				memo.claimSeenAt = null;
				const key = roomStampKey(saved);
				if (
					claimForSaved &&
					memo.witnessedFor === key &&
					memo.adoptedFor !== key
				) {
					// Another editor brought the room here while this one
					// watched: nothing in this editor is unsaved any more.
					memo.adoptedFor = key;
					o.adoptSavedBody(savedBody, saved);
				} else if (
					sameRoomStamp(memo.serverBody, saved) &&
					memo.adoptedFor !== key &&
					!o.hasLocalTyping()
				) {
					// Another editor put this saved body into the room with its
					// stamp — a run's review, a rewind — with no convergence
					// to watch: it is this editor's saved body too.
					memo.adoptedFor = key;
					o.adoptSavedBody(savedBody, saved);
				}
				setStatus("inSync");
				return;
			}
			// This editor's own claim, not applied yet — one more attempt
			// over a room whose stamp already names the saved body — goes
			// on below.
			const ownClaimPending =
				claimForSaved.clientId === ownId &&
				memo.claimedAt !== null &&
				sameRoomStamp(memo.claimTarget, saved);
			if (!ownClaimPending) {
				// Another editor's convergence to the saved body is reading
				// its body back.
				memo.witnessedFor = roomStampKey(saved);
				if (o.canEdit !== true) {
					clearTimer();
					setStatus("behindReadOnly");
					return;
				}
				memo.claimSeenAt ??= now;
				const waited = now - memo.claimSeenAt;
				if (waited < timings.fallThroughMs) {
					schedule(timings.fallThroughMs - waited);
					setStatus("updating");
					return;
				}
			}
			// The claimant went quiet before it read its body back: the
			// body is checked here, as for a stale room.
		} else if (!sameRoomStamp(stamp, saved)) {
			if (
				stamp &&
				stamp.contentHash === saved.contentHash &&
				stamp.version < saved.version &&
				o.canEdit === true
			) {
				// The same body at a later version — a run's version step,
				// which no one announces: the room holds the saved body
				// already, so its stamp moves at once, with nothing to look
				// at twice and nothing to claim. A claim for it not yet
				// verified is.
				if (claimForSaved && claimForSaved.settled !== "verified") {
					writeConvergenceClaim(room, {
						...claimForSaved,
						settled: "verified",
					});
				}
				writeRoomStamp(room, saved);
				resetWaiting(memo);
				memo.inSyncAt = saved;
				memo.roomAheadFetch = null;
				memo.peerHoldSince = null;
				if (!o.hasLocalTyping()) {
					memo.adoptedFor = roomStampKey(saved);
					o.adoptSavedBody(savedBody, saved);
				}
				clearTimer();
				setStatus("inSync");
				return;
			}
			const roomAheadFetch = memo.roomAheadFetch;
			if (
				stamp &&
				memo.inSyncAt &&
				sameRoomStamp(memo.inSyncAt, saved) &&
				!(
					roomAheadFetch &&
					sameRoomStamp(roomAheadFetch.stamp, stamp) &&
					o.savedAt > roomAheadFetch.savedAt
				)
			) {
				// The room moved on from the saved document this editor last
				// saw it hold — another editor saved it, or took on a body from
				// the server — so this editor's copy of the document is what is
				// behind. It is fetched again, and nothing waits meanwhile. Only
				// when the fresh copy still differs does the stale rule look.
				if (
					!roomAheadFetch ||
					!sameRoomStamp(roomAheadFetch.stamp, stamp)
				) {
					memo.roomAheadFetch = { stamp, savedAt: o.savedAt };
					o.refetchSaved();
				}
				clearTimer();
				setStatus("inSync");
				return;
			}
			memo.inSyncAt = null;
			if (stamp === null && isRoomBodyEmpty(room) && o.canEdit === true) {
				// A room nobody has written: the first editor's seed fills it,
				// stamp included. An empty saved body has nothing to seed, so
				// only its stamp goes in.
				if (savedBody === "") {
					writeRoomStamp(room, saved);
				}
				clearTimer();
				setStatus("inSync");
				return;
			}
			// The run's own steps, or a colleague's save whose answer will
			// advance the stamp. A client publishes in its awareness that it
			// may edit and that it has a save in flight, and the
			// collaboration server checks neither (see
			// `peerRoomSavesInFlight`), so colleagues' saves together hold
			// this stale episode back for one fall-through interval at most:
			// a save that never answers, a client that keeps naming new
			// bases, or many clients do not hold a stale room for good.
			let peerSavesHoldUntil = o.runLive
				? null
				: peerRoomSavesHoldUntil(o.awareness, memo.peerSavesSeen, now);
			if (peerSavesHoldUntil !== null) {
				memo.peerHoldSince ??= now;
				const capUntil = memo.peerHoldSince + timings.fallThroughMs;
				peerSavesHoldUntil =
					capUntil > now
						? Math.min(peerSavesHoldUntil, capUntil)
						: null;
			}
			if (o.runLive || peerSavesHoldUntil !== null) {
				resetWaiting(memo);
				if (peerSavesHoldUntil !== null) {
					schedule(peerSavesHoldUntil - now);
				} else {
					clearTimer();
				}
				setStatus("inSync");
				return;
			}
			// The room holds another body than the saved one, at the saved
			// version or an earlier one, and the saved document names a run
			// other than the one it named when this editor last saw the room
			// in step, or the run that was under way then: a run ended that
			// the room has not taken in yet (see `CheckingView`). The run is
			// what tells this apart from the rewind of a rejected regeneration
			// with no version to go back to, which keeps the version: with
			// this editor's copy of the document older than the room, that
			// would show the older body.
			const runEndNotTakenIn =
				stamp !== null &&
				stamp.contentHash !== saved.contentHash &&
				saved.version >= stamp.version &&
				o.savedRun != null &&
				((memo.inSyncRun !== undefined &&
					o.savedRun !== memo.inSyncRun) ||
					o.savedRun === memo.inSyncBeforeRun) &&
				!o.hasLocalTyping();
			// An editor that has not seen the room in step yet — opened, or
			// back from a drop, with the room already behind — cannot tell a
			// run's end from a rewind: it holds the room's body still, and
			// shows nothing else, until the second look decides.
			const unexplainedAtMount =
				!runEndNotTakenIn &&
				stamp !== null &&
				stamp.contentHash !== saved.contentHash &&
				saved.version >= stamp.version &&
				memo.inSyncRun === undefined &&
				memo.inSyncBeforeRun === null &&
				!o.hasLocalTyping();
			const showChecking = (observedAt: number) => {
				setCheckingView(
					runEndNotTakenIn
						? now - observedAt >= timings.savedBodyGraceMs
							? "savedBody"
							: "frozen"
						: unexplainedAtMount
							? "frozen"
							: "room",
				);
				setStatus("checking");
			};
			if (o.ownSaveInFlight) {
				// Its answer advances the stamp; look again then.
				clearTimer();
				if (memo.observation) {
					showChecking(memo.observation.at);
				} else {
					setStatus("inSync");
				}
				return;
			}
			if (!memo.observation) {
				memo.observation = { at: now, savedAt: o.savedAt };
				if (
					runEndNotTakenIn &&
					timings.savedBodyGraceMs < timings.observationGapMs
				) {
					// The saved body takes over first. When it does, the branch
					// below schedules the second look for the usual moment.
					schedule(timings.savedBodyGraceMs);
				} else {
					schedule(timings.observationGapMs, true);
				}
				showChecking(now);
				return;
			}
			const elapsed = now - memo.observation.at;
			if (
				elapsed < timings.observationGapMs ||
				o.savedAt <= memo.observation.savedAt
			) {
				if (
					runEndNotTakenIn &&
					elapsed < timings.savedBodyGraceMs &&
					timings.savedBodyGraceMs < timings.observationGapMs
				) {
					// Also in a look a conflict opened, or one this editor's
					// own save held: the saved body takes over first.
					schedule(timings.savedBodyGraceMs - elapsed);
				} else if (!timerRef.current) {
					schedule(
						elapsed < timings.observationGapMs
							? timings.observationGapMs - elapsed
							: timings.observationGapMs,
						true,
					);
				}
				showChecking(memo.observation.at);
				return;
			}
		}

		// The room is behind the saved document.
		if (o.canEdit !== true) {
			clearTimer();
			setStatus("behindReadOnly");
			return;
		}
		memo.staleSince ??= now;
		const roomBody = getEditorMarkdownForSave(editor);
		if (memo.savedForm?.body !== savedBody) {
			memo.savedForm = {
				body: savedBody,
				form: savedBodyAsEditorWritesIt(savedBody, editor),
			};
		}
		const savedForm = memo.savedForm.form;
		if (
			roomBody !== null &&
			savedForm !== null &&
			sameBody(roomBody, savedForm)
		) {
			// The same body: only the stamp moves, and a claim not yet
			// verified — a failed one included — is.
			if (claimForSaved && claimForSaved.settled !== "verified") {
				writeConvergenceClaim(room, {
					...claimForSaved,
					settled: "verified",
				});
			}
			writeRoomStamp(room, saved);
			resetWaiting(memo);
			memo.adoptedFor = roomStampKey(saved);
			o.adoptSavedBody(savedBody, saved);
			clearTimer();
			setStatus("inSync");
			return;
		}

		// The election: the editors ahead of this one get their turn first.
		// A failed claim holds no turn: its claimant gave up.
		const rank =
			convergenceRank(o.awareness, {
				canEdit: true,
				visible: o.visible,
			}) ?? 0;
		const foreignClaim =
			claimForSaved &&
			claimForSaved.clientId !== ownId &&
			claimForSaved.settled !== "failed"
				? claimForSaved
				: null;
		if (foreignClaim) {
			memo.claimSeenAt ??= now;
		}
		const due = foreignClaim
			? (memo.claimSeenAt ?? now) + (rank + 1) * timings.fallThroughMs
			: memo.staleSince + rank * timings.fallThroughMs;
		if (now < due) {
			schedule(due - now);
			setStatus("updating");
			return;
		}
		const ownClaimStands =
			claimForSaved?.clientId === ownId &&
			memo.claimedAt !== null &&
			sameRoomStamp(memo.claimTarget, saved);
		if (!ownClaimStands || foreignClaim) {
			writeConvergenceClaim(room, { clientId: ownId, target: saved });
			memo.claimTarget = saved;
			memo.claimedAt = now;
			memo.claimSeenAt = null;
			schedule(timings.claimSettleMs);
			setStatus("updating");
			return;
		}
		const sinceClaim = now - (memo.claimedAt ?? now);
		if (sinceClaim < timings.claimSettleMs) {
			schedule(timings.claimSettleMs - sinceClaim);
			setStatus("updating");
			return;
		}
		// The map resolved to this editor's claim: it applies.
		offerBackBeforeReplacement(saved, roomWasUnstamped || stamp === null);
		o.applySavedBody(savedBody, saved);
		memo.applied = {
			target: saved,
			form: getEditorMarkdownForSave(editor) ?? "",
			at: now,
			reapplied: false,
		};
		memo.claimTarget = null;
		memo.claimedAt = null;
		memo.adoptedFor = roomStampKey(saved);
		memo.observation = null;
		memo.staleSince = null;
		o.adoptSavedBody(savedBody, saved);
		schedule(timings.claimSettleMs);
		setStatus("updating");
	};

	// Look again whenever the room's metadata changes, or who is in the room
	// or what they published for the convergence. Awareness also changes
	// with every cursor move and selection in the room: those neither render
	// the editor again nor read the room.
	useEffect(() => {
		if (!active || !ydoc) {
			return;
		}
		const meta = ydoc.getMap(ROOM_META_MAP);
		const bump = () => setRoomTick((tick) => tick + 1);
		meta.observe(bump);
		const listens =
			typeof awareness?.on === "function" &&
			typeof awareness?.off === "function";
		let lastAwareness = roomAwarenessSignature(awareness);
		const onAwareness = () => {
			const next = roomAwarenessSignature(awareness);
			if (next !== lastAwareness) {
				lastAwareness = next;
				bump();
			}
		};
		if (listens) {
			awareness.on?.("change", onAwareness);
		}
		return () => {
			meta.unobserve(bump);
			if (listens) {
				awareness.off?.("change", onAwareness);
			}
		};
	}, [active, ydoc, awareness]);

	// Another editor's convergence replaces the body here: offer back what
	// this person typed since their last save before the editor shows the
	// replacement. Type observers — the editor's binding among them — run
	// after this event, so the editor still holds the old body.
	useEffect(() => {
		if (!active || !ydoc) {
			return;
		}
		const meta = ydoc.getMap(ROOM_META_MAP);
		// The key a transaction records the metadata map's changes under.
		const metaType = meta as unknown as Parameters<
			Y.Transaction["changed"]["get"]
		>[0];
		const body = ydoc.getXmlFragment(ROOM_BODY_FRAGMENT);
		const beforeObservers = (transaction: Y.Transaction) => {
			if (transaction.local) {
				return;
			}
			const metaKeys = transaction.changed.get(metaType);
			if (!metaKeys?.has("stamp")) {
				return;
			}
			const target = readRoomStamp(ydoc);
			if (!transactionTouches(transaction, body)) {
				// Only the stamp moved: the same body at a later version is
				// still the saved body another editor put in.
				const known = memoRef.current.serverBody;
				if (target && known?.contentHash === target.contentHash) {
					memoRef.current.serverBody = target;
				}
				return;
			}
			// A body that came with its stamp is a saved one, whether a
			// convergence claimed it or not (a run's review claims nothing):
			// this editor takes it as its saved body once its own copy of
			// the document names it too.
			if (target) {
				memoRef.current.serverBody = target;
			}
			const claim = readConvergenceClaim(ydoc);
			if (!target || !claim || !sameRoomStamp(claim.target, target)) {
				return;
			}
			offerBackBeforeReplacement(
				target,
				memoRef.current.lastStamp === null,
			);
		};
		// A claim or stamp arriving from another editor: a convergence of
		// its own may have merged in with this editor's.
		const afterTransaction = (transaction: Y.Transaction) => {
			if (!transaction.local && transaction.changed.has(metaType)) {
				memoRef.current.recheckApplied = true;
			}
		};
		ydoc.on("beforeObserverCalls", beforeObservers);
		ydoc.on("afterTransaction", afterTransaction);
		return () => {
			ydoc.off("beforeObserverCalls", beforeObservers);
			ydoc.off("afterTransaction", afterTransaction);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [active, ydoc]);

	useEffect(() => {
		evaluateRef.current();
	}, [
		active,
		roomTick,
		options.savedStamp?.version,
		options.savedStamp?.contentHash,
		options.savedBody,
		options.savedRun,
		options.savedAt,
		options.runLive,
		options.ownSaveInFlight,
		options.editor,
		options.canEdit,
		options.visible,
	]);

	useEffect(() => {
		return () => {
			if (timerRef.current) {
				clearTimeout(timerRef.current);
				timerRef.current = null;
			}
		};
	}, []);

	const noteConflict = useCallback(() => {
		const o = optionsRef.current;
		if (!o.active) {
			return;
		}
		// The server says the room is behind: no longer the case of a room
		// that moved on alone.
		memoRef.current.inSyncAt = null;
		memoRef.current.observation ??= { at: Date.now(), savedAt: o.savedAt };
		o.refetchSaved();
		evaluateRef.current();
	}, []);

	const reloadLatest = useCallback(() => {
		const o = optionsRef.current;
		const memo = memoRef.current;
		if (!o.active || !o.ydoc) {
			return;
		}
		// The person asks for the latest saved version: the failure the room
		// holds no longer freezes this editor, which makes one more bounded
		// attempt from the saved document as it is now, replacing the claim.
		const claim = readConvergenceClaim(o.ydoc);
		if (claim?.settled === "failed") {
			memo.failedClaimDismissed = failedClaimKey(claim);
		}
		memo.failedHere = null;
		memo.applied = null;
		memo.claimTarget = null;
		memo.claimedAt = null;
		memo.claimSeenAt = null;
		memo.staleSince = null;
		memo.peerHoldSince = null;
		o.refetchSaved();
		evaluateRef.current();
	}, []);

	return { status, checkingView, noteConflict, reloadLatest };
}
