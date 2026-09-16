"use client";

import { useAnalytics } from "@analytics";
import { useSession } from "@saas/auth/hooks/use-session";
import {
	isOnboardingViewClaimed,
	useOnboardingViewClaimedSinceMount,
} from "@saas/get-started/lib/onboarding-claim";
import { useProjectReadiness } from "@saas/projects/components/readiness/ProjectReadinessProvider";
import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Alert, AlertDescription, AlertTitle } from "@ui/components/alert";
import { Button } from "@ui/components/button";
import { cn } from "@ui/lib";
import { TerminalIcon, UsersIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ConnectCliDialog } from "./ConnectCliDialog";
import {
	CLI_NUDGE_ASK_OPENED_EVENT,
	CLI_NUDGE_ASK_SENT_EVENT,
	CLI_NUDGE_KEY_ISSUED_EVENT,
	CLI_NUDGE_OPENED_EVENT,
	CLI_NUDGE_RENDERED_EVENT,
	shouldOfferCliConnectionAsk,
	shouldShowCliConnectionNudge,
} from "./lib/cli-connection-nudge";
import { RequestCliConnectionDialog } from "./RequestCliConnectionDialog";

/* -------------------------------------------------------------------------- */
/* Copy                                                                        */
/*                                                                             */
/* Hoisted out of the JSX so the wording that needs product sign-off is         */
/* reviewable in one place, the same treatment `ConnectCliDialog` and           */
/* `AnthropicCapabilityBanner` give theirs.                                     */
/* -------------------------------------------------------------------------- */

/**
 * States the fact R3 asks the prompt to explain, and blames nobody for it.
 *
 * USE, not setup. The evidence underneath is `OrganizationCliReach`, a record
 * the MCP runtime writes when a credential carries a request into Fabric over
 * MCP — it is a record of somebody using the product, and there is no other way
 * for a row to appear. Not of somebody using a CLI: the runtime stores no
 * client identity, so the record cannot tell one apart from a desktop assistant
 * or a script. "Nothing is connected" was a claim about configuration that this
 * surface cannot see: a key can exist, a configuration block can be pasted, and
 * none of it writes a row until a tool asks Fabric for something.
 *
 * Note what it does NOT say. No "actively", no "regularly", no "properly" —
 * `lastReachedAt` has no readers, connectivity is derived from credential
 * liveness rather than recency, and nothing decays. A team that reached Fabric
 * once a year ago still reads as connected and would never see this prompt, so
 * any word implying intensity or recency would be a claim about data this
 * product does not keep.
 *
 * And PRESENT tense, which an earlier draft got wrong. "Nobody HAS USED" is a
 * claim about history, and the signal underneath is not historical: a Reach
 * record stops counting when its credential is revoked, expires, or its owner
 * leaves, so an organization that connected and then let a 90-day key lapse
 * — the default this feature's own dialog issues — flips back to false while
 * having plainly used MCP. The permanent record of that first use exists, in
 * `OrganizationCliFirstReach`, and nothing reads it. See CONCEPTS.md, which
 * defines a connected organization in the present tense for this reason.
 *
 * Which is also why there is no "yet". "Yet" says first use has not happened,
 * and that is the one thing the paragraph above establishes this cannot see. It
 * survived two rounds of correcting the tense around it, because a single
 * adverb reads as a softener rather than as the claim it is.
 */
const NUDGE_TITLE = "Nobody is using Fabric's MCP";

/**
 * The offer, written for both readers at once (R10).
 *
 * Two audiences arrive at this prompt: the person who will open a terminal
 * themselves, and the person whose team works in one. An earlier draft led with
 * "connect your CLI" and appended the team case as a trailing clause, which
 * reads as an afterthought to exactly the reader most likely to be an
 * organization admin looking at a checklist. One sentence, both paths, same
 * weight.
 *
 * It sends a teammate here to create THEIR OWN key rather than to be handed
 * one. That is not softening: the key authenticates as its holder across the
 * whole organization, which the issuing view says plainly, so copy that
 * implied passing one around would contradict the view it opens.
 *
 * The middle clause is the evidence behind the title, said once and exactly:
 * no live credential in this organization is REACHING Fabric. That is the whole
 * content of `organizationCliConnected === false` — organization-wide, never
 * per-project, with no notion of how long ago or how often, and present tense,
 * because a revoked or expired credential takes its Reach record out of the
 * answer. It is not a claim that nobody ever did.
 *
 * "Reaching", not "connected", and the word matters as much here as in the
 * title. Connection is SETUP, and setup is the one thing this surface cannot
 * see: a key can exist and a configuration block can be pasted with no Reach
 * record ever appearing. An earlier draft said "nothing is connected" and
 * contradicted the paragraph above it — which is how a guard on the heading
 * alone let an overclaim through in the body.
 */
const NUDGE_BODY =
	"This project has enough context to be worth reading from outside the app, but nothing in this organization is reaching Fabric over MCP to read it. It takes a key and a single configuration block — set yours up now, or send whoever on your team works in a CLI here to set up theirs.";

/**
 * What dismissing costs, and where the option survives it (R28).
 *
 * Load-bearing, not boilerplate. The dismissal is organization-wide and
 * permanent, and the reader clicking the X is usually just tidying their
 * screen. Someone who loses an affordance forever because they closed a banner
 * has been tricked by the interface; saying so, and naming the row that keeps
 * it reachable, is what makes a permanent dismissal defensible at all.
 *
 * The row is named exactly as the checklist labels it, so the sentence is a
 * findable instruction rather than a description.
 */
const NUDGE_DISMISS_NOTE =
	'Dismissing this is permanent — it will not come back for you on any project in this organization. The "Organization connected over MCP" row in this project\'s readiness checklist is where the option stays.';

/** Matches the checklist row's own action, so the two read as one affordance. */
const NUDGE_CONNECT_LABEL = "Connect CLI";

/**
 * The second offer, for the reader whose answer to "set yours up now" is no.
 *
 * The body addresses two people and, until now, only one of them had a control:
 * the reader who will open a terminal. This is the other one's — and it is the
 * likelier reader of the two on a readiness checklist, which is why it sits
 * beside the first rather than behind it.
 */
const NUDGE_ASK_LABEL = "Ask a teammate";

/** The icon-only control's accessible name (R31, WCAG 2.1 AA). */
const NUDGE_DISMISS_LABEL = "Dismiss the CLI connection prompt";

/** Names the region for assistive technology, as the sibling banners do. */
const NUDGE_REGION_LABEL = "CLI connection prompt";

interface CliConnectionNudgeProps {
	/**
	 * The organization HOSTING the project on screen, passed explicitly and
	 * never read from the session's active organization — that pointer can
	 * legitimately name a different tenant than the project being viewed, and
	 * minting a key against it would issue one nobody asked for.
	 *
	 * Nullable because the caller's own context can be unresolved. With none,
	 * there is nothing to mint against and the issuing view is not mounted.
	 */
	organizationId: string | null;
	/** That organization's slug, used only to link its API keys settings. */
	organizationSlug?: string;
	/**
	 * Named in the issuing view's starter instruction.
	 *
	 * Passed down rather than fetched: the project page already holds the
	 * project, and a prompt that renders on every qualifying project view must
	 * not add a read to get a string its parent is already holding.
	 */
	projectName: string;
	/**
	 * Hide the prompt visually while keeping it mounted (Fizzy #2457).
	 *
	 * For a caller that hides page chrome without navigating — Focus Mode on
	 * the Atlas tab is the one today. Unmounting the prompt for that would
	 * reset the per-mount onboarding-yield latch and re-fire the render event,
	 * counting one impression twice for a single project visit, so the caller
	 * passes this instead of wrapping the element in its own condition.
	 *
	 * It is presentation, not suppression: nothing about it is remembered, the
	 * prompt comes back exactly as it was when chrome returns, and while it is
	 * hidden no impression is recorded — a prompt nobody can see was not shown.
	 */
	hidden?: boolean;
}

/**
 * The CLI-connection prompt (Fizzy #2457, R3 / R5 / R6 / R7 / R23 / R25 / R28).
 *
 * Tells a project team, at the point the project has enough context for it to
 * matter, that nothing in their organization is reading Fabric from a coding
 * tool — and offers to fix that in the same view.
 *
 * **It issues one query, and only while it is on screen.** The project roster
 * is read to answer a single question the readiness payload does not carry:
 * whether there is anybody here to ask. The read is enabled by the prompt's own
 * visibility, so a project view that shows no prompt costs nothing, and its
 * cache entry is the one the ask picker then opens on. Everything ELSE it needs
 * is on the readiness payload already mounted over every project route,
 * resolved server-side:
 * `promptEligible` folds in the rollout gate, the resolved checklist item, the
 * project's status, the two-of-eight context threshold, this viewer's
 * key-creation permission and their dismissal. There is no client-side
 * permission hook in this codebase, so re-deriving any of that here would be a
 * second, drifting answer to a question the procedure already answered.
 *
 * **Three pieces of state, deliberately separate** — the discipline the project
 * role-confirmation prompt documents and paid for:
 *
 *  - ELIGIBILITY is not state at all. It is read from the readiness context on
 *    every render, so a refetch that changes the answer is obeyed immediately.
 *  - SESSION SUPPRESSION is `dismissed` (this viewer clicked X), the readiness
 *    context's `cliKeyIssued` (this viewer just minted one, from HERE or from
 *    the checklist row that offers the same thing) and the sticky onboarding
 *    claim (something else owned the view). None is derived from eligibility,
 *    and none is written by the effect that reads visibility.
 *  - VISIBILITY is derived from all of them by the pure rule beside this file,
 *    and is held nowhere.
 *
 * Nothing derives an open state from a flag the same effect sets: both dialogs'
 * `open` is set by a click and by nothing else, and the render-event latch is a
 * ref that no rendering decision reads.
 */
export function CliConnectionNudge({
	organizationId,
	organizationSlug,
	projectName,
	hidden = false,
}: CliConnectionNudgeProps) {
	const readiness = useProjectReadiness();
	// Sticky since mount: a surface closing does not un-suppress this prompt,
	// so finishing a tour never makes a banner pop in under the reader. It
	// becomes eligible again on the next mount of the project view.
	const onboardingClaimed = useOnboardingViewClaimedSinceMount();
	const [dismissed, setDismissed] = useState(false);
	/**
	 * "I have just done this" — read from the readiness context, not held here.
	 *
	 * The server will go on reporting the prompt eligible after a key is issued
	 * (the checklist item behind it completes on something REACHING Fabric over
	 * MCP, not on a key existing), so something on the client has to stand the
	 * prompt down. It cannot be state local to this component: the checklist's
	 * "API Key for CLI" row mounts its OWN issuing view and offers the same
	 * key, and a viewer who minted one from there was left looking at a banner
	 * telling them nothing had reached Fabric over MCP. One fact, one owner,
	 * both surfaces — per project view and not persisted, exactly as a local
	 * flag was.
	 */
	const keyIssued = readiness?.cliKeyIssued === true;
	const [issuingViewOpen, setIssuingViewOpen] = useState(false);
	const [askViewOpen, setAskViewOpen] = useState(false);
	const { trackEvent } = useAnalytics();
	const { user } = useSession();

	// The project readiness is about. Read from the context rather than taken
	// as a prop, so the id this dismisses for and the payload this reads can
	// never be two different projects.
	const projectId = readiness?.projectId ?? "";

	const dismiss = useMutation({
		mutationFn: () =>
			orpcClient.projects.readiness.dismissCliNudge({
				projectId,
				organizationId,
			}),
		onError: (error) => {
			// Deliberately silent to the reader. They asked for this surface to
			// go away and it has; re-raising it to report that the preference
			// did not persist would be answering "hide this" with another
			// banner. The local flag holds for this session and the next
			// readiness read decides afresh — the failure costs one more
			// showing, not a wrong state.
			//
			// Never render a raw server message: this repo is public and such a
			// string can carry an internal detail that has no business in UI.
			console.error("Failed to dismiss the CLI connection prompt", error);
		},
	});

	const visible = shouldShowCliConnectionNudge({
		cliConnection: readiness?.data?.cliConnection,
		onboardingClaimed,
		dismissed,
		keyIssued,
	});

	/**
	 * Is there anybody here to ask?
	 *
	 * The readiness payload cannot answer this — it resolves the viewer's own
	 * position, not the roster — so it is the one thing this prompt reads for
	 * itself. Enabled by the prompt's visibility and by `hidden`, so it costs
	 * nothing on the project views that show no prompt, and the ask picker
	 * mounts onto this same cache entry rather than issuing a second read.
	 *
	 * PROJECT members, not organization members, and that is not a shortcut: a
	 * function tag is held per project in this data model and the handler
	 * expands tags strictly within this roster, so one count gates both routes
	 * into the picker truthfully.
	 */
	const membersQuery = useQuery({
		...orpc.projects.members.list.queryOptions({
			input: { projectId, organizationId },
		}),
		enabled: visible && !hidden && projectId !== "",
	});

	/**
	 * The viewer is dropped here for the same reason the picker and the handler
	 * drop them: asking yourself to do the thing you are looking at is nothing.
	 * A count of the whole roster would offer the control to somebody alone on
	 * their project and open an empty picker.
	 */
	const askableTeammateCount = (membersQuery.data?.members ?? []).filter(
		(member) => member.userId !== user?.id,
	).length;

	const offerAsk = shouldOfferCliConnectionAsk({
		promptVisible: visible,
		askableTeammateCount,
	});

	/**
	 * The render event (R25), emitted HERE — after the yield rule and every
	 * other suppression have decided the prompt is on screen.
	 *
	 * Not where eligibility is computed: that resolves true on every readiness
	 * read, and on surfaces that then yield and never render, so counting it
	 * there would overcount impressions past the point of usefulness. The
	 * server's own handler says as much where it builds the block.
	 *
	 * A ref rather than state, and never reset: readiness refetches after ANY
	 * successful mutation on the page and polls while an item is in progress,
	 * so the same eligibility re-resolves repeatedly. Each of those is the same
	 * impression, and this fires at most once per mount of the prompt.
	 *
	 * `trackEvent` is a fresh identity each render, so this effect re-runs
	 * often; the latch makes every re-run past the first a no-op, which is
	 * cheaper than the ref dance needed to keep it out of the dependency list.
	 *
	 * The ledger is re-read here rather than trusted from `visible`, and that is
	 * not belt-and-braces. `onboardingClaimed` is state seeded during render; a
	 * surface mounting in the SAME commit publishes its claim from an effect,
	 * which runs after this component rendered and can run before this effect.
	 * In that window `visible` is a true value that is already stale, the prompt
	 * is replaced before it is ever seen, and an impression would be counted for
	 * a prompt that yielded — precisely the overcount R25 moved this event here
	 * to avoid.
	 *
	 * `hidden` is in the same guard for the same reason: the caller hiding page
	 * chrome leaves this mounted precisely so the latch survives, and a prompt
	 * painted out of the page was not seen. If chrome comes back the effect runs
	 * again and records the first impression then.
	 */
	const renderedRef = useRef(false);
	useEffect(() => {
		if (
			hidden ||
			!visible ||
			renderedRef.current ||
			isOnboardingViewClaimed()
		) {
			return;
		}
		renderedRef.current = true;
		trackEvent(CLI_NUDGE_RENDERED_EVENT, { projectId });
	}, [hidden, visible, projectId, trackEvent]);

	const openIssuingView = () => {
		trackEvent(CLI_NUDGE_OPENED_EVENT, { projectId });
		setIssuingViewOpen(true);
	};

	const openAskView = () => {
		trackEvent(CLI_NUDGE_ASK_OPENED_EVENT, { projectId });
		setAskViewOpen(true);
	};

	const handleDismiss = () => {
		// Optimistic, and it stays optimistic on failure — see `onError`. The
		// surface disappears on the click rather than a round trip later, and
		// because it disappears, the control cannot be pressed a second time.
		setDismissed(true);
		dismiss.mutate();
	};

	return (
		<>
			{visible && (
				/* Warm neutral surface rather than an alert palette: this is an
				   offer, not a fault. Nothing is broken, nothing is late, and
				   painting it in the highlight or destructive tokens the sibling
				   banners use would put a project that is doing fine in a column
				   of things that are not.

				   Hidden with the attribute AND the utility class, not with a
				   second condition around the element: the attribute is what takes
				   it out of the accessibility tree and out of the parent's
				   `space-y` rhythm, the class is what keeps it hidden if a display
				   utility is ever added here. The component stays mounted either
				   way, which is the whole point of the prop. `Alert` spreads both
				   onto its own root, so neither needs a wrapper to carry it. */
				<Alert
					aria-label={NUDGE_REGION_LABEL}
					className={cn(
						"flex w-full items-start gap-3 border-border bg-muted/40",
						hidden
							? "hidden"
							: "motion-safe:fade-in motion-safe:animate-in",
					)}
					hidden={hidden}
				>
					<TerminalIcon
						aria-hidden="true"
						className="size-4 shrink-0 text-primary"
					/>
					<div className="min-w-0 flex-1">
						<AlertTitle>{NUDGE_TITLE}</AlertTitle>
						<AlertDescription>
							<p>{NUDGE_BODY}</p>
							<p className="mt-1 text-muted-foreground">
								{NUDGE_DISMISS_NOTE}
							</p>
						</AlertDescription>
					</div>
					<div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
						<Button
							autoLoading={false}
							onClick={openIssuingView}
							size="sm"
							variant="outline"
						>
							{NUDGE_CONNECT_LABEL}
						</Button>
						{/* Rendered only when the roster has answered with
						    somebody other than the viewer. A control that opens
						    an empty picker is worse than no control: it reads as
						    an offer the product then withdraws. Loading and
						    errored both count as "nobody" — see the rule. */}
						{offerAsk && (
							<Button
								autoLoading={false}
								onClick={openAskView}
								size="sm"
								variant="outline"
							>
								<UsersIcon
									aria-hidden="true"
									className="size-4"
								/>
								{NUDGE_ASK_LABEL}
							</Button>
						)}
						<Button
							aria-label={NUDGE_DISMISS_LABEL}
							autoLoading={false}
							className="size-8"
							onClick={handleDismiss}
							size="icon"
							variant="ghost"
						>
							<XIcon aria-hidden="true" className="size-4" />
						</Button>
					</div>
				</Alert>
			)}

			{/* The issuing view, mounted as a SIBLING of the prompt and outside
			    its visibility branch. That placement is load-bearing rather
			    than tidy.

			    While this view is open it holds the only copy of a secret the
			    server stores as a hash: close it and the key is gone for good.
			    Its visibility is therefore not allowed to depend on anything
			    this component does not control, and the prompt's own is exactly
			    that — eligibility is resolved server-side and re-read on every
			    refetch and poll, the onboarding ledger can be claimed by any
			    surface on the page, and `keyIssued` below hides the prompt on
			    the very success this view is reporting. Rendered inside the
			    branch above, any one of those would unmount a view holding an
			    unrecoverable secret. Here its lifetime is this component's.

			    Gated only on an organization, because there is nothing to mint
			    a key against without one. */}
			{/* The ask picker, a SIBLING of the prompt for the same structural
			    reason the issuing view above is one, if not the same stakes.
			    While it is open the roster can refetch to nobody, the readiness
			    read can flip eligibility, and an onboarding surface can claim
			    the view — and a picker unmounted mid-compose would discard a
			    selection the reader made, with no way to tell them why.

			    Not gated on an organization: asking a teammate mints nothing,
			    and the handler resolves every organization it uses from the
			    project itself. */}
			<RequestCliConnectionDialog
				onAsked={() => {
					// The prompt deliberately stays. Asking somebody else is
					// not connecting, nothing has reached Fabric yet, and the
					// reader may still want the key themselves — the surface
					// that would be wrong to keep showing is the one offering
					// to mint a second key, which is a different suppression.
					trackEvent(CLI_NUDGE_ASK_SENT_EVENT, { projectId });
				}}
				onOpenChange={setAskViewOpen}
				open={askViewOpen}
				organizationId={organizationId}
				projectId={projectId}
			/>

			{organizationId && (
				<ConnectCliDialog
					onKeyIssued={() => {
						// Stand the prompt down. Nothing else will: the server
						// goes on reporting it eligible until a coding tool
						// actually reaches Fabric, and re-offering to mint a
						// key to the person holding a fresh one is the bug.
						//
						// Recorded on the shared readiness context rather than
						// here, so the checklist row's identical offer and this
						// one are talking about the same person's key.
						readiness?.markCliKeyIssued();
						// This surface's own leg of the funnel. The checklist
						// row records its own, under its own name.
						trackEvent(CLI_NUDGE_KEY_ISSUED_EVENT, { projectId });
					}}
					onOpenChange={setIssuingViewOpen}
					open={issuingViewOpen}
					organizationId={organizationId}
					organizationSlug={organizationSlug}
					projectName={projectName}
				/>
			)}
		</>
	);
}
