import { auth } from "@repo/auth";
import { OrgFeatureFlagsPanel } from "@saas/admin/component/feature-flags/OrgFeatureFlagsPanel";
import { OrganizationForm } from "@saas/admin/component/organizations/OrganizationForm";
import { getAdminPath } from "@saas/admin/lib/links";
import { fullOrganizationQueryKey } from "@saas/organizations/lib/api";
import { getServerQueryClient } from "@shared/lib/server";
import { dehydrate, HydrationBoundary } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { ArrowLeftIcon } from "lucide-react";
import { headers } from "next/headers";
import Link from "next/link";
import { getTranslations } from "next-intl/server";

/**
 * Workspace-scoped admin organization form —
 * `/app/{organizationSlug}/admin/organizations/{id}`.
 *
 * The only such page: `/app/admin/**` is now a catch-all that redirects into
 * the organization tree (Fizzy #1875), so the personal mirror this once had is
 * gone. The "back to list" fallback keeps the current org slug
 * (`/app/{organizationSlug}/admin/organizations`) so navigating back from the
 * form doesn't drop the admin out of the workspace. This is a Server
 * Component, so it cannot use the `useAdminPath()` hook — instead it threads
 * the workspace base into `getAdminPath()` from the route's `organizationSlug`
 * param.
 *
 * Also the home of the per-organization feature-flag overrides. They live here
 * rather than on the instance-wide `admin/feature-flags` console because the
 * subject of the edit is this organization: the console answers "what does the
 * deployment do", this page answers "what does this organization do instead".
 */
export default async function OrganizationAdminOrganizationFormPage({
	params,
	searchParams,
}: {
	params: Promise<{ organizationSlug: string; id: string }>;
	searchParams: Promise<{ backTo?: string }>;
}) {
	const { organizationSlug, id } = await params;
	const { backTo } = await searchParams;

	const t = await getTranslations();
	const queryClient = getServerQueryClient();

	await queryClient.prefetchQuery({
		queryKey: fullOrganizationQueryKey(id),
		queryFn: async () =>
			await auth.api.getFullOrganization({
				query: {
					organizationId: id,
				},
				headers: await headers(),
			}),
	});

	return (
		<HydrationBoundary state={dehydrate(queryClient)}>
			<div>
				<div className="mb-2 flex justify-start">
					<Button variant="link" size="sm" asChild className="px-0">
						<Link
							href={
								backTo ??
								getAdminPath(
									"/organizations",
									`/app/${organizationSlug}`,
								)
							}
						>
							<ArrowLeftIcon className="mr-1.5 size-4" />
							{t("admin.organizations.backToList")}
						</Link>
					</Button>
				</div>
				<OrganizationForm organizationId={id} />

				<section className="mt-10">
					<h2 className="editorial-label mb-1">Feature flags</h2>
					<p className="mb-4 text-muted-foreground text-sm">
						Scope a rollout to this organization, or hold it out of
						a deployment-wide one.
					</p>
					<OrgFeatureFlagsPanel organizationId={id} />
				</section>
			</div>
		</HydrationBoundary>
	);
}
