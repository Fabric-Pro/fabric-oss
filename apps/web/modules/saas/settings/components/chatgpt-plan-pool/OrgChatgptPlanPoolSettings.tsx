"use client";

import { useFeatureFlag } from "@saas/shared/components/FeatureFlagProvider";
import { Alert, AlertDescription } from "@ui/components/alert";
import { Skeleton } from "@ui/components/skeleton";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useChatgptPlanPool } from "./chatgpt-plan-pool-queries";
import { OrgChatgptPlanAccountsCard } from "./OrgChatgptPlanAccountsCard";

/**
 * The organization's shared ChatGPT plan accounts, on its AI Providers page
 * (Fizzy #2770). Their policy — sharing, what happens when every plan is
 * spent — lives on AI Models with the rest of the routing; this links there.
 * Renders nothing, and mounts no query, unless both
 * `CHATGPT_PLAN` and `CHATGPT_PLAN_POOLING` are on and the viewer is one of
 * the organization's admins or owners.
 */
export function OrgChatgptPlanPoolSettings({
	canManage,
	organizationSlug,
}: {
	canManage: boolean;
	organizationSlug: string;
}) {
	const plan = useFeatureFlag("CHATGPT_PLAN");
	const pooling = useFeatureFlag("CHATGPT_PLAN_POOLING");
	return plan && pooling && canManage ? (
		<OrgChatgptPlanPoolSection organizationSlug={organizationSlug} />
	) : null;
}

function OrgChatgptPlanPoolSection({
	organizationSlug,
}: {
	organizationSlug: string;
}) {
	const t = useTranslations("settings.chatgptPlanPool");
	const query = useChatgptPlanPool();

	return (
		<section
			aria-labelledby="chatgpt-plan-pool-heading"
			className="mt-6 scroll-mt-24 space-y-4"
			data-testid="chatgpt-plan-pool-settings"
			id="shared-chatgpt-plans"
		>
			<div className="space-y-1">
				<h2
					className="font-semibold text-lg"
					id="chatgpt-plan-pool-heading"
				>
					{t("title")}
				</h2>
				<p className="text-muted-foreground text-sm">
					{t("description")}
				</p>
				<Link
					className="inline-block text-primary text-sm underline underline-offset-4"
					data-testid="chatgpt-plan-pool-policy-link"
					href={`/app/${organizationSlug}/settings/ai-models`}
				>
					{t("policyLink")}
				</Link>
			</div>
			{query.isPending ? (
				<Skeleton className="h-24 w-full" />
			) : query.isError ? (
				<Alert variant="error">
					<AlertDescription>{t("loadFailed")}</AlertDescription>
				</Alert>
			) : (
				<OrgChatgptPlanAccountsCard
					accounts={query.data.accounts}
					organizationSlug={organizationSlug}
					viewerHasOwnPlan={query.data.viewer.hasOwnPlan ?? false}
				/>
			)}
		</section>
	);
}
