import {
	type AccountRedirectProps,
	redirectIntoOrganization,
} from "@saas/organizations/lib/account-route-redirect";

/**
 * Everything that used to live under `/app/frames/**` — frames and their embeds.
 *
 * This tree sat OUTSIDE the account route group, which is why the sweep that
 * retired the personal routes did not count it (Fizzy #1875, R1). It was
 * personal-rooted all the same — no slug, so no tenant — and it goes the same
 * way, with the organization's copy of each page left to serve.
 *
 * A catch-all under the static `frames` segment: it answers for `/app/frames`
 * and everything below it, which it can only do from here. See
 * `redirectIntoOrganization` for why the top level cannot.
 */
export default async function PersonalFramesRedirect({
	params,
	searchParams,
}: AccountRedirectProps) {
	const { path } = await params;
	const query = await searchParams;

	return redirectIntoOrganization("frames", path, query);
}
