import { DataConnectionProviderSchema } from "@repo/database";
import { redirect } from "next/navigation";

type Props = {
	params: Promise<{ organizationSlug: string; provider: string }>;
};

export default async function OrgAddIntegrationProviderSettingsPage({
	params,
}: Props) {
	const { organizationSlug, provider } = await params;
	const parsed = DataConnectionProviderSchema.safeParse(provider);

	if (!parsed.success) {
		redirect(`/app/${organizationSlug}/settings/integrations`);
	}

	redirect(
		`/app/${organizationSlug}/settings/integrations/providers/${parsed.data}`,
	);
}
