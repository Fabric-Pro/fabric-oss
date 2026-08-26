import { createPurchasesHelper } from "@repo/payments/lib/helper";
import { getSession } from "@saas/auth/lib/server";
import { ActivePlan } from "@saas/payments/components/ActivePlan";
import { AiCreditsSettingsCard } from "@saas/payments/components/AiCreditsStatus";
import { ChangePlan } from "@saas/payments/components/ChangePlan";
import { BillingHero } from "@saas/settings/components/BillingHero";
import { SettingsList } from "@saas/shared/components/SettingsList";
import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import { getServerQueryClient } from "@shared/lib/server";
import { attemptAsync } from "es-toolkit";
import { getTranslations } from "next-intl/server";

export async function generateMetadata() {
	const t = await getTranslations();

	return {
		title: t("settings.billing.title"),
	};
}

export default async function BillingSettingsPage() {
	const session = await getSession();
	const [error, data] = await attemptAsync(() =>
		orpcClient.payments.listPurchases({}),
	);

	if (error) {
		throw new Error("Failed to fetch purchases");
	}

	const purchases = data?.purchases ?? [];

	const queryClient = getServerQueryClient();

	await queryClient.prefetchQuery({
		queryKey: orpc.payments.listPurchases.queryKey({
			input: {},
		}),
		queryFn: () => purchases,
	});

	const { activePlan } = createPurchasesHelper(purchases);

	return (
		<>
			<BillingHero />
			<SettingsList>
				<AiCreditsSettingsCard />
				{activePlan && <ActivePlan />}
				<ChangePlan
					userId={session?.user.id}
					activePlanId={activePlan?.id}
				/>
			</SettingsList>
		</>
	);
}
