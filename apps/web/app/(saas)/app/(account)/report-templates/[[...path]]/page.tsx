import {
	type AccountRedirectProps,
	redirectIntoOrganization,
} from "@saas/organizations/lib/account-route-redirect";

/**
 * Everything that used to live under `/app/report-templates/**` — report templates and their instances.
 *
 * The personal route tree is gone (Fizzy #1875, FR5/R1). The organization has a
 * page of the same name, and personal-context data is being dropped, so that
 * page is the only one left to show. This redirect stands in for the tree so a
 * saved link still arrives.
 *
 * A catch-all under the static `report-templates` segment, not a plain page: it has to
 * answer for `/app/report-templates` AND everything below it, and it can only do that
 * from here — see `redirectIntoOrganization` for why the top level cannot.
 */
export default async function PersonalReportTemplatesRedirect({
	params,
	searchParams,
}: AccountRedirectProps) {
	const { path } = await params;
	const query = await searchParams;

	return redirectIntoOrganization("report-templates", path, query);
}
