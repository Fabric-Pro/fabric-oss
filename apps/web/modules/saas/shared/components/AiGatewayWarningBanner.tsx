"use client";

import { useIsGuestInOrg } from "@saas/organizations/hooks/use-is-guest-in-org";
import {
	useContextPath,
	useOrganizationContext,
} from "@saas/organizations/hooks/use-organization-context";
import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";
import { Alert, AlertDescription, AlertTitle } from "@ui/components/alert";
import { Button } from "@ui/components/button";
import {
	AlertTriangleIcon,
	KeyRoundIcon,
	SettingsIcon,
	XIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

/**
 * The query key this notice reads, exported so nothing has to hand-write it.
 *
 * The AI provider settings forms invalidate the `["aiConfigStatus"]` PREFIX
 * after every save, which is what makes configuring a provider clear this
 * notice without a reload — the organization id below is a suffix, so a
 * prefix invalidation reaches every scope at once.
 */
export function aiConfigStatusQueryKey(organizationId: string | null) {
	return ["aiConfigStatus", organizationId] as const;
}

/**
 * The notice shown when a user-facing AI operation has no provider to run on.
 *
 * Mounted in the app chrome (`AppWrapper`), so it appears on every page inside
 * an organization rather than only on the dashboard — it took over that slot
 * from the removed AI-credits banner (Fizzy #1875, R5). A tenant with no
 * configured provider is a tenant for whom nothing AI-shaped works, so the
 * dashboard was the wrong and only place to say so.
 *
 * Three things it must get right, because moving it here would otherwise break
 * all three:
 *
 * 1. A project guest holds no organization membership, so the organization-
 *    scoped status call 403s for them. The removed banner was handed an
 *    explicit null by the layout; this one takes no props, so it reads the
 *    server-seeded guest flag and asks nothing at all (R12 / AE6).
 * 2. Reading provider config is a viewer right; editing it is admin-only. A
 *    member who cannot edit is never handed the control to the organization's
 *    form, which would only render read-only for them; they get the control to
 *    their OWN provider page, which is the remedy the copy offers them and the
 *    one they can carry out alone (R12 / AE7).
 * 3. It reads `canResolveProvider`, not `isConfigured`. Only the former
 *    mirrors what the resolver does — see the status procedure (R11).
 */
export function AiGatewayWarningBanner() {
	const pathname = usePathname();
	// Dismissal is per page, not per session (R14). Recording WHERE it was
	// dismissed rather than a bare boolean is what makes it reset on
	// navigation: the dashboard mount used to get that for free by
	// unmounting, and a chrome mount that survives navigation would
	// otherwise turn one click into permanent silence.
	const [dismissedOn, setDismissedOn] = useState<string | null>(null);
	const { organizationId, isOrgContext, isOrganizationAdmin } =
		useOrganizationContext();
	const settingsPath = useContextPath("settings/ai-providers");
	// The account-global provider page (Fizzy #1875, R12). Same organization
	// base path, because it is reached from inside the organization the member
	// is working in — what makes it theirs is the page, not the URL prefix.
	const personalSettingsPath = useContextPath(
		"settings/account/ai-providers",
	);
	// Server-seeded by the organization layout's guest provider, so this is
	// correct on the first render. The account layout mounts the chrome
	// WITHOUT that provider; this hook tolerates its absence and answers
	// false, which is right — a workspace of one's own has no host to be a
	// guest of.
	const isGuest = useIsGuestInOrg();

	// IMPORTANT: `organizationId` is passed explicitly (null in personal
	// context) to prevent the session fallback from leaking org data.
	const { data: configStatus, isLoading } = useQuery({
		queryKey: aiConfigStatusQueryKey(organizationId),
		queryFn: async () => {
			return await orpcClient.aiConfig.resolution.getStatus({
				organizationId,
			});
		},
		enabled: !isGuest,
	});

	// A guest is never asked about, and never told about, an organization they
	// do not belong to. The call would 403, leaving `data` undefined — which,
	// read as "not configured", would pin this notice to every page they load
	// behind a control that redirects them straight back out.
	if (isGuest) {
		return null;
	}

	// Absent data means "we do not know", not "nothing is configured". A
	// failed status call must not put a permanent outage notice on every page.
	const canResolveProvider = configStatus?.canResolveProvider ?? true;

	if (isLoading || canResolveProvider || dismissedOn === pathname) {
		return null;
	}

	// Outside an organization there is no admin above the caller, so the
	// configuration is theirs to change — the same shape as `useLimitToast`.
	const canConfigure = isOrgContext ? isOrganizationAdmin : true;

	// Neither message claims that scheduled or background work has stopped,
	// because it has not: indexing, embedding and tool ingestion keep their
	// own key resolution (R13). What stops is the user-facing half.
	const description = canConfigure
		? "Add an OpenAI, Anthropic, Vercel AI Gateway, OpenRouter, or compatible provider key to use chat, agents, and document generation."
		: "This organization has no AI provider configured, so chat, agents, and document generation are unavailable here. An organization admin can add one — or add a personal key to use these features yourself.";

	return (
		// `sticky` rather than plain flow: this notice explains why every AI
		// action on the page will refuse, and it now renders on pages a reader
		// arrives at already scrolled. In static flow it would sit at the top
		// of the document, off-screen, and the refusal would arrive unexplained.
		// Browser scroll anchoring makes that worse, not better — it holds the
		// reading position precisely so nothing visibly moves.
		//
		// Spacing belongs on this wrapper, never on the Alert: the Alert owns
		// `p-4`, so `pt-*`/`pb-*` passed through its className would shrink its
		// own padding instead of adding any outer gap. Same rhythm as the
		// sibling banners in this column.
		<div className="sticky top-0 z-10 flex shrink-0 justify-center px-3 pt-3 pb-1 motion-safe:animate-in motion-safe:fade-in">
			{/* Painted in the `--highlight` token rather than the primitive's
			 * `warning` variant, which reaches for a raw Tailwind yellow —
			 * same amber the sibling usage-limit banner uses for its
			 * "approaching" state, so the column reads as one system. */}
			<Alert
				aria-label="AI setup reminder"
				className="flex w-full max-w-4xl items-start gap-3 border-highlight/40 bg-highlight/5 text-highlight-foreground dark:text-highlight"
			>
				<AlertTriangleIcon
					className="size-4 shrink-0 text-highlight"
					aria-hidden="true"
				/>
				<div className="min-w-0 flex-1">
					<AlertTitle>AI provider required</AlertTitle>
					<AlertDescription>{description}</AlertDescription>
				</div>
				<div className="flex shrink-0 items-center gap-2">
					{/* Each role gets the one control it can actually act on.
					 * R12 forbids sending anyone to a page they cannot change:
					 * the organization's provider page renders read-only for a
					 * member, so they are sent to their own provider page
					 * instead — the remedy the copy above offers them, which
					 * until now had no destination to point at. */}
					{canConfigure ? (
						<Button asChild size="sm" variant="outline">
							<Link href={settingsPath}>
								<SettingsIcon className="size-4" />
								Configure provider
							</Link>
						</Button>
					) : (
						<Button asChild size="sm" variant="outline">
							<Link href={personalSettingsPath}>
								<KeyRoundIcon className="size-4" />
								Add your own key
							</Link>
						</Button>
					)}
					<Button
						variant="ghost"
						size="icon"
						className="size-8"
						onClick={() => setDismissedOn(pathname)}
						aria-label="Dismiss AI setup reminder"
					>
						<XIcon className="size-4" />
					</Button>
				</div>
			</Alert>
		</div>
	);
}
