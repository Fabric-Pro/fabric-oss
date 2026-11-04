"use client";

import { useOptionalFabricAgentLauncher } from "@saas/agents/components/FabricAgentLauncher";
import { FrameDetailView } from "@saas/frames/components/FrameDetailView";
import { useFrameAgentContext } from "@saas/frames/hooks/use-frame-agent-context";
import {
	agentContextOfFrame,
	FrameDetailSchema,
	shareScopeSentence,
} from "@saas/frames/lib/frame-tool-types";
import { useFabricToolQuery } from "@saas/mcp/lib/fabric-tool-client";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { ArrowLeftIcon, HistoryIcon, SparklesIcon } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { PageComments } from "./PageComments";
import { PageCopyButton } from "./PageCopyButton";
import { PageDeleteMenu } from "./PageDeleteMenu";
import { PageHistorySheet } from "./PageHistorySheet";

const CHANGE_PAGE_PROMPT = "Change this page: ";

/** How often the open page checks for a change while Fabric Agent is open. */
const AGENT_OPEN_REFRESH_MS = 5_000;

/**
 * One Page: a page Fabric Agent wrote, in the sandboxed viewer, with the
 * few things around it that are ours - its title, Fabric Agent, who it is shared
 * with, its earlier versions, a copy of it for the reader to change, and what
 * people have said about it. Nothing inside the page is ours. The page is read
 * through Fabric's own tools, and its script reaches Fabric only through the
 * runtime the viewer gives it, as the person looking at it. The viewer's header
 * holds the one Share control, which only the author sees.
 */
export function PageView({
	frameId,
	organizationId,
	organizationSlug,
}: {
	frameId: string;
	organizationId: string;
	organizationSlug: string;
}) {
	const queryClient = useQueryClient();
	const agentOpen = useOptionalFabricAgentLauncher()?.isOpen ?? false;
	const [historyOpen, setHistoryOpen] = useState(false);

	const detail = useFabricToolQuery(
		"fabric_get_frame",
		{ frameId },
		{
			schema: FrameDetailSchema,
			// The page changes when the agent changes it, so while the agent is open
			// it is checked often enough that the change shows without a reload.
			refetchInterval: agentOpen ? AGENT_OPEN_REFRESH_MS : false,
		},
	);
	const frame = detail.data;

	const openAgent = useFrameAgentContext(
		agentContextOfFrame({
			frameId,
			surface: "workspace",
			projectId: frame?.projectId,
		}),
	);

	const refreshPage = () =>
		queryClient.invalidateQueries({ queryKey: ["fabric-tool"] });

	return (
		<div className="space-y-6">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<Button variant="ghost" size="sm" asChild>
					<Link href={`/app/${organizationSlug}/pages`}>
						<ArrowLeftIcon className="mr-2 size-4" aria-hidden />
						All pages
					</Link>
				</Button>
				{frame ? (
					<div className="flex flex-wrap items-center gap-2">
						{frame.ownedByCaller ? (
							<>
								<Button
									variant="outline"
									size="sm"
									onClick={() => setHistoryOpen(true)}
								>
									<HistoryIcon
										className="mr-2 size-4"
										aria-hidden
									/>
									Version history
								</Button>
								<PageDeleteMenu
									frameId={frame.frameId}
									title={frame.title}
									organizationId={organizationId}
									organizationSlug={organizationSlug}
								/>
							</>
						) : null}
						<PageCopyButton
							frameId={frame.frameId}
							organizationId={organizationId}
							organizationSlug={organizationSlug}
							projectId={frame.projectId}
							runtimeTools={frame.runtimeTools}
						/>
						{openAgent ? (
							<Button
								size="sm"
								onClick={() => openAgent(CHANGE_PAGE_PROMPT)}
							>
								<SparklesIcon
									className="mr-2 size-4"
									aria-hidden
								/>
								Ask Fabric Agent
							</Button>
						) : null}
					</div>
				) : null}
			</div>

			{frame?.shareScope ? (
				<p
					data-testid="page-sharing"
					className="text-sm text-muted-foreground"
				>
					{shareScopeSentence(
						frame.shareScope,
						frame.ownedByCaller === true,
						Boolean(frame.projectId),
					)}
				</p>
			) : null}

			<FrameDetailView
				detail={detail}
				surface="workspace"
				organizationId={organizationId}
				organizationSlug={organizationSlug}
				onOpenAgent={openAgent}
				canManageSharing={frame?.ownedByCaller === true}
				onSharingChanged={refreshPage}
			/>

			{frame ? (
				<PageComments
					frameId={frame.frameId}
					organizationId={organizationId}
				/>
			) : null}

			{frame?.ownedByCaller ? (
				<PageHistorySheet
					frameId={frame.frameId}
					organizationId={organizationId}
					open={historyOpen}
					onOpenChange={setHistoryOpen}
					onRestored={() => {
						setHistoryOpen(false);
						refreshPage();
					}}
				/>
			) : null}
		</div>
	);
}
