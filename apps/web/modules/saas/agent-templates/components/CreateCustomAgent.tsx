"use client";

/**
 * Create Custom Agent Component
 * Allows users to create an agent from scratch without a template
 */

import { CreateAgentPage } from "./CreateAgentPage";

type Props = {
	organizationId?: string;
	basePath?: string;
};

// Empty template for custom agent creation
const EMPTY_TEMPLATE = {
	id: "custom",
	slug: "custom",
	name: "custom-agent",
	displayName: "Custom Agent",
	description: "A custom AI agent tailored to your specific needs",
	heroEmojis: ["🤖", "✨", "🔧"],
	category: "GENERAL",
	suggestedModel: null,
	instructions: "",
};

export function CreateCustomAgent({
	organizationId,
	basePath = "/app/agent-templates",
}: Props) {
	return (
		<CreateAgentPage
			template={EMPTY_TEMPLATE}
			organizationId={organizationId}
			basePath={basePath}
			isCustomAgent
		/>
	);
}
