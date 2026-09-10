"use client";

import { MISSING_ORGANIZATION_CONTEXT_ERROR_CODE } from "@repo/api/lib/missing-organization-context";
import { useSession } from "@saas/auth/hooks/use-session";
import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { useConfirmationAlert } from "@saas/shared/components/ConfirmationAlertProvider";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation } from "@tanstack/react-query";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";
import { canDeletePrompt } from "../lib/delete-authority";
import {
	formatPlainPromptDeletionConfirmation,
	formatPromptDeletionOutcome,
	formatSystemPromptDeletionConfirmation,
	PROMPT_DELETION_RELOAD_ACTION_LABEL,
	PROMPT_IMPACT_PENDING_ANNOUNCEMENT,
	type PromptDeletionFigures,
} from "../lib/deletion-impact-message";

/**
 * Deleting a prompt from a listing surface — the whole flow, once (Fizzy #2328).
 *
 * Three surfaces render a prompt's overflow menu, and before this each decided
 * for itself who may delete (`prompt.scope !== "SYSTEM"`, the same line three
 * times) and how to confirm (two through the shared dialog, one through the
 * browser's native `confirm()`). That is sediment, not three deliberate rules —
 * `docs/solutions/conventions/the-nth-special-case-means-generalize.md` — so
 * the decision, the pre-flight impact, the confirmation and the completion
 * report all live here and the surfaces only render.
 *
 * What the hook owns, and why each piece is here rather than at a call site:
 *
 *  - **Who is offered Delete** — `canDeletePrompt`, the shared predicate, asked
 *    with the viewer this hook reads from the session and the active
 *    organization. A surface cannot get the viewer wrong because it never
 *    assembles one (R1, R4).
 *  - **The impact, for SYSTEM prompts only.** An ORG or USER prompt cannot be
 *    bound outside the tenant already looking at it, so there is nothing
 *    cross-tenant to warn about and the endpoint is not called at all.
 *  - **The pending state's home.** The menu closes on the click and the dialog
 *    opens only once the sentence is ready, so the wait belongs to the control
 *    that was clicked: the overflow trigger goes disabled and `aria-busy`, and
 *    a polite live region says what is happening for anyone not watching it
 *    (KTD6).
 *  - **The completion report.** Built from what the deletion RETURNED, not from
 *    the snapshot the dialog showed — a binding created while the operator read
 *    the dialog is removed by the deletion and has to appear in the account of
 *    it (R15).
 *  - **The one recovery a confirmation offers, and who it is offered to.** An
 *    impact read refused because the request resolved no workspace means the
 *    deletion behind the dialog will be refused too while that holds, so the
 *    dialog says so and carries a reload beside Delete — the action that heals
 *    the session (R15). Who it helps is gated on the same membership test
 *    `ActiveOrganizationProvider` gates its own alignment on (see its
 *    `findViewerMembership` guard). Delete is still offered either way,
 *    because taking it away is the dead end this flow exists to avoid (R10).
 *  - **Which Delete the one dialog belongs to.** The impact read is
 *    asynchronous and the confirmation is an app-wide singleton, so the flow
 *    tracks whose answer it is still waiting for and bounds how long it waits.
 *    Both live below the imports, next to the reasons.
 *
 * The predicate is an affordance, never a boundary: the server still enforces
 * every deletion (KTD2).
 */

/**
 * How long the platform-wide impact read gets before the flow stops waiting for
 * it.
 *
 * Nothing bounded that wait before, and the busy state it drives has no other
 * way out: a request that never settles leaves the overflow trigger `disabled`
 * and `aria-busy` for as long as the page is open, so the operator can neither
 * delete the prompt nor stop trying to. Ten seconds is well past a healthy
 * round trip for a counting query and well short of the point where a person
 * concludes the control is broken.
 *
 * A timeout lands on `unknown`, never on the workspace reason: this request
 * never came back, so it said nothing about why. It is the one failure that
 * can never be attributed to a cause.
 */
const IMPACT_READ_TIMEOUT_MS = 10_000;

/**
 * Which Delete the confirmation dialog currently belongs to.
 *
 * `ConfirmationAlertProvider` holds ONE `confirmOptions` state for the whole
 * app and `confirm()` replaces it wholesale — no id, no handle, no way to ask
 * whether a dialog is already open. So a late impact fetch calling `confirm()`
 * again does not stack a second dialog: it rewrites the open one's message AND
 * its `onConfirm` under the same title and the same Delete button.
 *
 * The two Deletes racing are two different rows, so two different instances of
 * this hook, both mounted — which is why the mounted ref cannot see it. One
 * module-scoped token answers it for all of them, and a module scope is the
 * right scope precisely because there is only ever one dialog to own: choosing
 * Delete anywhere claims it, and a fetch that resolves after someone else has
 * claimed it is no longer the operator's current intent.
 *
 * A superseded request is dropped SILENTLY. The operator has moved on to
 * another row and is reading its confirmation; a toast about the prompt they
 * abandoned would compete with it for exactly the attention that dialog needs.
 * The abandoned row simply stops being busy, and clicking Delete again asks
 * afresh.
 */
let latestDeletionIntent = 0;

function claimDeletionIntent(): number {
	latestDeletionIntent += 1;
	return latestDeletionIntent;
}

function isCurrentDeletionIntent(intent: number): boolean {
	return intent === latestDeletionIntent;
}

/**
 * Why the platform-wide impact is not there.
 *
 * A reason, never a sentence — `deletion-impact-message.ts` owns every word the
 * operator reads, and this module only says which situation it is in.
 *
 *  - `missing-workspace` — the server refused the read because the request
 *    resolved no workspace, which it says with the shared marker every refusing
 *    site carries (R8). The deletion behind the confirmation would be refused
 *    for the very same reason, so this is not a check that failed to answer:
 *    it is an answer.
 *  - `unknown` — everything else (R9). A read that ran out of time, one that was
 *    aborted, a transport that died: none of them reached the server's reason,
 *    so none of them may claim one. This is deliberately the fallback for an
 *    unrecognised refusal too, so a marker this build has never heard of is
 *    reported as not knowing rather than as the one cause it can name.
 */
export type PromptImpactUnavailableReason = "missing-workspace" | "unknown";

/**
 * What the impact read hands back: the figures, or the reason there are none.
 *
 * Both members carry both fields, so a caller reads `figures` and
 * `unavailableReason` without narrowing first, while the union still states the
 * invariant that matters — figures and a reason never arrive together, and an
 * absent impact always says why it is absent.
 */
export type PromptDeletionImpactRead =
	| { figures: PromptDeletionFigures; unavailableReason: null }
	| { figures: null; unavailableReason: PromptImpactUnavailableReason };

/**
 * Which failure this is, read from the refusal's structured marker.
 *
 * Never from the message: the sentence is prose that improves over time and a
 * client matching on it breaks the moment it does — which is the whole reason
 * the refusing sites carry `MISSING_ORGANIZATION_CONTEXT_ERROR_CODE` in the
 * error's `data`. Optional-chained the whole way down because this is handed
 * every kind of thrown thing, most of which have no `data` at all.
 */
function classifyImpactReadFailure(
	error: unknown,
): PromptImpactUnavailableReason {
	const errorCode = (error as { data?: { errorCode?: unknown } } | null)?.data
		?.errorCode;

	return errorCode === MISSING_ORGANIZATION_CONTEXT_ERROR_CODE
		? "missing-workspace"
		: "unknown";
}

/**
 * The platform-wide impact, or the named reason there is none.
 *
 * Never rejects. Every way this can fail still lands here rather than at the
 * call site — a refusal, a network error, a request that hangs — but they stop
 * being the SAME thing on the way out. One of them, the refusal that says the
 * caller's request resolved no workspace, is a fact about the deletion itself
 * and not about the check; the rest are only the absence of an answer.
 *
 * The two failure arms are threaded separately on purpose. The timeout settles
 * through the race below and never reaches the `catch`, so a reason derived
 * only there would leave the commonest failure unclassified — and unclassified
 * would have to mean the cause this function exists to name.
 *
 * Exported so both arms can be exercised directly. The reason is a
 * classification and nothing rendered shows it on its own, so a test that could
 * only reach it through the confirmation's wording would be testing the
 * formatter instead of this.
 */
export async function readDeletionImpact(
	id: string,
): Promise<PromptDeletionImpactRead> {
	const controller = new AbortController();
	let expiry: ReturnType<typeof setTimeout> | undefined;

	const timedOut = new Promise<PromptDeletionImpactRead>((resolve) => {
		expiry = setTimeout(() => {
			// Abort so a request still in flight stops holding a connection
			// and the server stops counting for an answer nobody waits for...
			controller.abort();
			// ...and settle here rather than waiting for that abort to come
			// back as a rejection. The busy state must end even if the
			// transport ignores the signal, which is the case this bound
			// exists for.
			//
			// `unknown`, never the workspace reason — no answer came back, so
			// this request said nothing about why.
			resolve({ figures: null, unavailableReason: "unknown" });
		}, IMPACT_READ_TIMEOUT_MS);
	});

	try {
		return await Promise.race([
			orpcClient.prompts
				.deletionImpact({ id }, { signal: controller.signal })
				.then(
					(figures): PromptDeletionImpactRead =>
						figures
							? { figures, unavailableReason: null }
							: // A response that carried nothing is not zero
								// impact, it is no impact read at all.
								{ figures: null, unavailableReason: "unknown" },
				),
			timedOut,
		]);
	} catch (error) {
		// Still swallowed rather than rethrown — reporting the fetch's own
		// error here would turn a warning that failed into a deletion that was
		// blocked. What changes is that the refusal's own cause survives the
		// swallowing, so the confirmation can name it instead of describing
		// every failure as an impact it could not determine.
		return {
			figures: null,
			unavailableReason: classifyImpactReadFailure(error),
		};
	} finally {
		clearTimeout(expiry);
	}
}

/**
 * What to tell the operator about a deletion the server refused (R5).
 *
 * The impact read runs for SYSTEM prompts only, so for a prompt at any other
 * scope this toast is the ONLY surface where the cause can ever be named — the
 * confirmation for those prompts never asked the server anything. That is why
 * the same marker is read again here rather than passed down from the
 * pre-confirmation read: the deletion's refusal is its own channel, and it is
 * the only one an ORG or USER deletion has.
 *
 * The workspace arm reports the request, not the deletion. "Failed to delete
 * prompt" with the server's sentence beneath it says the deletion is what went
 * wrong and leaves the operator to conclude they lack the authority for it;
 * what actually happened is that the request resolved no workspace to act in,
 * and the deletion was refused before it touched anything.
 *
 * Every other refusal keeps the server's own message, which is the existing
 * deliberate rule (R10): "you are not authorised", "already deleted" and "took
 * too long and nothing was removed" are three different next steps, and any of
 * them beats an unattributed failure.
 */
function describeDeletionFailure(error: unknown): {
	title: string;
	description: string;
} {
	// The same classifier the impact read uses — one marker, so one reader.
	if (classifyImpactReadFailure(error) === "missing-workspace") {
		return {
			title: "No workspace for this request",
			// "workspace", never "organization" — the vocabulary rule on
			// `MISSING_ORGANIZATION_CONTEXT_ERROR_CODE` in
			// `missing-organization-context.ts`.
			description:
				"The deletion was refused because this request had no workspace to act in. Nothing was deleted.",
		};
	}

	return {
		title: "Failed to delete prompt",
		description: error instanceof Error ? error.message : String(error),
	};
}

/**
 * The recovery offered beside Delete when the request resolved no workspace
 * (R15).
 *
 * A full reload, not a router refresh: what has to run again is the session's
 * workspace alignment, which happens as the app boots. Reproducing the failure
 * on staging showed the session heals the moment the page loads again, so this
 * is the whole fix from the operator's side — nobody is asked to sign out and
 * back in for a pointer the app can restore by itself.
 *
 * "Heals" is conditional on the membership gate the call site checks before
 * offering this (see `viewerHoldsWorkspaceMembership`).
 *
 * Module-scoped so the option handed to the dialog is a stable reference,
 * following `DocumentEditorAiUnavailable`'s `reloadPage`.
 */
function reloadPage() {
	window.location.reload();
}

/**
 * `ConfirmOptions["secondaryAction"]` in `ConfirmationAlertProvider`, restated.
 *
 * That module exports the hook and the provider, not the options type, and this
 * shape is small and settled enough to restate rather than widen a component
 * every destructive action depends on. Structurally assignable, so a change to
 * the option there becomes a type error here.
 */
type ConfirmationSecondaryAction = {
	label: string;
	onSelect: () => void;
};

/** The little a surface must know about a prompt to offer its deletion. */
type DeletablePromptSummary = {
	id: string;
	name: string;
	/** "SYSTEM", "ORG" or "USER" — widened so a surface holding it as plain
	 *  text can ask without a cast. */
	scope: string;
	/**
	 * The owning organization for an ORG prompt; null for SYSTEM and USER.
	 *
	 * Required, not optional. A surface that cannot say who owns the prompt
	 * cannot be told it may be deleted — and silently defaulting it to null
	 * would withhold Delete on USER prompts that offer it today, which is a
	 * regression no test would see. Make it a type error at the call site.
	 */
	organizationId: string | null;
	/** The owning user for a USER prompt; null for SYSTEM and ORG. */
	userId: string | null;
};

type PromptDeletion = {
	/** Whether to render the Delete item at all (R1, R2, R4). */
	canDelete: boolean;
	/** True from the moment Delete is chosen until the dialog opens. */
	isPreparing: boolean;
	/** Chosen Delete. Fetches the impact when it applies, then confirms. */
	requestDelete: () => void;
	/**
	 * Spread onto the surface's overflow trigger. Carries the accessible name
	 * the icon-only control lacked (R13, WCAG 2.1 AA) and the busy state.
	 */
	triggerProps: {
		"aria-label": string;
		"aria-busy": boolean;
		disabled: boolean;
	};
	/** Render next to the trigger — the polite live region for the wait. */
	announcement: ReactNode;
};

export function usePromptDeletion({
	prompt,
	onDeleted,
}: {
	prompt: DeletablePromptSummary;
	onDeleted?: () => void;
}): PromptDeletion {
	const { confirm } = useConfirmationAlert();
	const { user } = useSession();
	const { organizationId, userRole } = useOrganizationContext();
	const [isPreparing, setIsPreparing] = useState(false);

	// Whether reloading could restore this viewer's workspace at all — the
	// same membership test `ActiveOrganizationProvider`'s alignment effect
	// gates itself on (see its `findViewerMembership` guard), read here as
	// `userRole`.
	//
	// A role, not a permission: an ordinary member is aligned by that effect
	// just as an admin is. This decides whether the workspace can come back,
	// never who may delete — `canDeletePrompt` above owns that.
	const viewerHoldsWorkspaceMembership = userRole !== null;

	// The impact fetch outlives the row that started it: changing a filter or a
	// search term while it is in flight unmounts the surface. Without this the
	// resolution would still call setState on a gone component.
	const isMounted = useRef(true);
	useEffect(() => {
		isMounted.current = true;
		return () => {
			isMounted.current = false;
		};
	}, []);

	const canDelete = canDeletePrompt({
		prompt: {
			scope: prompt.scope,
			organizationId: prompt.organizationId,
			userId: prompt.userId,
		},
		viewer: {
			userId: user?.id,
			// The same global-role read as the prompt detail page.
			globalRole: user?.role,
			organizationId,
			// `activeOrganizationUserRole`, NOT `isOrganizationAdmin` — that
			// helper is true for any global admin regardless of membership,
			// which would offer Delete on a click the server refuses.
			organizationRole: userRole,
		},
	});

	const deleteMutation = useMutation({
		mutationFn: async () => {
			return await orpcClient.prompts.delete({ id: prompt.id });
		},
		onSuccess: (result) => {
			toast.success("Prompt deleted successfully", {
				description: formatPromptDeletionOutcome(result),
			});
			onDeleted?.();
		},
		onError: (error) => {
			// Named cause where there is one to name, and the server's own
			// reason for everything else — never an unattributed failure.
			const { title, description } = describeDeletionFailure(error);
			toast.error(title, { description });
		},
	});

	const confirmDeletion = useCallback(
		(message: string, secondaryAction?: ConfirmationSecondaryAction) => {
			confirm({
				title: "Delete Prompt",
				message,
				confirmLabel: "Delete",
				cancelLabel: "Cancel",
				destructive: true,
				onConfirm: () => deleteMutation.mutate(),
				// Absent for every confirmation but one. The dialog renders the
				// third action only when it is given one, and gives it focus
				// when it is — which is why it is passed for a cause with a
				// known recovery and never as a general-purpose escape hatch.
				secondaryAction,
			});
		},
		[confirm, deleteMutation],
	);

	const requestDelete = useCallback(() => {
		// Claim the dialog before anything asynchronous can happen — on the
		// immediate path too, so a fetch started a moment ago on another row
		// cannot come back and rewrite the confirmation opened here.
		const intent = claimDeletionIntent();

		if (prompt.scope !== "SYSTEM") {
			confirmDeletion(formatPlainPromptDeletionConfirmation(prompt.name));
			return;
		}

		setIsPreparing(true);

		void (async () => {
			const impact = await readDeletionImpact(prompt.id);

			if (!isMounted.current) {
				return;
			}

			// The wait is over for this row whether or not its answer is still
			// wanted. Clearing this before the staleness check is deliberate:
			// a trigger left disabled and busy is the one outcome the operator
			// cannot recover from.
			setIsPreparing(false);

			// Somebody chose Delete again — on this row or another one — while
			// this was in flight. Confirming now would replace the message and
			// the confirm handler of the dialog they are reading, so they would
			// read about one prompt and delete another.
			if (!isCurrentDeletionIntent(intent)) {
				return;
			}

			// Only the workspace cause gets a recovery, and only for a viewer
			// it would work for. Reloading cannot help a check that timed out
			// or a transport that died, and it cannot help someone whose
			// session alignment is skipped for want of a membership; offering
			// it in either case would dress a guess up as a remedy — the
			// operator takes it, waits, and lands back on the same dialog.
			//
			// ONE value decides the sentence's clause and the button together,
			// so the dialog cannot end up promising a recovery it does not
			// carry, or carrying one it does not explain.
			const reloadRestoresWorkspace =
				impact.unavailableReason === "missing-workspace" &&
				viewerHoldsWorkspaceMembership;

			confirmDeletion(
				formatSystemPromptDeletionConfirmation({
					name: prompt.name,
					figures: impact.figures,
					unavailableReason: impact.unavailableReason,
					reloadRestoresWorkspace,
				}),
				reloadRestoresWorkspace
					? {
							label: PROMPT_DELETION_RELOAD_ACTION_LABEL,
							onSelect: reloadPage,
						}
					: undefined,
			);
		})();
	}, [
		confirmDeletion,
		prompt.id,
		prompt.name,
		prompt.scope,
		viewerHoldsWorkspaceMembership,
	]);

	return {
		canDelete,
		isPreparing,
		requestDelete,
		triggerProps: {
			"aria-label": `Actions for ${prompt.name}`,
			"aria-busy": isPreparing,
			disabled: isPreparing,
		},
		// `<output>` rather than a span with role="status": it carries that
		// role and a polite live region implicitly, and it is the element the
		// repo's own lint rule asks for.
		announcement: (
			<output className="sr-only">
				{isPreparing ? PROMPT_IMPACT_PENDING_ANNOUNCEMENT : ""}
			</output>
		),
	};
}
