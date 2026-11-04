import { redirect } from "next/navigation";

/** Compatibility alias for document workspaces briefly named Libraries. */
export default async function LegacyLibrariesRedirect({
	params,
	searchParams,
}: {
	params: Promise<{ organizationSlug: string; path?: string[] }>;
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
	const { organizationSlug, path = [] } = await params;
	const query = new URLSearchParams();
	for (const [key, value] of Object.entries(await searchParams)) {
		for (const entry of Array.isArray(value)
			? value
			: value === undefined
				? []
				: [value]) {
			query.append(key, entry);
		}
	}
	const suffix = path
		.map((segment) => `/${encodeURIComponent(segment)}`)
		.join("");
	const search = query.size ? `?${query}` : "";
	redirect(
		`/app/${encodeURIComponent(organizationSlug)}/workspaces${suffix}${search}`,
	);
}
