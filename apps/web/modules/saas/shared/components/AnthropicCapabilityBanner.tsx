"use client";

import { useIsGuestInOrg } from "@saas/organizations/hooks/use-is-guest-in-org";
import {
	useContextPath,
	useOrganizationContext,
} from "@saas/organizations/hooks/use-organization-context";
import {
	ANTHROPIC_CAPABILITY_BANNER_DETAIL,
	ANTHROPIC_CAPABILITY_BODY,
	ANTHROPIC_CAPABILITY_TITLE,
	shouldShowAnthropicCapabilityBanner,
} from "@saas/shared/lib/anthropic-capability";
import { useTenantScopeResolved } from "@saas/shared/lib/use-tenant-scope-resolved";
import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";
import { Alert, AlertDescription, AlertTitle } from "@ui/components/alert";
import { Button } from "@ui/components/button";
import { AlertTriangleIcon, SettingsIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { aiConfigStatusQueryKey } from "./AiGatewayWarningBanner";

/**
 * The dismissal state's value for "dismissed outside an organization".
 *
 * The state starts at `null` and personal context has an `organizationId` of
 * `null` too, so without a value of its own the two are indistinguishable: a
 * dismissal there would read as "never dismissed" and the banner would refuse
 * to go away. Deliberately not a shape any organization id can take.
 */
const DISMISSED_IN_PERSONAL_CONTEXT = "__personal__";

/**
 * What a reader who cannot change the organization's configuration is told.
 *
 * Not a control, because there is no action for them here — see the role note
 * in the component docstring.
 */
const ANTHROPIC_CAPABILITY_ADMIN_REMEDY =
	"An organization admin needs to assign an embedding provider for this organization.";

/**
 * What a reader is told when the resolution landed on THEIR OWN default.
 *
 * Role does not decide this. A member who administers nothing can still be the
 * person the resolver reached, because it consults the organization's default
 * and then the caller's own — and then they are the only one who can move it
 * without an admin changing the whole organization's configuration.
 */
const ANTHROPIC_CAPABILITY_OWN_REMEDY =
	"Your own default provider is the one being used here. Assign an embedding provider on your provider settings, or ask an organization admin to set one for everyone.";

/**
 * The notice shown while the caller's embedding path resolves to Anthropic,
 * which serves no embeddings (Fizzy #2289, R6-R10).
 *
 * The card notice in Direct Providers catches the person making the decision;
 * this catches the person who made it days ago and moved on, on whatever page
 * they land on. Both say the same approved sentences, which live in
 * `@saas/shared/lib/anthropic-capability` together with the rule below — the
 * component decides nothing about when it shows.
 *
 * It mirrors the sibling AI-setup reminder deliberately, down to the query key
 * and the token pair, because the two share one column and one urgency
 * ordering. Two things they share, one they only look like they share, and one
 * they do not:
 *
 * 1. A project guest holds no organization membership, so the organization-
 *    scoped status call 403s for them. This component takes no props, so it
 *    reads the guest flag the organization layout seeds during its server
 *    render (R15).
 * 2. It subscribes with `aiConfigStatusQueryKey(organizationId)`, which builds
 *    `["aiConfigStatus", organizationId]`. Neither provider form imports that
 *    helper: both invalidate the hand-typed literal `["aiConfigStatus"]`, and
 *    that clears this banner only because React Query matches invalidation keys
 *    by positional prefix. The coupling is real but unenforced — give the
 *    helper's key a new leading segment, or reorder it, and every form's
 *    invalidation stops reaching this query while still typechecking, leaving
 *    the banner up after the save that fixed it (R9).
 * 3. The role split only LOOKS shared. The sibling offers a non-admin member
 *    their own provider page, and is right to: `resolveTenantProviderConfig`
 *    falls back to the caller's personal rows, so a personal key really does
 *    make chat work. Embeddings have no such fallback —
 *    `getEmbeddingProviderConfig` in organization context queries
 *    `cloudProviderConfig` alone and returns empty rather than consulting the
 *    caller's personal `isEmbeddingProvider` row. A member who followed that
 *    link and configured one would change nothing, and this banner would
 *    correctly refuse to clear. So the member is told who can fix it and given
 *    no control at all (R16). Do not "restore parity" with the sibling here:
 *    the parity is in the copy, not in the code beneath it.
 * 4. What differs outright: dismissal. See the state below.
 */
export function AnthropicCapabilityBanner() {
	const pathname = usePathname();
	const { organizationId, isOrgContext, isOrganizationAdmin } =
		useOrganizationContext();
	// Dismissal lasts the SESSION but is keyed to the TENANT, and both halves
	// are deliberate.
	//
	// Session, not pathname — the one place this departs from the sibling
	// reminder, which records where it was dismissed so it returns on the next
	// page (R10). That banner reports a total outage: every AI action on every
	// page will refuse, so it earns the right to ask again. This one reports a
	// partial and often deliberate state — chat and agents keep working, and a
	// tenant may have chosen Anthropic knowing exactly what it does not serve —
	// so it gets the weaker nag: told once, dismissed once, quiet until the
	// next load.
	//
	// Keyed to the tenant, because the workspace switcher navigates without
	// unmounting this component. A bare boolean therefore carried a dismissal
	// from one organization into the next, hiding a gap the reader has never
	// been told about — in a tenant they may not even administer. Recording
	// WHICH organization it was dismissed for keeps the "told once" intent
	// inside the workspace it was formed in.
	//
	// A set rather than the last one, because switching away and back is
	// ordinary: remembering only the most recent dismissal would re-raise the
	// notice in a workspace the reader had already answered for, which is the
	// same nagging the tenant key was added to stop, one switch removed.
	const [dismissedFor, setDismissedFor] = useState<ReadonlySet<string>>(
		() => new Set(),
	);
	const settingsPath = useContextPath("settings/ai-providers");
	// The reader's OWN provider page. Only ever offered when the resolution
	// landed on their own default — a personal embedding assignment is never
	// consulted for an organization, so pointing anyone else here would send
	// them to a row that cannot change the answer.
	const personalSettingsPath = useContextPath(
		"settings/account/ai-providers",
	);
	// Server-seeded by the organization layout's guest provider, so this is
	// correct on the first render under that layout. The account layout mounts
	// the chrome WITHOUT that provider; the hook then falls back to its own
	// query and answers false while it is pending. So "a guest is never asked
	// about an organization they do not belong to" is guaranteed under the
	// organization layout — which is where a guest is — and is a default, not a
	// guarantee, anywhere else.
	const isGuest = useIsGuestInOrg();
	// The route says whether an organization is expected; the context says
	// whether it arrived. Everything below is tenant-scoped, so both must agree
	// before anything is asked for or shown.
	const tenantScopeResolved = useTenantScopeResolved();

	// IMPORTANT: `organizationId` is passed explicitly (null in personal
	// context) to prevent the session fallback from leaking org data.
	const { data: configStatus } = useQuery({
		queryKey: aiConfigStatusQueryKey(organizationId),
		queryFn: async () => {
			return await orpcClient.aiConfig.resolution.getStatus({
				organizationId,
			});
		},
		enabled: !isGuest && tenantScopeResolved,
	});

	// A guest is never asked about, and never told about, an organization they
	// do not belong to. Guarded here as well as by `enabled` above so that no
	// later edit to the query can turn the missing answer into a rendered one.
	if (isGuest) {
		return null;
	}

	// The URL names an organization that has not been fetched yet, so
	// `organizationId` is null without meaning there is no organization.
	// Everything this banner reads is tenant-scoped: asking in that window
	// would ask about the caller's PERSONAL setup and, for as long as the fetch
	// took, describe it to someone standing inside an organization.
	//
	// Covers the fetch being in flight AND the fetch having failed. That query
	// does not retry, so a failed lookup leaves the slug in the URL with
	// `organizationId` null and the loading flag already false — and the answer
	// cached under the null key is then served immediately and keeps being
	// served, which is worse than the flicker the loading case would have been.
	if (!tenantScopeResolved) {
		return null;
	}

	const isDismissed = dismissedFor.has(
		organizationId ?? DISMISSED_IN_PERSONAL_CONTEXT,
	);

	// The whole rule, including the "we do not know yet" case: an absent
	// payload — loading, errored, or a switch to an organization whose key has
	// no data — is never read as "the embedding path lands on Anthropic".
	if (
		isDismissed ||
		!shouldShowAnthropicCapabilityBanner(configStatus, pathname)
	) {
		return null;
	}

	// Outside an organization there is no admin above the caller, so the
	// configuration is theirs to change.
	const canConfigure = isOrgContext ? isOrganizationAdmin : true;
	// The resolver landed on the reader's own row, so they can move it whatever
	// their role in the organization is. Only meaningful inside one: outside,
	// every row is already theirs and `canConfigure` is true anyway.
	const resolutionIsOwn =
		isOrgContext && configStatus?.resolvedEmbeddingSource === "user";

	return (
		// `sticky` rather than plain flow: a reader arrives at pages already
		// scrolled, and a notice explaining why document search returns nothing
		// is useless sitting off-screen at the top of the document.
		//
		// Spacing belongs on this wrapper, never on the Alert: the Alert owns
		// `p-4`, so `pt-*`/`pb-*` passed through its className would shrink its
		// own padding instead of adding any outer gap. Same rhythm as the
		// sibling banners in this column.
		<div className="sticky top-0 z-10 flex shrink-0 justify-center px-3 pt-3 pb-1 motion-safe:animate-in motion-safe:fade-in">
			{/* Painted in the `--highlight` token pair rather than the
			 * primitive's `warning` variant, which reaches for a raw Tailwind
			 * yellow — the same amber the sibling reminder and the AI Models
			 * page's capability hints use, so the column reads as one system. */}
			<Alert
				aria-label="Anthropic capability notice"
				className="flex w-full max-w-4xl items-start gap-3 border-highlight/40 bg-highlight/5 text-highlight-foreground dark:text-highlight"
			>
				{/* A warning triangle, and the opposite of the card's glyph on
				 * purpose. The card states a permanent vendor fact to someone
				 * choosing a provider, and shows even when nothing is configured
				 * — nothing there is broken, so it takes the calmer icon. This
				 * fires only when document search is actually not working for
				 * this reader right now. That is a break, and it should read as
				 * one. */}
				<AlertTriangleIcon
					className="size-4 shrink-0 text-highlight"
					aria-hidden="true"
				/>
				<div className="min-w-0 flex-1">
					<AlertTitle>{ANTHROPIC_CAPABILITY_TITLE}</AlertTitle>
					<AlertDescription>
						<p>{ANTHROPIC_CAPABILITY_BODY}</p>
						{/* The banner's own second sentence: the reader is
						 * already working, so they need to know which of the
						 * things in front of them still run. */}
						<p className="mt-1">
							{ANTHROPIC_CAPABILITY_BANNER_DETAIL}
						</p>
						{/* Who is addressed depends on WHOSE configuration the
						 * resolver reached, not on the reader's role. When it
						 * reached their own default they can move it themselves;
						 * when it reached the organization's they cannot, and
						 * being pointed at their own provider page would send
						 * them to a row that is never consulted for embeddings
						 * inside an organization. See the role note in the
						 * docstring. */}
						{!canConfigure && (
							<p className="mt-1">
								{resolutionIsOwn
									? ANTHROPIC_CAPABILITY_OWN_REMEDY
									: ANTHROPIC_CAPABILITY_ADMIN_REMEDY}
							</p>
						)}
					</AlertDescription>
				</div>
				<div className="flex shrink-0 items-center gap-2">
					{/* A control only for a reader who has somewhere to go that
					 * would change the answer: an admin to the organization's
					 * settings, or anyone whose OWN default is what resolved to
					 * their own. */}
					{(canConfigure || resolutionIsOwn) && (
						<Button asChild size="sm" variant="outline">
							<Link
								href={
									canConfigure
										? settingsPath
										: personalSettingsPath
								}
							>
								<SettingsIcon className="size-4" />
								Add an embedding provider
							</Link>
						</Button>
					)}
					<Button
						variant="ghost"
						size="icon"
						className="size-8"
						onClick={() =>
							setDismissedFor((previous) =>
								new Set(previous).add(
									organizationId ??
										DISMISSED_IN_PERSONAL_CONTEXT,
								),
							)
						}
						aria-label="Dismiss Anthropic capability notice"
					>
						<XIcon className="size-4" />
					</Button>
				</div>
			</Alert>
		</div>
	);
}
