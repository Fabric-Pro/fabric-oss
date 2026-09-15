import { redirect } from "next/navigation";

type Props = {
	params: Promise<{ organizationSlug: string }>;
};

/*
 * MCP servers live under Connections beside the integrations. The old
 * route stays for links, the project wizard and bookmarks, and lands on
 * that tab.
 *
 * Straight to /connections: this used to hop through
 * /settings/integrations, which is itself now a redirect here, so every
 * bookmark paid for two round trips to reach one page.
 */
export default async function OrganizationMcpServersPage({ params }: Props) {
	const { organizationSlug } = await params;
	redirect(`/app/${organizationSlug}/connections?tab=mcp`);
}
