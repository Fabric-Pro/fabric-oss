import { AgentTemplateDetail } from "@saas/agent-templates";
import { getSession } from "@saas/auth/lib/server";
import { PageBreadcrumbs } from "@saas/shared/components/PageBreadcrumbs";
import { TopRightControls } from "@saas/shared/components/TopRightControls";
import { redirect } from "next/navigation";

type Props = {
	params: Promise<{
		slug: string;
	}>;
};

export default async function AgentTemplateDetailPage({ params }: Props) {
	const session = await getSession();
	const { slug } = await params;

	if (!session) {
		redirect("/auth/login");
	}

	return (
		<div className="w-full py-6 space-y-6">
			<TopRightControls />
			<PageBreadcrumbs
				items={[
					{ label: "Agent Templates", href: "/app/agent-templates" },
					{ label: "Template Details" },
				]}
			/>
			<AgentTemplateDetail slug={slug} basePath="/app/agent-templates" />
		</div>
	);
}
