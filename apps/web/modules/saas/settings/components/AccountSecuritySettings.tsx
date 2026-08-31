import { config } from "@repo/config";
import { userAccountQueryKey, userPasskeyQueryKey } from "@saas/auth/lib/api";
import {
	getSession,
	getUserAccounts,
	getUserPasskeys,
} from "@saas/auth/lib/server";
import { SettingsList } from "@saas/shared/components/SettingsList";
import { getServerQueryClient } from "@shared/lib/server";
import { ShieldAlertIcon } from "lucide-react";
import { redirect } from "next/navigation";
import { ActiveSessionsBlock } from "./ActiveSessionsBlock";
import { ChangePasswordForm } from "./ChangePassword";
import { ConnectedAccountsBlock } from "./ConnectedAccountsBlock";
import { PasskeysBlock } from "./PasskeysBlock";
import { SetPasswordForm } from "./SetPassword";
import { SettingsHero } from "./SettingsHero";
import { TwoFactorBlock } from "./TwoFactorBlock";

/**
 * Account security settings, rendered identically by the personal route
 * (`/app/settings/security`) and the organization one
 * (`/app/{slug}/settings/security`) — see Fizzy #1875 R7/R9.
 *
 * Deliberately takes no organization: password, passkeys, two-factor and
 * sessions are properties of the ACCOUNT, not of a tenant. Threading an
 * organization through here would invent per-organization security settings the
 * product does not have. The organization route only gives these controls a
 * place an organization member can reach; it does not scope them.
 */
export async function AccountSecuritySettings({
	mfaRequired = false,
}: {
	/** Renders the "your organization requires 2FA" notice above the forms. */
	mfaRequired?: boolean;
}) {
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
			{mfaRequired && (
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
