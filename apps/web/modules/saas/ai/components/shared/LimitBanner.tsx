/**
 * LimitBanner — renders a prominent inline banner when an AI request was
 * cut short by a provider limit (rate limit, quota, context length,
 * overloaded) or by the orchestrator's internal token budget.
 *
 * The chat/orchestrator previously swallowed these events into
 * plain-text responses, so users had no idea the run was truncated. This
 * component is the canonical surface for that feedback.
 *
 * Visual style follows `DocumentProcessingError` (warm destructive card).
 * Copy branches on (a) `signal.kind` and (b) billing permission — admins
 * see a deep-link to Billing settings; members get a "ask an admin" hint.
 */

"use client";

import type { LimitSignal } from "@repo/ai/limits";
import { Button } from "@ui/components/button";
import { AlertTriangleIcon, ExternalLinkIcon, XIcon } from "lucide-react";
import Link from "next/link";

export interface LimitBannerProps {
	signal: LimitSignal;
	/**
	 * When true, the banner shows a "Billing settings" deep link. Pass the
	 * result of `useActiveOrganization().isOrganizationAdmin` (or a similar
	 * billing-permission check) when rendering for an organization context.
	 * Defaults to `false` (member copy).
	 */
	canManageBilling?: boolean;
	/**
	 * Organization slug used to build the billing URL. When omitted, the
	 * banner renders for personal context and points to the user-level
	 * `/app/settings/billing` page.
	 */
	organizationSlug?: string | null;
	/**
	 * Optional dismiss handler. When omitted, the close button is hidden —
	 * useful for the execution dashboard where the banner describes the
	 * final result and should stay visible.
	 */
	onDismiss?: () => void;
}

interface BannerCopy {
	title: string;
	description: string;
	/** Additional hint line appended when `retryAfterMs` is set. */
	retryHint?: string;
}

function getBannerCopy(
	signal: LimitSignal,
	canManageBilling: boolean,
): BannerCopy {
	const adminTail =
		"Review usage and adjust limits or top up credits in Billing settings.";
	const memberTail =
		"Ask an organization owner or admin to adjust limits or top up credits.";
	const tail = canManageBilling ? adminTail : memberTail;

	switch (signal.kind) {
		case "internal_budget": {
			const pct = signal.budget?.usagePercentage;
			const used = signal.budget?.used;
			const total = signal.budget?.total;
			const usage =
				used != null && total != null
					? ` (${used.toLocaleString()} / ${total.toLocaleString()} tokens${
							pct != null ? `, ${pct}%` : ""
						})`
					: "";
			return {
				title: "Response was cut short — token budget reached",
				description: `This task used the full token budget for a single run${usage}. We summarized what we had so far, but the answer may be incomplete. ${tail}`,
			};
		}
		case "provider_quota":
			return {
				title: "AI provider quota exhausted",
				description: `The AI provider reported that your workspace's monthly quota is exhausted${
					signal.provider ? ` (${signal.provider})` : ""
				}. Responses will keep failing until the quota resets or credits are added. ${tail}`,
			};
		case "provider_rate_limit": {
			const retryHint =
				signal.retryAfterMs && signal.retryAfterMs > 0
					? `Try again in ~${Math.ceil(signal.retryAfterMs / 1000)}s.`
					: undefined;
			return {
				title: "AI provider rate limit hit",
				description: `The AI provider temporarily throttled this workspace${
					signal.provider ? ` (${signal.provider})` : ""
				}. This usually clears within a minute.`,
				retryHint,
			};
		}
		case "context_length":
			return {
				title: "Conversation is too long for this model",
				description:
					"The current conversation exceeded the model's context window. Start a new chat or pick a model with a larger context window to continue.",
			};
		case "provider_overloaded":
			return {
				title: "AI provider is overloaded",
				description: `The AI provider is currently overloaded${
					signal.provider ? ` (${signal.provider})` : ""
				} and could not handle this request. Please retry in a moment.`,
			};
	}
}

export function LimitBanner({
	signal,
	canManageBilling = false,
	organizationSlug,
	onDismiss,
}: LimitBannerProps) {
	const copy = getBannerCopy(signal, canManageBilling);
	const billingHref = organizationSlug
		? `/app/${organizationSlug}/settings/billing`
		: "/app/settings/billing";
	const showBillingLink =
		canManageBilling &&
		(signal.kind === "internal_budget" || signal.kind === "provider_quota");

	return (
		<div
			role="alert"
			aria-live="polite"
			className="mx-4 my-2 p-4 rounded-lg border border-destructive/50 bg-destructive/10"
		>
			<div className="flex items-start gap-3">
				<AlertTriangleIcon className="size-5 text-destructive shrink-0 mt-0.5" />
				<div className="flex-1 min-w-0">
					<p className="text-sm font-medium text-destructive">
						{copy.title}
					</p>
					<p className="text-sm text-muted-foreground mt-1">
						{copy.description}
					</p>
					{copy.retryHint ? (
						<p className="text-xs text-muted-foreground mt-1">
							{copy.retryHint}
						</p>
					) : null}
					{showBillingLink ? (
						<div className="mt-3">
							<Button asChild variant="outline" size="sm">
								<Link href={billingHref}>
									Billing settings
									<ExternalLinkIcon className="ml-1.5 size-3.5" />
								</Link>
							</Button>
						</div>
					) : null}
				</div>
				{onDismiss ? (
					<Button
						variant="ghost"
						size="icon"
						className="size-6 shrink-0"
						onClick={onDismiss}
						aria-label="Dismiss notification"
					>
						<XIcon className="size-4" />
					</Button>
				) : null}
			</div>
		</div>
	);
}
