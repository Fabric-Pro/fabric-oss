"use client";

import { CopilotKit } from "@copilotkit/react-core";
import "@copilotkit/react-ui/styles.css";
import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import {
	AI_SIDEBAR_CONTENT_SHIFT_CLASS,
	useAiSidebarExpanded,
} from "@saas/shared/components/copilot/ai-sidebar-layout";
import { CopilotChatSessionProvider } from "@saas/shared/components/copilot/CopilotChatSessionProvider";
import { useCopilotErrorHandler } from "@saas/shared/components/copilot/use-copilot-error-handler";
import { useFullscreen } from "@saas/shared/contexts/FullscreenContext";
import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	Breadcrumb,
	BreadcrumbItem,
	BreadcrumbLink,
	BreadcrumbList,
	BreadcrumbPage,
	BreadcrumbSeparator,
} from "@ui/components/breadcrumb";
import { Button } from "@ui/components/button";
import { Skeleton } from "@ui/components/skeleton";
import { HomeIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { toast } from "sonner";
import { isPromptInaccessible } from "../lib/prompt-inaccessible";
import { LoadFailure } from "./LoadFailure";
import { PromptContentEnhancer } from "./PromptContentEnhancer";

type Props = {
	promptId: string;
	organizationId?: string;
};

export function PromptEnhancePage({ promptId, organizationId }: Props) {
	const router = useRouter();
	const { basePath } = useOrganizationContext();
	const queryClient = useQueryClient();
	const onError = useCopilotErrorHandler();

	// A full-bleed CopilotSidebar host, like the document and story editors:
	// collapse the app sidebar to its rail, and reserve the docked assistant
	// panel's width (it mounts `defaultOpen`). Without both, the fixed page sat
	// under the sidebar on the left and under the panel on the right, hiding the
	// title and the inline reason Save is disabled. See
	// docs/solutions/ui-bugs/copilotkit-sidebar-editor-overlap.md.
	const { setIsFullscreen } = useFullscreen();
	useEffect(() => {
		setIsFullscreen(true);
		return () => setIsFullscreen(false);
	}, [setIsFullscreen]);
	const isAiSidebarExpanded = useAiSidebarExpanded(true);

	const {
		data: prompt,
		isLoading,
		error,
		refetch,
	} = useQuery(
		orpc.prompts.get.byId.queryOptions({
			input: { id: promptId, organizationId: organizationId ?? null },
		}),
	);

	const promptQueryKey = orpc.prompts.get.byId.queryKey({
		input: { id: promptId, organizationId: organizationId ?? null },
	});

	const updateContentMutation = useMutation({
		mutationFn: async (content: string) => {
			// Create a new prompt version with updated content
			return await orpcClient.prompts.version.create({
				id: promptId,
				content,
			});
		},
		onMutate: async (content) => {
			// Cancel any outgoing refetches
			await queryClient.cancelQueries({ queryKey: promptQueryKey });

			// Snapshot the previous value
			const previousData = queryClient.getQueryData(promptQueryKey);

			// Optimistically update the cache
			queryClient.setQueryData(promptQueryKey, (old: any) => {
				if (!old?.prompt) {
					return old;
				}

				// Get the latest version or create a new one
				const latestVersion = old.prompt.versions?.[0];
				const newVersion = {
					...latestVersion,
					content,
					version: (latestVersion?.version ?? 0) + 1,
					createdAt: new Date().toISOString(),
				};

				return {
					...old,
					prompt: {
						...old.prompt,
						versions: [newVersion, ...(old.prompt.versions || [])],
					},
				};
			});

			return { previousData };
		},
		onSuccess: () => {
			toast.success("Prompt content updated successfully");
			// Stay on the enhance page (don't navigate away)
		},
		onError: (error, _content, context) => {
			// Rollback on error
			if (context?.previousData) {
				queryClient.setQueryData(promptQueryKey, context.previousData);
			}
			toast.error("Failed to update prompt content", {
				description:
					error instanceof Error ? error.message : String(error),
			});
		},
		onSettled: () => {
			// Refetch to ensure we have the latest data from server
			queryClient.invalidateQueries({ queryKey: promptQueryKey });
		},
	});

	if (isLoading) {
		return (
			<div className="space-y-6">
				<Skeleton className="h-32 w-full" />
				<Skeleton className="h-96 w-full" />
			</div>
		);
	}

	// Same NOT_FOUND/FORBIDDEN-vs-failure split as PromptDetails: both codes
	// mean the prompt is not there for this caller to see, on purpose, so the
	// copy has to be true for either. Any other error means the read failed,
	// not that the prompt is gone. A failed background refetch keeps the
	// loaded prompt on screen.
	if (error && !prompt) {
		if (isPromptInaccessible(error)) {
			return (
				<div className="flex flex-col items-center justify-center py-12">
					<p className="text-muted-foreground mb-4">
						This prompt does not exist, or you do not have access to
						it.
					</p>
				</div>
			);
		}
		return (
			<div className="flex flex-col items-center justify-center py-12">
				<LoadFailure
					message="Could not load this prompt."
					onRetry={() => refetch()}
				/>
			</div>
		);
	}

	if (!prompt) {
		return (
			<div className="flex flex-col items-center justify-center py-12">
				<p className="text-muted-foreground mb-4">
					This prompt does not exist, or you do not have access to it.
				</p>
			</div>
		);
	}

	const latestVersion = prompt.versions?.[0];

	const handleSave = (content: string) => {
		updateContentMutation.mutate(content);
	};

	const handleCancel = () => {
		router.push(`${basePath}/prompts/${promptId}`);
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
					<Link href="/app">
						<HomeIcon className="size-4" />
					</Link>
				</Button>
				<Breadcrumb>
					<BreadcrumbList>
						<BreadcrumbItem>
							<BreadcrumbLink
								href={`${basePath}/prompts`}
								className="text-sm"
							>
								Prompts
							</BreadcrumbLink>
						</BreadcrumbItem>
						<BreadcrumbSeparator />
						<BreadcrumbItem>
							<BreadcrumbLink
								href={`${basePath}/prompts/${promptId}`}
								className="text-sm"
							>
								{prompt.name}
							</BreadcrumbLink>
						</BreadcrumbItem>
						<BreadcrumbSeparator />
						<BreadcrumbItem>
							<BreadcrumbPage className="text-sm">
								Enhance Content
							</BreadcrumbPage>
						</BreadcrumbItem>
					</BreadcrumbList>
				</Breadcrumb>
			</div>

			{/* Content Enhancer with CopilotKit - fills the rest of the column.
			    The direct-child selectors give the two wrappers CopilotKit
			    injects (`.copilotKitSidebarContentWrapper` and, inside it,
			    `.copilotKitModalChildrenWrapper`) a definite height, so the
			    enhancer's `h-full` resolves instead of collapsing. */}
			<div className="flex-1 min-h-0 overflow-hidden [&>.copilotKitSidebarContentWrapper]:h-full [&>.copilotKitSidebarContentWrapper>.copilotKitModalChildrenWrapper]:h-full">
				<CopilotKit
					runtimeUrl={
						organizationId
							? `/api/copilotkit?organizationId=${organizationId}`
							: "/api/copilotkit"
					}
					useSingleEndpoint
					agent="prompt_enhancer"
					showDevConsole={false}
					onError={onError}
				>
					<CopilotChatSessionProvider>
						<PromptContentEnhancer
							promptId={promptId}
							promptName={prompt.name}
							promptDescription={prompt.description || undefined}
							format={prompt.format as any}
							category={prompt.category || undefined}
							tags={prompt.tags}
							initialContent={latestVersion?.content}
							onSave={handleSave}
							onCancel={handleCancel}
							isLoading={updateContentMutation.isPending}
							showTitle={true}
						/>
					</CopilotChatSessionProvider>
				</CopilotKit>
			</div>
		</div>
	);
}
