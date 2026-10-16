import {
	type AccountRedirectProps,
	redirectIntoOrganization,
} from "@saas/organizations/lib/account-route-redirect";

/**
 * Everything that used to live under `/app/workspaces/**` - the document
 * libraries, which were called workspaces then.
 *
 * The personal route tree is gone (Fizzy #1875, FR5/R1). A saved link into it
 * meant a document library, so it arrives at the same path under `libraries`;
 * `workspaces` inside an organization now names the pages Fabric Agent writes.
 *
 * A catch-all under the static `workspaces` segment, not a plain page: it has to
 * answer for `/app/workspaces` AND everything below it, and it can only do that
 * from here - see `redirectIntoOrganization` for why the top level cannot.
 */
export default async function LegacyWorkspacesRedirect({
	params,
	searchParams,
}: AccountRedirectProps) {
	const { path } = await params;
	const query = await searchParams;

	return redirectIntoOrganization("libraries", path, query);
}
