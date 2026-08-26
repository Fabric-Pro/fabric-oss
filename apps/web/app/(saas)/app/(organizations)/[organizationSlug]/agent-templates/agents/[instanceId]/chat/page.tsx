import {
	getInstanceWithTemplate,
	getOrganizationBySlug,
	getOrganizationMembership,
	getTemplateWorkflow,
} from "@repo/database";
import { WorkflowTemplateChat } from "@saas/agents/components/WorkflowTemplateChat";
import { getSession } from "@saas/auth/lib/server";
import { redirect } from "next/navigation";

type Props = {
	params: Promise<{
		organizationSlug: string;
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
	const { organizationSlug, instanceId } = await params;
	const { projectId } = await searchParams;

	if (!session) {
		redirect("/auth/login");
	}

	const userId = session.user.id;

	// Get organization ID from slug
	const organization = await getOrganizationBySlug(organizationSlug);
	if (!organization) {
		redirect(`/app/${organizationSlug}/agent-templates?tab=agents`);
	}

	// Verify user is a member of this organization
	const membership = await getOrganizationMembership(organization.id, userId);
	if (!membership) {
		redirect("/app");
	}

	const organizationId = organization.id;
	const basePath = `/app/${organizationSlug}/agent-templates`;

	// Get instance with template (organization context)
	const instance = await getInstanceWithTemplate(
		instanceId,
		userId,
		organizationId,
	);

	if (!instance) {
		redirect(`${basePath}?tab=agents`);
	}

	// Check if template has a dedicated workflow
	const workflowConfig = getTemplateWorkflow(instance.template.slug);

	if (!workflowConfig) {
		// No dedicated workflow - redirect to Orchestrator with agent config
		redirect(
			`/app/${organizationSlug}/agents/fabric-ai?mode=agent&instanceId=${instanceId}`,
		);
	}

	// Deep Researcher is now a built-in Nexus mode — redirect there
	if (instance.template.slug === "deep-researcher") {
		redirect(`/app/${organizationSlug}/agents/fabric-ai?mode=research`);
	}

	// Other workflow templates - use WorkflowTemplateChat
	return (
		<div className="h-[calc(100vh-3.5rem)]">
			<WorkflowTemplateChat
				templateSlug={instance.template.slug}
				instanceId={instance.id}
				instanceName={instance.name}
				instanceDescription={instance.description ?? undefined}
				organizationId={organizationId}
				projectId={projectId}
				backUrl={`${basePath}?tab=agents`}
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
