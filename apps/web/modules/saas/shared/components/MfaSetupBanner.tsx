"use client";

import { useSession } from "@saas/auth/hooks/use-session";
import { useUserAccountsQuery } from "@saas/auth/lib/api";
import { useAccountPath } from "@saas/organizations/hooks/use-organization-context";
import { useSidebarCollapse } from "@saas/shared/contexts/SidebarCollapseContext";
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

export function MfaSetupBanner({ className }: MfaSetupBannerProps) {
	const t = useTranslations();
	const { user, loaded: sessionLoaded } = useSession();
	const { isCollapsed } = useSidebarCollapse();
	// Account security lives inside an organization now, and specifically inside
	// one the caller BELONGS to. A URL-derived path would send a project-only
	// guest to the host organization's settings, which bounces them straight
	// back out — observed against a real guest, not inferred.
	const securityPath = useAccountPath("settings/account/security");
	const accountsQuery = useUserAccountsQuery();
	const queryClient = useQueryClient();

	const promptStateQuery = useQuery({
		queryKey: mfaPromptStateQueryKey,
		queryFn: async () => orpcClient.users.mfaPrompt.getState({}),
		enabled: sessionLoaded && user?.twoFactorEnabled !== true,
	});

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

	if (
		!sessionLoaded ||
		accountsQuery.isPending ||
		promptStateQuery.isPending
	) {
		return null;
	}

	if (user?.twoFactorEnabled === true) {
		return null;
	}

	const hasCredentialAccount =
		accountsQuery.data?.some(
			(account) => account.providerId === "credential",
		) === true;

	if (!hasCredentialAccount) {
		return null;
	}

	const promptState = promptStateQuery.data;
	if (!promptState) {
		return null;
	}

	if (promptState.dismissed) {
		return null;
	}

	if (
		promptState.snoozedUntil &&
		new Date(promptState.snoozedUntil) > new Date()
	) {
		return null;
	}

	return (
		<aside
			aria-label={t("settings.account.security.mfaPrompt.ariaLabel")}
			className={cn(
				"pointer-events-none fixed top-4 right-4 left-4 z-50 md:right-6",
				isCollapsed ? "md:left-[96px]" : "md:left-[256px]",
				className,
			)}
		>
			<div
				className={cn(
					"pointer-events-auto mx-auto flex max-w-5xl flex-col gap-3 rounded-2xl border border-border/70 bg-card/90 px-4 py-3 shadow-xl shadow-foreground/10 backdrop-blur-sm",
					"md:flex-row md:items-center md:justify-between",
					"motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-top-2 motion-safe:duration-300",
				)}
			>
				<div className="flex min-w-0 items-start gap-3">
					<div className="mt-0.5 rounded-full border border-primary/20 bg-primary/10 p-2 text-primary">
						<ShieldCheckIcon className="size-4" />
					</div>
					<div className="min-w-0">
						<p className="text-sm font-medium text-foreground">
							Secure your account
						</p>
						<p className="text-sm leading-5 text-muted-foreground">
							Add two-factor authentication when you have a
							minute.
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
		</aside>
	);
}
