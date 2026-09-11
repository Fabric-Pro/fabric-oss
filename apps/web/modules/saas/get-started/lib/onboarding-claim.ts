import { useEffect, useState } from "react";
import {
	GET_STARTED_SURFACE_EVENT,
	type SurfaceEventDetail,
} from "./tour-steps";

/**
 * Who is currently claiming the reader's attention (Fizzy #2457, R23).
 *
 * This is the SAME signal `GET_STARTED_SURFACE_EVENT` already carried — the
 * launcher pointer has stood down on it since #2295 — with two things added,
 * both forced by a second consumer that is not the pointer:
 *
 *  1. **A ledger, so more than one surface can publish.** The controller used
 *     to dispatch `{ open: mode !== "idle" }` straight from its own mode
 *     machine, which made it the only possible publisher: any second surface
 *     dispatching `false` on close would have cancelled a controller surface
 *     that was still up. Surfaces now hold a CLAIM, and the broadcast reports
 *     the net state, so the two-modal case ("the account gate is up AND the
 *     drawer is open") closes correctly on the second release rather than the
 *     first. `claimInlineSlot` on the readiness context is the same shape and
 *     the same reason.
 *
 *  2. **A synchronous read.** An event tells a listener about a TRANSITION. A
 *     component that mounts while a surface is already up — the CLI-connection
 *     prompt does, on every client-side navigation into a project — has no
 *     transition to hear and would render straight over it. The ledger answers
 *     that question at mount time.
 *
 * Deliberately module scope rather than a React context. The publishers sit in
 * three different trees (the controller in the app shell, the account gate
 * above it, the project role prompt inside the project page) and the one
 * consumer is in a fourth. A provider enclosing all of them would mean
 * restructuring the app shell to answer one boolean.
 *
 * NOT persisted anywhere: a claim describes what is on the reader's screen
 * right now, and nothing about it should survive a reload.
 */

let claims = 0;

/**
 * Tell every listener the current net state.
 *
 * The payload stays `{ open: boolean }` — the shape the launcher pointer has
 * always read — so nothing downstream had to change to gain the extra
 * publishers.
 */
function broadcast(): void {
	if (typeof window === "undefined") {
		return;
	}
	window.dispatchEvent(
		new CustomEvent<SurfaceEventDetail>(GET_STARTED_SURFACE_EVENT, {
			detail: { open: claims > 0 },
		}),
	);
}

/**
 * Claim the view for an onboarding surface. Returns the release.
 *
 * The release is idempotent, because an effect cleanup can run in circumstances
 * a caller does not control (a Strict Mode double-invoke, a component unmounted
 * mid-transition) and a double decrement would leave the ledger reading "clear"
 * while a surface is still on screen.
 */
export function claimOnboardingView(): () => void {
	claims += 1;
	broadcast();
	let released = false;
	return () => {
		if (released) {
			return;
		}
		released = true;
		claims -= 1;
		broadcast();
	};
}

/**
 * Whether any onboarding surface is on screen RIGHT NOW.
 *
 * The synchronous read the event alone cannot give. Two callers: the hook
 * below, for its initial value, and any consumer that has to confirm the answer
 * at a moment later than its own render — a claim published from a sibling's
 * effect lands after that sibling's render but before the commit is painted, so
 * a decision taken during render can already be out of date by the time an
 * effect acts on it.
 */
export function isOnboardingViewClaimed(): boolean {
	return claims > 0;
}

/**
 * Publish a claim for as long as `active` holds.
 *
 * Keyed on the boolean and not on whatever produced it, so a surface that
 * changes shape while staying up — the controller moving from its drawer to a
 * tour — never releases and re-claims within one commit. Listeners must not see
 * a spurious close between two surfaces; the controller's original broadcast
 * was careful about that and this preserves it.
 */
export function useOnboardingViewClaim(active: boolean): void {
	useEffect(() => {
		if (!active) {
			return;
		}
		return claimOnboardingView();
	}, [active]);
}

/**
 * Whether an onboarding surface has claimed the view at any point since this
 * component mounted.
 *
 * STICKY, and that is the whole requirement (R23). Two halves:
 *
 *  - A surface that is up when the consumer mounts, or that opens over it
 *    later, suppresses the consumer — nothing renders stacked on onboarding.
 *  - A surface CLOSING does not un-suppress it. Finishing a tour must not make
 *    a banner pop in under the reader who just dismissed something else; the
 *    consumer becomes eligible again at its next mount, which for the project
 *    page means the next time the reader arrives there.
 *
 * Reads the ledger synchronously for its initial value and again inside the
 * effect, so a claim landing between the first render and the subscription is
 * not missed.
 */
export function useOnboardingViewClaimedSinceMount(): boolean {
	const [claimed, setClaimed] = useState(isOnboardingViewClaimed);

	useEffect(() => {
		if (claimed) {
			return;
		}
		if (isOnboardingViewClaimed()) {
			setClaimed(true);
			return;
		}
		const onSurface = (event: Event) => {
			if ((event as CustomEvent<SurfaceEventDetail>).detail?.open) {
				setClaimed(true);
			}
		};
		window.addEventListener(GET_STARTED_SURFACE_EVENT, onSurface);
		return () =>
			window.removeEventListener(GET_STARTED_SURFACE_EVENT, onSurface);
	}, [claimed]);

	return claimed;
}
