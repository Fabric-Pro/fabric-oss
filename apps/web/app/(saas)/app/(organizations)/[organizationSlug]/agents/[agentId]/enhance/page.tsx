"use client";

/**
 * Organization Prompt Enhancer Agent Try Page
 *
 * Uses the same PromptContentEnhancer component as the prompts enhance page
 * but without loading from database - user enters their own prompt to enhance.
 */

import { CopilotKit } from "@copilotkit/react-core";
import {
	AI_SIDEBAR_CONTENT_SHIFT_CLASS,
	useAiSidebarExpanded,
} from "@saas/shared/components/copilot/ai-sidebar-layout";
import { CopilotChatSessionProvider } from "@saas/shared/components/copilot/CopilotChatSessionProvider";
import { useCopilotErrorHandler } from "@saas/shared/components/copilot/use-copilot-error-handler";
import { useFullscreen } from "@saas/shared/contexts/FullscreenContext";
import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import "@copilotkit/react-ui/styles.css";
import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { PromptContentEnhancer } from "@saas/prompts/components/PromptContentEnhancer";
import { Spinner } from "@shared/components/Spinner";
import { Alert, AlertDescription, AlertTitle } from "@ui/components/alert";
import {
	Breadcrumb,
	BreadcrumbItem,
	BreadcrumbLink,
	BreadcrumbList,
	BreadcrumbPage,
	BreadcrumbSeparator,
} from "@ui/components/breadcrumb";
import { Button } from "@ui/components/button";
import { AlertCircle, HomeIcon } from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";

export default function OrganizationPromptEnhancerAgentPage() {
	const params = useParams();
	const router = useRouter();
	const agentId = params.agentId as string;
	const [_enhancedContent, setEnhancedContent] = useState<string | null>(
		null,
	);
	const { basePath } = useOrganizationContext();
	const onError = useCopilotErrorHandler();

	// A full-bleed CopilotSidebar host: collapse the app sidebar to its rail and
	// reserve the docked assistant panel's width (it mounts `defaultOpen`). See
	// docs/solutions/ui-bugs/copilotkit-sidebar-editor-overlap.md.
	const { setIsFullscreen } = useFullscreen();
	useEffect(() => {
		setIsFullscreen(true);
		return () => setIsFullscreen(false);
	}, [setIsFullscreen]);
	const isAiSidebarExpanded = useAiSidebarExpanded(true);

	// Organization-aware paths
	const agentsPath = `${basePath}/agents`;

	// Fetch agent details
	const {
		data: agent,
		isLoading: isLoadingAgent,
		error: agentError,
	} = useQuery({
		queryKey: ["agent", "registry", agentId],
		queryFn: async () => {
			const result = await orpcClient.agents.registry.get({
				id: agentId,
			});
			return result;
		},
		retry: false,
	});

	if (isLoadingAgent) {
		return (
			<div className="flex items-center justify-center min-h-[400px]">
				<Spinner className="mr-2 size-4 text-primary" />
				<span className="text-sm text-muted-foreground">
					Loading...
				</span>
			</div>
		);
	}

	if (agentError || !agent) {
		return (
			<div className="container py-8">
				<Alert variant="error">
					<AlertCircle className="h-4 w-4" />
					<AlertTitle>Error</AlertTitle>
					<AlertDescription>
						{agentError instanceof Error
							? agentError.message
							: "Agent not found"}
					</AlertDescription>
				</Alert>
				<div className="mt-4">
					<Button
						variant="outline"
						onClick={() => router.push(agentsPath)}
					>
						Back to Agents
					</Button>
				</div>
			</div>
		);
	}

	const handleSave = (content: string) => {
		setEnhancedContent(content);
		toast.success("Prompt enhanced!", {
			description:
				"Your enhanced prompt has been saved. You can copy it from the editor.",
		});
	};

	const handleCancel = () => {
		router.push(`${agentsPath}/${agentId}`);
	};

	return (
		<div
			className={`fixed inset-y-0 left-0 right-0 md:left-[72px] bg-background flex flex-col transition-[right] duration-300 ${
				isAiSidebarExpanded ? AI_SIDEBAR_CONTENT_SHIFT_CLASS : ""
			}`}
		>
			{/* Breadcrumbs - Compact header. Scrolls within the reserved column
			    rather than spilling under the assistant panel. */}
			<div className="flex min-w-0 shrink-0 items-center gap-3 overflow-x-auto border-b bg-background px-6 py-2.5">
				<Button
					variant="ghost"
					size="icon"
					className="shrink-0"
					asChild
					title="Go to home"
				>
					<Link href={basePath}>
						<HomeIcon className="size-4" />
					</Link>
				</Button>
				<Breadcrumb>
					<BreadcrumbList>
						<BreadcrumbItem>
							<BreadcrumbLink
								href={agentsPath}
								className="text-sm"
							>
								Agents
							</BreadcrumbLink>
						</BreadcrumbItem>
						<BreadcrumbSeparator />
						<BreadcrumbItem>
							<BreadcrumbLink
								href={`${agentsPath}/${agentId}`}
								className="text-sm"
							>
								{agent.displayName}
							</BreadcrumbLink>
						</BreadcrumbItem>
						<BreadcrumbSeparator />
						<BreadcrumbItem>
							<BreadcrumbPage className="text-sm">
								Try Agent
							</BreadcrumbPage>
						</BreadcrumbItem>
					</BreadcrumbList>
				</Breadcrumb>
			</div>

			{/* Content Enhancer with CopilotKit - fills the rest of the column.
			    The direct-child selectors give CopilotKit's injected wrappers a
			    definite height, so the enhancer's `h-full` resolves. */}
			<div className="flex-1 min-h-0 overflow-hidden [&>.copilotKitSidebarContentWrapper]:h-full [&>.copilotKitSidebarContentWrapper>.copilotKitModalChildrenWrapper]:h-full">
				<CopilotKit
					runtimeUrl="/api/copilotkit"
					useSingleEndpoint
					agent="prompt_enhancer"
					showDevConsole={false}
					onError={onError}
				>
					<CopilotChatSessionProvider>
						<PromptContentEnhancer
							promptId="try-agent"
							promptName="Try Prompt Enhancer"
							promptDescription="Enter a prompt below and use the AI assistant to enhance it"
							format="MARKDOWN"
							category="general"
							tags={["enhancement", "ai"]}
							initialContent=""
							onSave={handleSave}
							onCancel={handleCancel}
							isLoading={false}
							showTitle={true}
						/>
					</CopilotChatSessionProvider>
				</CopilotKit>
			</div>
		</div>
	);
}
