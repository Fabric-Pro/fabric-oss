import { PERSONAL_AI_PROVIDERS_PATH } from "@saas/settings/lib/personal-ai-providers-path";
import { redirect } from "next/navigation";

/**
 * The member's own AI provider keys used to have a page here (Fizzy #1875,
 * R12). They now live on the Personal tab of the organization's AI Providers
 * page (Fizzy #3082), so the two sets of keys sit side by side. This route
 * stays for links and bookmarks and lands on that tab, in the same
 * organization.
 */
export default async function AccountAiProvidersSettingsPage({
	params,
}: {
	params: Promise<{ organizationSlug: string }>;
}) {
	const { organizationSlug } = await params;
	redirect(`/app/${organizationSlug}/${PERSONAL_AI_PROVIDERS_PATH}`);
}
