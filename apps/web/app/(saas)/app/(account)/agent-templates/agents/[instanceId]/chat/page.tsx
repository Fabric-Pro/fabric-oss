import { getInstanceWithTemplate, getTemplateWorkflow } from "@repo/database";
import { WorkflowTemplateChat } from "@saas/agents/components/WorkflowTemplateChat";
import { getSession } from "@saas/auth/lib/server";
import { redirect } from "next/navigation";

type Props = {
	params: Promise<{
		instanceId: string;
	}>;
	searchParams: Promise<{
		projectId?: string;
	}>;
};

export const metadata = {
	title: "Agent Chat - Fabric",
	description: "Chat with your agent",
};

export default async function AgentChatPage({ params, searchParams }: Props) {
	const session = await getSession();
	const { instanceId } = await params;
	const { projectId } = await searchParams;

	if (!session) {
		redirect("/auth/login");
	}

	const userId = session.user.id;

	// Get instance with template (personal context - organizationId = null)
	const instance = await getInstanceWithTemplate(instanceId, userId, null);

	if (!instance) {
		// Redirect to main page, not /agents which would match [slug] route
		redirect("/app/agent-templates");
	}

	// Check if template has a dedicated workflow
	const workflowConfig = getTemplateWorkflow(instance.template.slug);

	if (!workflowConfig) {
		// No dedicated workflow - redirect to Orchestrator with agent config
		redirect(`/app/agents/fabric-ai?mode=agent&instanceId=${instanceId}`);
	}

	// Deep Researcher is now a built-in Nexus mode — redirect there
	if (instance.template.slug === "deep-researcher") {
		redirect("/app/agents/fabric-ai?mode=research");
	}

	// Other workflow templates - use WorkflowTemplateChat
	return (
		<div className="h-[calc(100vh-3.5rem)]">
			<WorkflowTemplateChat
				templateSlug={instance.template.slug}
				instanceId={instance.id}
				instanceName={instance.name}
				instanceDescription={instance.description ?? undefined}
				organizationId={null}
				projectId={projectId}
				backUrl="/app/agent-templates?tab=agents"
				starterMessages={
					Array.isArray(
						(
							instance.customInstructions as Record<
								string,
								unknown
							> | null
						)?.starterMessages,
					)
						? ((
								instance.customInstructions as Record<
									string,
									unknown
								>
							).starterMessages as Array<{
								label: string;
								emoji?: string;
								prompt: string;
							}>)
						: undefined
				}
			/>
		</div>
	);
}
