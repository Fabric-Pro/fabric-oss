import { AgentTemplatesPageTabs } from "@saas/agent-templates";
import { getSession } from "@saas/auth/lib/server";
import { PageBreadcrumbs } from "@saas/shared/components/PageBreadcrumbs";
import { TopRightControls } from "@saas/shared/components/TopRightControls";
import { redirect } from "next/navigation";

export const metadata = {
	title: "Agent Templates - Fabric",
	description: "Pre-built AI agents for every department",
};

type Props = {
	searchParams: Promise<{ tab?: string }>;
};

export default async function AgentTemplatesPage({ searchParams }: Props) {
	const session = await getSession();
	const { tab } = await searchParams;

	if (!session) {
		redirect("/auth/login");
	}

	const defaultTab = tab === "agents" ? "agents" : "gallery";

	return (
		<div className="w-full py-6 space-y-6">
			<TopRightControls />
			<PageBreadcrumbs items={[{ label: "Agent Templates" }]} />
			<AgentTemplatesPageTabs
				basePath="/app/agent-templates"
				defaultTab={defaultTab}
			/>
		</div>
	);
}
