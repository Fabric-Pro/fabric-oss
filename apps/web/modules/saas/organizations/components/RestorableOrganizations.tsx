"use client";

import {
	restorableOrganizationsQueryKey,
	useRestorableOrganizationsQuery,
} from "@saas/organizations/lib/api";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

/**
 * Organizations the viewer deleted and can still bring back (Fizzy #2462).
 *
 * Shared by the two places a person can actually be standing when they want
 * this, which are different places:
 *
 *  - `variant="switcher"` — the workspace menu, for someone who still has
 *    another organization open;
 *  - `variant="banner"` — the create-an-organization page, for someone who
 *    deleted their LAST one. Deleting your only organization redirects there,
 *    and without this that page is a dead end that offers to create something
 *    new while saying nothing about what you can still recover.
 */
function useRestoreOrganization() {
	const t = useTranslations();
	const router = useRouter();
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (organizationId: string) =>
			orpcClient.organizations.deletion.restore({ organizationId }),
		onSuccess: async (result) => {
			toast.success(
				t("organizations.restore.restored", {
					organizationName: result.organization.name,
				}),
			);
			await queryClient.invalidateQueries({
				queryKey: restorableOrganizationsQueryKey,
			});
			await queryClient.invalidateQueries({
				queryKey: ["user", "organizations"],
			});
			router.refresh();
		},
		onError: () => {
			toast.error(t("organizations.restore.failed"));
		},
	});
}

export function RestorableOrganizations({
	variant,
}: {
	variant: "switcher" | "banner";
}) {
	const t = useTranslations();
	const { data } = useRestorableOrganizationsQuery();
	const restore = useRestoreOrganization();

	const organizations = data?.organizations ?? [];

	if (organizations.length === 0) {
		return null;
	}

	if (variant === "banner") {
		return (
			<div className="flex flex-col gap-3">
				{organizations.map((organization) => (
					<div
						key={organization.id}
						className="flex flex-wrap items-center gap-3 rounded-lg border border-highlight/40 bg-highlight/10 px-4 py-3"
					>
						<div className="flex-1 min-w-[14rem]">
							<p className="font-medium text-sm">
								{t("organizations.restore.bannerTitle", {
									organizationName: organization.name,
								})}
							</p>
							<p className="text-muted-foreground text-sm">
								{t("organizations.restore.daysRemaining", {
									days: organization.daysRemaining ?? 0,
								})}
							</p>
						</div>
						<Button
							variant="outline"
							size="sm"
							loading={restore.isPending}
							onClick={() => restore.mutate(organization.id)}
						>
							{t("organizations.restore.action")}
						</Button>
					</div>
				))}
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-1 px-1 py-1">
			<p className="px-2 pb-1 font-medium text-foreground/60 text-xs">
				{t("organizations.restore.recentlyDeleted")}
			</p>
			{organizations.map((organization) => (
				<div
					key={organization.id}
					className="flex items-center gap-2 rounded-md px-2 py-1.5"
				>
					<div className="min-w-0 flex-1">
						<p className="truncate text-muted-foreground text-sm">
							{organization.name}
						</p>
						<p className="text-highlight text-xs">
							{t("organizations.restore.daysRemaining", {
								days: organization.daysRemaining ?? 0,
							})}
						</p>
					</div>
					<Button
						variant="ghost"
						size="sm"
						loading={restore.isPending}
						onClick={() => restore.mutate(organization.id)}
					>
						{t("organizations.restore.action")}
					</Button>
				</div>
			))}
		</div>
	);
}
