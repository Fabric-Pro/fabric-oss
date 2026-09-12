import { redirect } from "next/navigation";

type Props = {
	params: Promise<{ organizationSlug: string }>;
	searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/*
 * The catalogue moved to /app/{slug}/connections, a page of its own like the
 * other top-level sections. This route stays for links and bookmarks and
 * carries the query (?tab=mcp, ?server=…) across. Provider and action detail
 * pages beneath it are unchanged.
 */
export default async function IntegrationsSettingsPage({
	params,
	searchParams,
}: Props) {
	const { organizationSlug } = await params;
	const query = new URLSearchParams();
	for (const [key, value] of Object.entries(await searchParams)) {
		if (typeof value === "string") {
			query.set(key, value);
		}
	}
	const qs = query.toString();
	redirect(`/app/${organizationSlug}/connections${qs ? `?${qs}` : ""}`);
}
