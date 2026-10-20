import {
	buildExternalPmTarget,
	type PmTargetConfig,
} from "@repo/utils/pm-target";
import { mcpConfigPmInstanceOrigin } from "./pm-link-instance";
import { resolveStoryPmLinkConfig } from "./story-pm-link-config";

/** Resolve identity in an activity, using the config dispatched by that activity. */
export async function resolveExternalPmTarget(input: {
	projectId: string;
	mcpServerId?: string | null;
	mcpConfigId?: string | null;
	userId: string;
	organizationId?: string;
	containerId?: string | null;
	/** Explicit project identity; older ADO payloads may carry only a display name. */
	stableContainerId?: string | null;
	additionalContext?: unknown;
	config?: PmTargetConfig | null;
	pmTool?: string | null;
	instanceOrigin?: string | null;
}): Promise<string | null> {
	try {
		if (
			!input.mcpServerId ||
			input.mcpServerId.startsWith("key:") ||
			(!input.containerId && !input.stableContainerId)
		) {
			return null;
		}
		const build = (
			config?: PmTargetConfig | null,
			instanceOrigin?: string | null,
		) => {
			const ado =
				input.pmTool === "ado" ||
				input.pmTool === "azure-devops" ||
				config?.mcpServer?.key === "azure-devops";
			return buildExternalPmTarget({
				...input,
				config,
				instanceOrigin: input.instanceOrigin ?? instanceOrigin,
				containerId: ado
					? input.stableContainerId
					: (input.stableContainerId ?? input.containerId),
			});
		};
		// REST calls can resolve their identity without an MCP config.
		if (!input.config && !input.mcpConfigId && input.pmTool) {
			return build();
		}
		const resolved = input.config
			? null
			: await resolveStoryPmLinkConfig({
					...input,
					mcpConfigId: input.mcpConfigId ?? null,
					mcpServerId: input.mcpServerId,
				});
		const config = input.config ?? resolved?.config;
		return build(
			config,
			resolved?.instanceOrigin ?? mcpConfigPmInstanceOrigin(config),
		);
	} catch {
		// Target metadata is optional; failure to resolve it preserves the legacy guard.
		return null;
	}
}
