"use client";

import { useSession } from "@saas/auth/hooks/use-session";
import { useUserAccountsQuery } from "@saas/auth/lib/api";
import { useAccountPath } from "@saas/organizations/hooks/use-organization-context";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { cn } from "@ui/lib";
import { ShieldCheckIcon } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";

const mfaPromptStateQueryKey = ["mfaPromptState"] as const;

interface MfaSetupBannerProps {
	className?: string;
}

/**
 * Whether the security nudge has anything to say right now.
 *
 * `ShellNoticeRegion` asks this BEFORE it renders, because a React parent
 * cannot observe that a child returned null — a wrapper around null children
 * still mounts, and the region has to know it is empty to render nothing at
 * all.
 *
 * Both the region and the component below call it, in the same commit. The
 * second call is not a second request: the two observers share one query per
 * key, and `useSession` is a context read. The 60s `staleTime` default in
 * `@shared/lib/query-client` is what additionally keeps a later REMOUNT cheap
 * — that part, and only that part, is what a per-query `staleTime: 0` would
 * undo.
 *
 * Keeping the gates here rather than duplicating them in the region is what
 * stops the two from ever disagreeing about whether this notice exists.
 */
export function useMfaNoticeVisible(): boolean {
	const { user, loaded: sessionLoaded } = useSession();
	const accountsQuery = useUserAccountsQuery();

	const promptStateQuery = useQuery({
		queryKey: mfaPromptStateQueryKey,
		queryFn: async () => orpcClient.users.mfaPrompt.getState({}),
		enabled: sessionLoaded && user?.twoFactorEnabled !== true,
	});

	if (
		!sessionLoaded ||
		accountsQuery.isPending ||
		promptStateQuery.isPending
	) {
		return false;
	}

	if (user?.twoFactorEnabled === true) {
		return false;
	}

	// Only a password account can enrol a second factor here; an SSO-only user
	// has nothing to set up.
	const hasCredentialAccount =
		accountsQuery.data?.some(
			(account) => account.providerId === "credential",
		) === true;

	if (!hasCredentialAccount) {
		return false;
	}

	const promptState = promptStateQuery.data;
	if (!promptState) {
		return false;
	}

	if (promptState.dismissed) {
		return false;
	}

	if (
		promptState.snoozedUntil &&
		new Date(promptState.snoozedUntil) > new Date()
	) {
		return false;
	}

	return true;
}

export function MfaSetupBanner({ className }: MfaSetupBannerProps) {
	const t = useTranslations();
	// Account security lives inside an organization now, and specifically inside
	// one the caller BELONGS to. A URL-derived path would send a project-only
	// guest to the host organization's settings, which bounces them straight
	// back out — observed against a real guest, not inferred.
	const securityPath = useAccountPath("settings/account/security");
	const queryClient = useQueryClient();
	const isVisible = useMfaNoticeVisible();

	const dismissMutation = useMutation({
		mutationFn: async (action: "snooze" | "dismiss") =>
			orpcClient.users.mfaPrompt.dismiss({ action }),
		onMutate: async (action) => {
			await queryClient.cancelQueries({
				queryKey: mfaPromptStateQueryKey,
			});

			const previous = queryClient.getQueryData(mfaPromptStateQueryKey);

			if (action === "dismiss") {
				queryClient.setQueryData(mfaPromptStateQueryKey, {
					dismissed: true,
					snoozedUntil: null,
				});
			} else {
				queryClient.setQueryData(mfaPromptStateQueryKey, {
					dismissed: false,
					snoozedUntil: new Date(
						Date.now() + 7 * 24 * 60 * 60 * 1000,
					),
				});
			}

			return { previous };
		},
		onError: (_err, _action, context) => {
			if (context?.previous) {
				queryClient.setQueryData(
					mfaPromptStateQueryKey,
					context.previous,
				);
			}
		},
		onSettled: () => {
			queryClient.invalidateQueries({
				queryKey: mfaPromptStateQueryKey,
			});
		},
	});

	if (!isVisible) {
		return null;
	}

	// No positioning of its own: `ShellNoticeRegion` owns placement, spacing and
	// the landmark. This used to be a `fixed ... z-50` overlay, which reserved
	// no height and so covered the page heading — and, below `md`, the
	// navigation itself, which is static there. There is no slide-in either: a
	// downward slide at the moment the page reflows shows the same displacement
	// twice.
	return (
		<div
			className={cn(
				"mx-auto flex w-full max-w-5xl flex-col gap-3 rounded-2xl border border-border/70 bg-card/90 px-4 py-3 shadow-xl shadow-foreground/10 backdrop-blur-sm",
				"md:flex-row md:items-center md:justify-between",
				"motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-300",
				className,
			)}
		>
			<div className="flex min-w-0 items-start gap-3">
				<div className="mt-0.5 rounded-full border border-primary/20 bg-primary/10 p-2 text-primary">
					<ShieldCheckIcon className="size-4" />
				</div>
				<div className="min-w-0">
					<p className="text-sm font-medium text-foreground">
						{t("settings.account.security.mfaPrompt.title")}
					</p>
					<p className="text-sm leading-5 text-muted-foreground">
						{t("settings.account.security.mfaPrompt.description")}
					</p>
				</div>
			</div>
			<div className="flex shrink-0 items-center gap-2">
				<Button size="sm" variant="outline" asChild>
					<Link href={securityPath}>
						{t("settings.account.security.mfaPrompt.setupCta")}
					</Link>
				</Button>
				<Button
					size="sm"
					variant="ghost"
					onClick={() => dismissMutation.mutate("snooze")}
					disabled={dismissMutation.isPending}
				>
					{t("settings.account.security.mfaPrompt.snoozeCta")}
				</Button>
				<Button
					size="sm"
					variant="ghost"
					onClick={() => dismissMutation.mutate("dismiss")}
					disabled={dismissMutation.isPending}
				>
					{t("settings.account.security.mfaPrompt.dismissCta")}
				</Button>
			</div>
		</div>
	);
}
