import { redirect } from "next/navigation";

/**
 * Firecrawl settings have been unified with Search Providers.
 * Redirect users to the new unified settings page.
 */
export default async function FirecrawlSettingsPage({
	params,
}: {
	params: Promise<{ organizationSlug: string }>;
}) {
	const { organizationSlug } = await params;
	redirect(`/app/${organizationSlug}/settings/search-providers`);
}
