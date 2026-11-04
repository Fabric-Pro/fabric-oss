"use client";
import {
	hasPermission,
	Permissions,
	resolveOrgPermissions,
} from "@repo/permissions";
import { useSession } from "@saas/auth/hooks/use-session";
import { useActiveOrganization } from "@saas/organizations/hooks/use-active-organization";
import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { ActivityIcon } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { AGENT_RUN_POLL_WINDOW_MS } from "../lib/agent-run-polling";

/** One bounded metadata request keeps active work discoverable while drawers are closed. */
export function AgentRunActivityButton({
	organizationId,
	basePath,
}: {
	organizationId: string;
	basePath: string;
}) {
	const { user } = useSession();
	const [pollSince] = useState(Date.now);
	const { activeOrganizationUserRole } = useActiveOrganization();
	const allowed =
		!!activeOrganizationUserRole &&
		hasPermission(
			resolveOrgPermissions(activeOrganizationUserRole),
			Permissions.AGENT_READ,
		);
	const active = useQuery({
		queryKey: ["saved-agent-active", organizationId, user?.id],
		queryFn: () =>
			orpcClient.agentDeployments.runs.search({
				organizationId,
				status: "ACTIVE",
				limit: 1,
			}),
		enabled: allowed && !!user,
		retry: false,
		refetchInterval: (q) =>
			!q.state.error &&
			Date.now() - pollSince < AGENT_RUN_POLL_WINDOW_MS &&
			q.state.data?.executions[0]?.status !== "UNKNOWN"
				? 30000
				: false,
	});
	const run = active.data?.executions[0];
	if (!run) {
		return null;
	}
	return (
		<Button asChild variant="outline" size="sm">
			<Link href={`${basePath}/agents?tab=tasks&runStatus=ACTIVE`}>
				<ActivityIcon className="size-4" />
				{run.status === "UNKNOWN"
					? "Check run status"
					: "Work in progress"}
			</Link>
		</Button>
	);
}
