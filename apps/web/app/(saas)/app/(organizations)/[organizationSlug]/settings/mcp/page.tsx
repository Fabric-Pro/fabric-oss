import { redirect } from "next/navigation";

type Props = {
	params: Promise<{ organizationSlug: string }>;
};

/*
 * MCP servers now live under Connections beside the integrations, so a
 * person adding a capability has one place to look. The old route stays
 * for links and bookmarks and lands on that tab.
 */
export default async function Page({ params }: Props) {
	const { organizationSlug } = await params;
	redirect(`/app/${organizationSlug}/settings/integrations?tab=mcp`);
}
