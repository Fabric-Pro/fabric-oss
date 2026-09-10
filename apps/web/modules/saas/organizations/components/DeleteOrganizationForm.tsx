"use client";

import { useActiveOrganization } from "@saas/organizations/hooks/use-active-organization";
import { useConfirmationAlert } from "@saas/shared/components/ConfirmationAlertProvider";
import { SettingsItem } from "@saas/shared/components/SettingsItem";
import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

/**
 * Deleting an organization (Fizzy #2462).
 *
 * Two proofs stand between the button and the deletion, and they prove
 * different things:
 *
 *  - typing the organization's name proves the person knows WHICH organization
 *    they are destroying, which is the mistake this card exists to prevent;
 *  - the emailed link proves it is THEM, which an unlocked laptop otherwise
 *    does not.
 *
 * Neither is the password this screen used to promise. That sentence has been in
 * the copy since the screen shipped and no field was ever rendered — and it
 * could not be, because magic-link and social accounts have no password, so a
 * password gate would lock those owners out of deleting their own organization.
 */
export function DeleteOrganizationForm() {
	const t = useTranslations();
	const { confirm } = useConfirmationAlert();
	const { activeOrganization } = useActiveOrganization();

	// Advisory, never a gate. If this rejects the dialog still opens and
	// deletion still proceeds — see `impactLabel` below. A failed count must
	// never trap someone inside an organization they want gone.
	const { data: impact, isError: impactFailed } = useQuery({
		queryKey: ["organization-deletion-impact", activeOrganization?.id],
		queryFn: () => orpcClient.organizations.deletion.impact({}),
		enabled: !!activeOrganization,
		retry: false,
	});

	if (!activeOrganization) {
		return null;
	}

	const impactLabel = impactFailed
		? t("organizations.settings.deleteOrganization.impactUnavailable")
		: impact
			? t("organizations.settings.deleteOrganization.impact", {
					projects: impact.projects,
					members: impact.members,
					documents: impact.documents,
					contexts: impact.contexts,
				})
			: null;

	const handleDelete = () => {
		confirm({
			title: t("organizations.settings.deleteOrganization.title"),
			message: [
				t("organizations.settings.deleteOrganization.confirmation", {
					organizationName: activeOrganization.name,
				}),
				impactLabel,
			]
				.filter(Boolean)
				.join("\n\n"),
			confirmLabel: t("organizations.settings.deleteOrganization.submit"),
			destructive: true,
			requireTypedConfirmation: {
				expected: activeOrganization.name,
				label: t(
					"organizations.settings.deleteOrganization.typeToConfirm",
					{ organizationName: activeOrganization.name },
				),
			},
			onConfirm: async () => {
				try {
					const result =
						await orpcClient.organizations.deletion.request({
							typedOrganizationName: activeOrganization.name,
						});

					// Nothing has been deleted at this point, and the copy has
					// to say so — someone who closes the tab here still has
					// their organization.
					toast.success(
						t(
							"organizations.settings.deleteOrganization.confirmationSent",
							{ email: result.sentTo },
						),
					);
				} catch {
					toast.error(
						t(
							"organizations.settings.notifications.organizationNotDeleted",
						),
					);
				}
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
