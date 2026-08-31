"use client";

import { useIsGuestInOrg } from "@saas/organizations/hooks/use-is-guest-in-org";
import {
	useAccountOrganization,
	useOrganizationContext,
} from "@saas/organizations/hooks/use-organization-context";
import {
	type AiUsageLimitStatus,
	useAiUsageLimits,
	useAiUsageLimitsStatus,
} from "@saas/payments/hooks/useAiUsageLimits";
import { Alert, AlertDescription, AlertTitle } from "@ui/components/alert";
import { Button } from "@ui/components/button";
import { cn } from "@ui/lib";
import { AlertTriangle, ExternalLink } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useMemo } from "react";

/**
 * Persistent warning banner for AI usage limits that have crossed the
 * per-limit `bannerThresholdPercent` (default 90%, configurable 1-99).
 * Independent of the 80% / 100% notification fan-out — the banner is the
 * *persistent visual surface*, notifications are *one-shot events*.
 * Visual states (per CLAUDE.md design principles — editorial restraint,
 * warm materials, no glassmorphism):
 * - amber `highlight` (warning) when at the configured threshold but
 * still under 100% (the limit is approaching but not yet blocking)
 * - red `destructive` when at or above 100% on a HARD limit (blocking
 * state — the toast already fires at block time; the banner is the
 * persistent reminder)
 * Layout: stacks one banner row per crossed limit, capped at 3 visible
 * rows + a "+N more" pivot to the settings page. Banners share the same
 * "Manage limits" link as the toast / notification — single source of
 * truth for the action.
 * Renders nothing when no limits are configured, no thresholds crossed,
 * or the query is loading / errored (graceful — the banner is a
 * supplementary surface, not load-bearing).
 */
export function AiUsageLimitBanner() {
	const t = useTranslations();
	const { organizationId, organizationSlug } = useOrganizationContext();
	// A project-scoped guest must see THEIR limits, never the host org's, and
	// the org-scoped procedures 403 for them in the host anyway. That used to
	// mean personal scope — an explicit `null`. Personal scope is going away,
	// and a guest now has an organization of their own, so it means theirs.
	// Server-seeded, so this is correct on first render.
	const isGuest = useIsGuestInOrg();
	const accountOrg = useAccountOrganization();
	const effectiveOrganizationId = isGuest
		? (accountOrg?.id ?? null)
		: organizationId;
	const { data } = useAiUsageLimitsStatus(effectiveOrganizationId);
	// `canManage` mirrors the gate on AiUsageLimitsCard — non-admin org
	// members get an empty payload from the status procedure, so they
	// shouldn't see the banner anyway. We still defence-in-depth the
	// "Manage limits" CTA so a misconfiguration cannot surface an
	// admin-only deep link to a non-admin.
	const { data: listData } = useAiUsageLimits(effectiveOrganizationId);
	const canManage = listData?.canManage ?? false;

	const triggered = useMemo(() => {
		if (!data?.statuses) {
			return [];
		}
		return data.statuses.filter(
			(status) => status.percent >= status.limit.bannerThresholdPercent,
		);
	}, [data]);

	if (triggered.length === 0) {
		return null;
	}

	const visible = triggered.slice(0, 3);
	const remaining = triggered.length - visible.length;

	// The CTA must land in the same tenancy the rows above were fetched with.
	//
	// It interpolated the organization ID into a path segment that resolves by
	// SLUG, so for every organization member this link 404'd — verified against
	// a live server, where the id form is a 404 and the slug form is a 200.
	// Pre-existing; found while sweeping the personal fallbacks out.
	const settingsSlug = isGuest ? accountOrg?.slug : organizationSlug;
	const baseSettingsPath = settingsSlug
		? `/app/${settingsSlug}/settings/usage`
		: "/app/settings/usage";

	return (
		<div className="space-y-2 pt-3 pb-1">
			{visible.map((status) => (
				<AiUsageLimitBannerRow
					key={status.limit.id}
					status={status}
					manageHref={`${baseSettingsPath}?limitId=${status.limit.id}`}
					canManage={canManage}
				/>
			))}
			{remaining > 0 && canManage ? (
				<div className="text-muted-foreground text-sm">
					<Link
						href={baseSettingsPath}
						className="underline underline-offset-2 hover:text-foreground"
					>
						{t("settings.aiUsage.limits.banner.moreLink", {
							count: remaining,
						})}
					</Link>
				</div>
			) : null}
		</div>
	);
}

interface AiUsageLimitBannerRowProps {
	status: AiUsageLimitStatus;
	manageHref: string;
	canManage: boolean;
}

function AiUsageLimitBannerRow({
	status,
	manageHref,
	canManage,
}: AiUsageLimitBannerRowProps) {
	const t = useTranslations();
	const { limit, percent } = status;

	// State picks the alert variant. >=100% on HARD is "blocking now",
	// >=100% on SOFT is "over budget but still allowed", configured
	// threshold reached but <100% is "approaching limit". The amber
	// vs red distinction matches CLAUDE.md `--highlight` vs
	// `--destructive` tokens.
	const isAtBlockingLevel = percent >= 100;
	const variant: "error" | "default" = isAtBlockingLevel
		? "error"
		: "default";

	const titleKey = isAtBlockingLevel
		? limit.enforcement === "HARD"
			? "settings.aiUsage.limits.banner.title.blockingHard"
			: "settings.aiUsage.limits.banner.title.overBudgetSoft"
		: "settings.aiUsage.limits.banner.title.approaching";

	const limitLabel = limit.name?.trim()
		? limit.name
		: t("settings.aiUsage.limits.banner.unnamedFallback");

	return (
		<Alert
			variant={variant}
			className={cn(
				"flex items-start gap-3",
				// Amber state — destructive variant covers >=100%. Below
				// that, paint the alert in our `--highlight` token instead
				// of the default neutral so users see "approaching" at a
				// glance without it shouting like an error.
				!isAtBlockingLevel &&
					"border-highlight/40 bg-highlight/5 text-highlight-foreground dark:text-highlight",
			)}
		>
			<AlertTriangle
				className={cn(
					"size-4 shrink-0",
					isAtBlockingLevel ? "text-destructive" : "text-highlight",
				)}
				aria-hidden="true"
			/>
			<div className="flex-1 space-y-1">
				<AlertTitle>{t(titleKey, { name: limitLabel })}</AlertTitle>
				<AlertDescription>
					{t("settings.aiUsage.limits.banner.description", {
						percent: Math.min(percent, 999),
						window: t(
							`settings.aiUsage.limits.window.${limit.window.toLowerCase()}` as
								| "settings.aiUsage.limits.window.hourly"
								| "settings.aiUsage.limits.window.daily"
								| "settings.aiUsage.limits.window.monthly",
						),
					})}
				</AlertDescription>
			</div>
			{canManage ? (
				<Button
					asChild
					size="sm"
					variant={isAtBlockingLevel ? "secondary" : "outline"}
					className="shrink-0"
				>
					<Link href={manageHref}>
						{t("settings.aiUsage.limits.banner.manageCta")}
						<ExternalLink
							className="ml-1 size-3"
							aria-hidden="true"
						/>
					</Link>
				</Button>
			) : null}
		</Alert>
	);
}
