import {
	type AccountRedirectProps,
	redirectIntoOrganization,
} from "@saas/organizations/lib/account-route-redirect";

/**
 * Everything that used to live under `/app/workspaces/**` - the document
 * document Workspaces.
 *
 * The personal route tree is gone (Fizzy #1875, FR5/R1). A saved link into it
 * meant a document workspace, so it arrives at the same organization route.
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

	return redirectIntoOrganization("workspaces", path, query);
}
