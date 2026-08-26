import { db } from "@repo/database";
import { AgentMemoryPanel } from "@saas/agent-templates/components/AgentMemoryPanel";
import { getSession } from "@saas/auth/lib/server";
import { PageBreadcrumbs } from "@saas/shared/components/PageBreadcrumbs";
import { TopRightControls } from "@saas/shared/components/TopRightControls";
import { redirect } from "next/navigation";

type Props = {
	params: Promise<{
		instanceId: string;
	}>;
};

export const metadata = {
	title: "Agent Memory - Fabric",
	description: "Manage agent memory files and pending edits",
};

export default async function AgentMemoryPage({ params }: Props) {
	const session = await getSession();
	const { instanceId } = await params;

	if (!session) {
		redirect("/auth/login");
	}

	// Get the instance to find its templateId
	const instance = await db.agentTemplateInstance.findFirst({
		where: {
			id: instanceId,
			userId: session.user.id,
			organizationId: null,
		},
		select: { templateId: true },
	});

	return (
		<div className="w-full py-6 space-y-6">
			<TopRightControls />
			<PageBreadcrumbs
				items={[
					{ label: "Agent Templates", href: "/app/agent-templates" },
					{ label: "My Agents", href: "/app/agent-templates" },
					{
						label: "Agent Details",
						href: `/app/agent-templates/agents/${instanceId}`,
					},
					{ label: "Memory" },
				]}
			/>
			<div className="h-[calc(100vh-220px)]">
				<AgentMemoryPanel
					instanceId={instanceId}
					templateId={instance?.templateId}
				/>
			</div>
		</div>
	);
}
