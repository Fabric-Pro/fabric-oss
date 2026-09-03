"use client";

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
 * Timing out is NOT a failure of the deletion — it lands on exactly the path a
 * rejected fetch already took: the impact is reported as unknown, and the
 * confirmation still offers to continue (R7).
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
 * The platform-wide impact, or `null` when it could not be read within
 * `IMPACT_READ_TIMEOUT_MS`.
 *
 * Never rejects. Every way this can fail — a refusal, a network error, a
 * request that hangs — is the same thing to the caller: the impact is unknown,
 * which the confirmation says in as many words rather than reporting an absence
 * it did not verify.
 */
async function readDeletionImpact(
	id: string,
): Promise<PromptDeletionFigures | null> {
	const controller = new AbortController();
	let expiry: ReturnType<typeof setTimeout> | undefined;

	const timedOut = new Promise<null>((resolve) => {
		expiry = setTimeout(() => {
			// Abort so a request still in flight stops holding a connection
			// and the server stops counting for an answer nobody waits for...
			controller.abort();
			// ...and settle here rather than waiting for that abort to come
			// back as a rejection. The busy state must end even if the
			// transport ignores the signal, which is the case this bound
			// exists for.
			resolve(null);
		}, IMPACT_READ_TIMEOUT_MS);
	});

	try {
		return await Promise.race([
			orpcClient.prompts.deletionImpact(
				{ id },
				{ signal: controller.signal },
			),
			timedOut,
		]);
	} catch {
		// Deliberately swallowed into "unknown". The confirmation says the
		// impact could not be determined and still offers to continue;
		// reporting the fetch's own error here would turn a warning that
		// failed into a deletion that was blocked.
		return null;
	} finally {
		clearTimeout(expiry);
	}
}

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
			// The server's own reason, never an unattributed failure (R10) —
			// "you are not authorised", "already deleted", "took too long and
			// nothing was removed" are three different next steps.
			toast.error("Failed to delete prompt", {
				description:
					error instanceof Error ? error.message : String(error),
			});
		},
	});

	const confirmDeletion = useCallback(
		(message: string) => {
			confirm({
				title: "Delete Prompt",
				message,
				confirmLabel: "Delete",
				cancelLabel: "Cancel",
				destructive: true,
				onConfirm: () => deleteMutation.mutate(),
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
			const figures = await readDeletionImpact(prompt.id);

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

			confirmDeletion(
				formatSystemPromptDeletionConfirmation({
					name: prompt.name,
					figures,
				}),
			);
		})();
	}, [confirmDeletion, prompt.id, prompt.name, prompt.scope]);

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
