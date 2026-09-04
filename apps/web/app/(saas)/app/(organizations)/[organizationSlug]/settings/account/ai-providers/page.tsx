import { getSession } from "@saas/auth/lib/server";
import { AiProvidersSettingsForm } from "@saas/settings/components/AiProvidersSettingsForm";
import { SettingsHero } from "@saas/settings/components/SettingsHero";
import { SettingsList } from "@saas/shared/components/SettingsList";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";

export async function generateMetadata() {
	const t = await getTranslations();

	return {
		title: `AI Providers — ${t("settings.account.title")}`,
	};
}

/**
 * The organization-reachable home for a person's OWN AI provider keys (Fizzy
 * #1875, R12/AE7).
 *
 * A wrapper, not a feature: the form it mounts is the one that has always
 * existed, and it went dark when the personal settings tree was retired — not
 * because anyone decided a personal key was personal *context*. It is not. A
 * key belongs to the person, resolves inside whichever organization they are
 * working in, and the organization has no claim on it. That is the same
 * reasoning that kept the profile, security, notification and account-deletion
 * pages in this group rather than deleting them with the tree, so this belongs
 * beside them.
 *
 * Why it matters that it exists at all: the "AI provider required" notice tells
 * a member who cannot edit organization settings that they can add a key of
 * their own. That was true of the resolver and false of the interface — there
 * was nowhere to add one. This is the destination that closes it.
 *
 * `organizationSlug` is deliberately not read. Like its four siblings, nothing
 * here is scoped per tenant: the form posts `organizationId: null` throughout,
 * which is what makes the key the caller's rather than the organization's.
 */
export default async function AccountAiProvidersSettingsPage() {
	const session = await getSession();

	if (!session) {
		redirect("/auth/login");
	}

	return (
		<>
			<SettingsHero
				title="Your AI Providers"
				label="Account"
				description="Connect an AI provider with your own API key. It travels with you into every organization you work in, and is used when the organization you are in has no provider of its own."
			/>
			<SettingsList>
				<AiProvidersSettingsForm />
			</SettingsList>
		</>
	);
}
