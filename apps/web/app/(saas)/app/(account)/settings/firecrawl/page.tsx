import { redirect } from "next/navigation";

/**
 * Firecrawl settings have been unified with Search Providers.
 * Redirect users to the new unified settings page.
 */
export default function UserFirecrawlSettingsPage() {
	redirect("/app/settings/search-providers");
}
