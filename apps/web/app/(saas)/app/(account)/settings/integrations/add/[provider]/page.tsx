import { DataConnectionProviderSchema } from "@repo/database";
import { redirect } from "next/navigation";

type Props = {
	params: Promise<{ provider: string }>;
};

export default async function AddIntegrationProviderSettingsPage({
	params,
}: Props) {
	const { provider } = await params;
	const parsed = DataConnectionProviderSchema.safeParse(provider);

	if (!parsed.success) {
		redirect("/app/settings/integrations");
	}

	redirect(`/app/settings/integrations/providers/${parsed.data}`);
}
