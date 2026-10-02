"use client";

import { useIsGuestInOrg } from "@saas/organizations/hooks/use-is-guest-in-org";
import { useFeatureFlag } from "@saas/shared/components/FeatureFlagProvider";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import { Alert, AlertDescription, AlertTitle } from "@ui/components/alert";
import { Button } from "@ui/components/button";
import { Building2Icon } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useId } from "react";

type Props = {
	/** The project the document is being created in; the server resolves its organization. */
	projectId: string;
	/**
	 * The route's organization slug — the project's organization, since a
	 * project page is always rendered under the organization that hosts it.
	 * With none there is no settings page to link to, and nothing renders.
	 */
	organizationSlug: string | null;
	/** Runs before navigating, e.g. to close the dialog the notice sits in. */
	onNavigate?: () => void;
};

/**
 * Tells an organization member starting a Proposal or Business Case that their
 * company context has nothing ready for this draft to draw on (Fizzy #2719).
 *
 * The server decides, not this component. `noticeState` answers `hidden` alike
 * for a guest, a non-member, the gate being off and a company context with a
 * ready source, so the answer is no oracle. The client checks below only
 * save a request that could not come back as anything else: a guest is never
 * shown the notice and the flag-off answer is always `hidden`.
 *
 * **Nothing renders until the query has answered.** Keyed on "has an answer"
 * (`data !== undefined`), as the create dialog's own AI-availability guard is,
 * and not on a loading flag: a query that has not started is neither loading
 * nor answered, and reading that as `empty` would flash the notice on every
 * open of an organization whose context is ready. A failed read renders
 * nothing too — the notice is advice, and generation does not wait on it.
 *
 * **No dismiss state.** It shows on every such start for as long as the
 * company context stays empty; nothing is remembered, locally or on the server.
 * That is what separates it from the capability gate banner beside it, whose
 * warnings can be silenced for good.
 */
export function CompanyContextNotice({
	projectId,
	organizationSlug,
	onNavigate,
}: Props) {
	const t = useTranslations("projects.companyContextNotice");
	const companyContextEnabled = useFeatureFlag("COMPANY_CONTEXT");
	const isGuest = useIsGuestInOrg();
	const titleId = useId();

	const shouldAsk = companyContextEnabled && !isGuest && !!organizationSlug;

	const { data, isError } = useQuery({
		...orpc.organizations.companyContext.noticeState.queryOptions({
			input: { projectId },
		}),
		enabled: shouldAsk,
	});

	// `shouldAsk` again, not only in `enabled`: a disabled query still hands back
	// whatever its cache holds, and a guest or a flag-off tenant is told
	// nothing whatever an earlier read said.
	if (
		!shouldAsk ||
		isError ||
		data === undefined ||
		data.state === "hidden"
	) {
		return null;
	}

	const { state } = data;

	return (
		/* The warm neutral surface the CLI connection prompt uses rather than
		   an alert palette: this is an offer, not a fault. Nothing is broken and
		   the draft can be created as it is, so it must not read like the
		   warning banner it can sit beside. `role="note"` replaces the Alert's
		   own `role="alert"`, which would interrupt a screen reader for news
		   that can wait. */
		<Alert
			role="note"
			aria-labelledby={titleId}
			data-testid="company-context-notice"
			data-state={state}
			className="flex w-full items-start gap-3 border-border bg-muted/40 motion-safe:fade-in motion-safe:animate-in"
		>
			<Building2Icon
				aria-hidden="true"
				className="size-4 shrink-0 text-primary"
			/>
			<div className="min-w-0 flex-1">
				<AlertTitle id={titleId}>{t(`${state}.title`)}</AlertTitle>
				<AlertDescription>
					<p>{t(`${state}.body`)}</p>
				</AlertDescription>
			</div>
			<Button asChild size="sm" variant="outline" className="shrink-0">
				<Link
					href={`/app/${organizationSlug}/settings/company-context`}
					onClick={onNavigate}
				>
					{t("openSettings")}
				</Link>
			</Button>
		</Alert>
	);
}
