import { getActiveOrganization } from "@saas/auth/lib/server";
import { redirect } from "next/navigation";

export default async function ChatbotPage({
	params,
}: {
	params: Promise<{ organizationSlug: string }>;
}) {
	const { organizationSlug } = await params;
	const organization = await getActiveOrganization(organizationSlug);

	if (!organization) {
		redirect("/app");
	}

	redirect(`/app/${organizationSlug}/nexus`);
}
