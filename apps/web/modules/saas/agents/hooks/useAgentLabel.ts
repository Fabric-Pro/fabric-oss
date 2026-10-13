import { useTranslations } from "next-intl";
import { useCallback } from "react";

type SystemAgentLabelKey = "fabricAi" | "projectSetup";

/**
 * Agent ids that name a system run rather than an agent a person picked.
 * `project_setup` is the AgentTask row of a project setup run.
 */
const SYSTEM_AGENT_LABEL_KEYS: Record<string, SystemAgentLabelKey> = {
	orchestrator: "fabricAi",
	"fabric-ai": "fabricAi",
	fabric_ai: "fabricAi",
	project_setup: "projectSetup",
};

/** A readable name for an `AgentTask.agentId` / conversation agent id. */
export function useAgentLabel(): (agentId: string) => string {
	const t = useTranslations("app.agentLabels");
	return useCallback(
		(agentId: string) => {
			const key = SYSTEM_AGENT_LABEL_KEYS[agentId];
			if (key) {
				return t(key);
			}
			return agentId
				.replace(/[-_]/g, " ")
				.replace(/\b\w/g, (letter) => letter.toUpperCase());
		},
		[t],
	);
}
