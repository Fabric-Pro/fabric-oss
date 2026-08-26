import { config } from "@repo/config";
import { userAccountQueryKey, userPasskeyQueryKey } from "@saas/auth/lib/api";
import {
	getSession,
	getUserAccounts,
	getUserPasskeys,
} from "@saas/auth/lib/server";
import { ActiveSessionsBlock } from "@saas/settings/components/ActiveSessionsBlock";
import { ChangePasswordForm } from "@saas/settings/components/ChangePassword";
import { ConnectedAccountsBlock } from "@saas/settings/components/ConnectedAccountsBlock";
import { PasskeysBlock } from "@saas/settings/components/PasskeysBlock";
import { SetPasswordForm } from "@saas/settings/components/SetPassword";
import { SettingsHero } from "@saas/settings/components/SettingsHero";
import { TwoFactorBlock } from "@saas/settings/components/TwoFactorBlock";
import { SettingsList } from "@saas/shared/components/SettingsList";
import { getServerQueryClient } from "@shared/lib/server";
import { ShieldAlertIcon } from "lucide-react";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";

export async function generateMetadata() {
	const t = await getTranslations();

	return {
		title: t("settings.account.security.title"),
	};
}

export default async function AccountSettingsPage({
	searchParams,
}: {
	searchParams: Promise<{ mfaRequired?: string; from?: string }>;
}) {
	const { mfaRequired } = await searchParams;
	const session = await getSession();

	if (!session) {
		redirect("/auth/login");
	}

	const userAccounts = await getUserAccounts();

	const userHasPassword = userAccounts?.some(
		(account) => account.providerId === "credential",
	);

	const queryClient = getServerQueryClient();

	await queryClient.prefetchQuery({
		queryKey: userAccountQueryKey,
		queryFn: () => getUserAccounts(),
	});

	if (config.auth.enablePasskeys) {
		await queryClient.prefetchQuery({
			queryKey: userPasskeyQueryKey,
			queryFn: () => getUserPasskeys(),
		});
	}

	return (
		<>
			<SettingsHero
				title="Security"
				label="Account"
				description="Manage your password, active sessions, and two-factor authentication."
			/>
			{mfaRequired === "1" && (
				<div className="rounded-lg border border-highlight/40 bg-highlight/10 p-4">
					<div className="flex items-start gap-3">
						<ShieldAlertIcon className="mt-0.5 size-5 shrink-0 text-highlight" />
						<div className="space-y-1 text-sm">
							<p className="font-medium text-foreground">
								Your organization requires two-factor
								authentication
							</p>
							<p className="text-muted-foreground">
								Set up two-factor authentication below to
								continue accessing your organization.
							</p>
						</div>
					</div>
				</div>
			)}
			<SettingsList>
				{config.auth.enablePasswordLogin &&
					(userHasPassword ? (
						<ChangePasswordForm />
					) : (
						<SetPasswordForm />
					))}
				{config.auth.enableSocialLogin && <ConnectedAccountsBlock />}
				{config.auth.enablePasskeys && <PasskeysBlock />}
				{config.auth.enableTwoFactor && <TwoFactorBlock />}
				<ActiveSessionsBlock />
			</SettingsList>
		</>
	);
}
