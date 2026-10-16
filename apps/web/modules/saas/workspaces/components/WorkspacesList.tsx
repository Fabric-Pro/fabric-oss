"use client";

import { FrameCollection } from "@saas/frames/components/FrameCollection";
import { useFrameAgentContext } from "@saas/frames/hooks/use-frame-agent-context";
import {
	FrameListSchema,
	shareScopeLabel,
} from "@saas/frames/lib/frame-tool-types";
import { useFabricToolQuery } from "@saas/mcp/lib/fabric-tool-client";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { LayoutPanelTopIcon, SparklesIcon } from "lucide-react";
import { WorkspacesHero } from "./WorkspacesHero";

const NEW_WORKSPACE_PROMPT = "Create a new Workspace that shows ";

const WORKSPACE_CONTEXT = { surface: "workspace" } as const;

/**
 * The organization's Workspaces: pages Fabric Agent wrote, which the people of
 * the organization open from here. A new Workspace is shared with the whole
 * organization unless it is asked to stay private. Nothing on a page is built
 * by us, so there is no form for a new one; "New workspace" opens Fabric Agent,
 * and the agent makes the page. The list is read through Fabric's own tools, as
 * an agent reads it.
 */
export function WorkspacesList({
	organizationSlug,
}: {
	organizationSlug: string;
}) {
	const openAgent = useFrameAgentContext(WORKSPACE_CONTEXT);
	const list = useFabricToolQuery(
		"fabric_list_frames",
		{ surface: "workspace" },
		{ schema: FrameListSchema },
	);

	const startWorkspace = openAgent
		? () => openAgent(NEW_WORKSPACE_PROMPT)
		: undefined;

	return (
		<div className="space-y-8">
			<WorkspacesHero
				actions={
					startWorkspace ? (
						<Button
							data-onboarding-target="workspaces-new"
							onClick={startWorkspace}
						>
							<SparklesIcon className="mr-2 size-4" aria-hidden />
							New workspace
						</Button>
					) : undefined
				}
			/>

			<FrameCollection
				query={list}
				cardLabel="Workspace"
				loadingLabel="Loading workspaces"
				errorMessage="The workspaces could not be loaded."
				data-onboarding-target="workspaces-list"
				empty={{
					icon: (
						<LayoutPanelTopIcon className="size-10" aria-hidden />
					),
					title: "No workspaces yet",
					description:
						"Describe the page you want, such as this week's delivery status or a board of open decisions, and Fabric Agent builds it, shares it with your organization and explains what it shows.",
					action: startWorkspace ? (
						<Button onClick={startWorkspace}>
							<SparklesIcon className="mr-2 size-4" aria-hidden />
							New workspace
						</Button>
					) : undefined,
				}}
				cardTarget={(frame) => ({
					href: `/app/${organizationSlug}/workspaces/${frame.frameId}`,
				})}
				cardBadges={(frame) =>
					frame.shareScope ? (
						<Badge variant="outline">
							{shareScopeLabel(frame.shareScope)}
						</Badge>
					) : null
				}
			/>
		</div>
	);
}
