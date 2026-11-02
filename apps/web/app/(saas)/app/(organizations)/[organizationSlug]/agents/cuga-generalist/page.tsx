import { RetiredAgentNotice } from "@saas/agents/components/RetiredAgentNotice";

export default async function RetiredCugaPage({
	params,
}: {
	params: Promise<{ organizationSlug: string }>;
}) {
	const { organizationSlug } = await params;
	return <RetiredAgentNotice basePath={`/app/${organizationSlug}`} />;
}
