import { redirect } from "next/navigation";

type Props = {
	params: Promise<{ organizationSlug: string }>;
};

/*
 * MCP servers live under Connections beside the integrations. The old
 * route stays for links, the project wizard and bookmarks, and lands on
 * that tab.
 */
export default async function OrganizationMcpServersPage({ params }: Props) {
	const { organizationSlug } = await params;
	redirect(`/app/${organizationSlug}/settings/integrations?tab=mcp`);
}
