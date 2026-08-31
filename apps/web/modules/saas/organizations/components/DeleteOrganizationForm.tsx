"use client";

import { authClient } from "@repo/auth/client";
import { useActiveOrganization } from "@saas/organizations/hooks/use-active-organization";
import { useOrganizationListQuery } from "@saas/organizations/lib/api";
import { useConfirmationAlert } from "@saas/shared/components/ConfirmationAlertProvider";
import { SettingsItem } from "@saas/shared/components/SettingsItem";
import { useRouter } from "@shared/hooks/router";
import { Button } from "@ui/components/button";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

export function DeleteOrganizationForm() {
	const t = useTranslations();
	const router = useRouter();
	const { confirm } = useConfirmationAlert();
	const { refetch: reloadOrganizations } = useOrganizationListQuery();
	const { activeOrganization, setActiveOrganization } =
		useActiveOrganization();

	if (!activeOrganization) {
		return null;
	}

	const handleDelete = async () => {
		confirm({
			title: t("organizations.settings.deleteOrganization.title"),
			message: t(
				"organizations.settings.deleteOrganization.confirmation",
			),
			destructive: true,
			onConfirm: async () => {
				const { error } = await authClient.organization.delete({
					organizationId: activeOrganization.id,
				});

				if (error) {
					toast.error(
						t(
							"organizations.settings.notifications.organizationNotDeleted",
						),
					);
					return;
				}

				toast.success(
					t(
						"organizations.settings.notifications.organizationDeleted",
					),
				);
				// Clears the organization that no longer exists from the
				// session — not a return to personal context, which is gone.
				// `/app` then routes on membership: another organization if
				// they have one, the creation page if this was their last.
				await setActiveOrganization(null);
				await reloadOrganizations();
				router.replace("/app");
			},
		});
	};

	return (
		<SettingsItem
			danger
			title={t("organizations.settings.deleteOrganization.title")}
			description={t(
				"organizations.settings.deleteOrganization.description",
			)}
		>
			<div className="mt-4 flex justify-end">
				<Button variant="error" onClick={handleDelete}>
					{t("organizations.settings.deleteOrganization.submit")}
				</Button>
			</div>
		</SettingsItem>
	);
}
