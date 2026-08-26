/**
 * useLimitToast — wraps Sonner toast with copy and billing-permission
 * branching for `LimitSignal` events.
 *
 * Use this in one-shot mutations (feature-enhance, generate-tasks, etc.)
 * where an inline `LimitBanner` is not appropriate but we still need to
 * tell the user that the call was truncated by a provider or budget
 * limit.
 */

"use client";

import type { LimitSignal } from "@repo/ai/limits";
import { useRouter } from "next/navigation";
import { useCallback } from "react";
import { toast } from "sonner";
import { useActiveOrganization } from "../../organizations/hooks/use-active-organization";

interface ShowOptions {
	/** Override the admin/member detection (e.g. for personal context). */
	canManageBilling?: boolean;
	/** Override organization slug used to build the billing URL. */
	organizationSlug?: string | null;
}

function getToastCopy(
	signal: LimitSignal,
	canManageBilling: boolean,
): { title: string; description: string } {
	const adminTail =
		"Review usage and adjust limits or top up credits in Billing settings.";
	const memberTail =
		"Ask an organization owner or admin to adjust limits or top up credits.";
	const tail = canManageBilling ? adminTail : memberTail;

	switch (signal.kind) {
		case "internal_budget":
			return {
				title: "Response was cut short — token budget reached",
				description: `This task hit the single-run token budget. ${tail}`,
			};
		case "provider_quota":
			return {
				title: "AI provider quota exhausted",
				description: `${signal.provider ? `${signal.provider}: ` : ""}responses will keep failing until the quota resets. ${tail}`,
			};
		case "provider_rate_limit": {
			const retry =
				signal.retryAfterMs && signal.retryAfterMs > 0
					? ` Try again in ~${Math.ceil(signal.retryAfterMs / 1000)}s.`
					: "";
			return {
				title: "AI provider rate limit hit",
				description: `${signal.provider ?? "The AI provider"} temporarily throttled this request.${retry}`,
			};
		}
		case "context_length":
			return {
				title: "Conversation is too long",
				description:
					"The conversation exceeded the model's context window. Start a new chat or switch to a larger-context model.",
			};
		case "provider_overloaded":
			return {
				title: "AI provider is overloaded",
				description: `${signal.provider ?? "The AI provider"} is overloaded right now. Please retry in a moment.`,
			};
	}
}

export function useLimitToast() {
	const { activeOrganization, isOrganizationAdmin } = useActiveOrganization();
	const router = useRouter();

	return useCallback(
		(signal: LimitSignal, options: ShowOptions = {}) => {
			const canManageBilling =
				options.canManageBilling ??
				(activeOrganization ? isOrganizationAdmin : true);
			const slug =
				options.organizationSlug ?? activeOrganization?.slug ?? null;
			const copy = getToastCopy(signal, canManageBilling);
			const showBillingAction =
				canManageBilling &&
				(signal.kind === "internal_budget" ||
					signal.kind === "provider_quota");
			const billingHref = slug
				? `/app/${slug}/settings/billing`
				: "/app/settings/billing";

			toast.error(copy.title, {
				description: copy.description,
				action: showBillingAction
					? {
							label: "Billing settings",
							onClick: () => router.push(billingHref),
						}
					: undefined,
			});
		},
		[activeOrganization, isOrganizationAdmin, router],
	);
}
