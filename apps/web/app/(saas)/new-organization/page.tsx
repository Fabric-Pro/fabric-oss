import { config } from "@repo/config";
import { getOrganizationList } from "@saas/auth/lib/server";
import { CreateOrganizationForm } from "@saas/organizations/components/CreateOrganizationForm";
import { RestorableOrganizations } from "@saas/organizations/components/RestorableOrganizations";
import { AuthWrapper } from "@saas/shared/components/AuthWrapper";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function NewOrganizationPage() {
	const organizations = await getOrganizationList();

	if (
		!config.organizations.enable ||
		(!config.organizations.enableUsersToCreateOrganizations &&
			(!config.organizations.requireOrganization ||
				organizations.length > 0))
	) {
		redirect("/app");
	}

	return (
		<AuthWrapper>
			{/*
			 * Deleting your LAST organization redirects here (see
			 * app/layout.tsx). Without this banner that redirect is a dead end:
			 * a page offering to create something new, during the exact seven
			 * days when the thing you just deleted can still be brought back
			 * (Fizzy #2462).
			 */}
			<div className="flex flex-col gap-6">
				<RestorableOrganizations variant="banner" />
				<CreateOrganizationForm />
			</div>
		</AuthWrapper>
	);
}
