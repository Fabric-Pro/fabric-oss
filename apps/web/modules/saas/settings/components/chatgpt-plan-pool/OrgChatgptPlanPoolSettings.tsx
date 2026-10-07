"use client";

import { useFeatureFlag } from "@saas/shared/components/FeatureFlagProvider";
import { Alert, AlertDescription } from "@ui/components/alert";
import { Skeleton } from "@ui/components/skeleton";
import { useTranslations } from "next-intl";
import { useChatgptPlanPool } from "./chatgpt-plan-pool-queries";
import { OrgChatgptPlanAccountsCard } from "./OrgChatgptPlanAccountsCard";
import { OrgChatgptPlanPolicyCard } from "./OrgChatgptPlanPolicyCard";

/**
 * The organization's shared ChatGPT plans, on its AI Providers page
 * (Fizzy #2770). Renders nothing, and mounts no query, unless both
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
			className="mt-6 space-y-4"
			data-testid="chatgpt-plan-pool-settings"
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
			</div>
			{query.isPending ? (
				<Skeleton className="h-24 w-full" />
			) : query.isError ? (
				<Alert variant="error">
					<AlertDescription>{t("loadFailed")}</AlertDescription>
				</Alert>
			) : (
				<>
					<OrgChatgptPlanPolicyCard
						isOwner={query.data.viewer.isOwner}
						policy={query.data.policy}
					/>
					<OrgChatgptPlanAccountsCard
						accounts={query.data.accounts}
						organizationSlug={organizationSlug}
					/>
				</>
			)}
		</section>
	);
}
