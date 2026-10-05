"use client";

import { useEffectiveOrganizationId } from "@saas/organizations/hooks/use-organization-context";
import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";

/** Identity only: resolving versions must never replace the conversation's instance. */
export function AgentVersionIdentity({
	name,
	instanceId,
	organizationId: providedOrganizationId,
}: {
	name?: string;
	instanceId?: string;
	organizationId?: string | null;
}) {
	const organizationId = useEffectiveOrganizationId(providedOrganizationId);
	const pinnedQuery = useQuery({
		queryKey: [
			...orpc.agentTemplates.instances.key(),
			"chat-agent-version",
			organizationId,
			instanceId,
		],
		queryFn: async () => {
			if (!instanceId || !organizationId) {
				throw new Error("No agent instance selected.");
			}
			const { instance } = await orpcClient.agentTemplates.instances.get({
				id: instanceId,
			});
			if (
				instance.id !== instanceId ||
				instance.organizationId !== organizationId
			) {
				throw new Error(
					"The agent is not available in this organization.",
				);
			}
			return {
				name: instance.name,
				sId: instance.sId,
				version: instance.version,
			};
		},
		enabled: Boolean(instanceId && organizationId),
		retry: false,
		staleTime: 30_000,
	});
	// Ignore retained data after a failed authorized refresh.
	const pinned = pinnedQuery.isSuccess ? pinnedQuery.data : undefined;
	const activeQuery = useQuery({
		queryKey: [
			...orpc.agentTemplates.instances.key(),
			"chat-agent-active-version",
			organizationId,
			pinned?.sId,
		],
		queryFn: async () => {
			if (!pinned?.sId || !organizationId) {
				throw new Error("No agent version selected.");
			}
			const { instance } = await orpcClient.agentTemplates.instances.get({
				sId: pinned.sId,
			});
			if (
				!instance ||
				instance.organizationId !== organizationId ||
				instance.sId !== pinned.sId ||
				instance.status !== "ACTIVE"
			) {
				return null;
			}
			return instance.version;
		},
		enabled: Boolean(pinned?.sId && organizationId),
		retry: false,
		staleTime: 30_000,
	});
	const newer =
		pinned &&
		activeQuery.isSuccess &&
		activeQuery.data != null &&
		activeQuery.data > pinned.version;
	return (
		<>
			{pinned?.name ?? name}
			{pinned ? ` · v${pinned.version}` : ""}
			{newer && (
				<span className="text-muted-foreground">
					{" "}
					· Newer version available (v{activeQuery.data})
				</span>
			)}
		</>
	);
}
