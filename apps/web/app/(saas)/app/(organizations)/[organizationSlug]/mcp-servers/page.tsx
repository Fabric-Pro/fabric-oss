import { redirect } from "next/navigation";

type Props = {
	params: Promise<{ organizationSlug: string }>;
	searchParams: Promise<{ connect?: string | string[] }>;
};

/*
 * MCP servers live under Connections beside the integrations. The old
 * route stays for links, the project wizard and bookmarks, and lands on
 * that tab.
 *
 * Straight to /connections: this used to hop through
 * /settings/integrations, which is itself now a redirect here, so every
 * bookmark paid for two round trips to reach one page.
 *
 * `?connect=` names a server to connect, by id, key or name: the Connections
 * tab opens its setup from `server`.
 */
export default async function OrganizationMcpServersPage({
	params,
	searchParams,
}: Props) {
	const { organizationSlug } = await params;
	const { connect } = await searchParams;
	const server =
		typeof connect === "string" && connect
			? `&server=${encodeURIComponent(connect)}`
			: "";
	redirect(`/app/${organizationSlug}/connections?tab=mcp${server}`);
}
