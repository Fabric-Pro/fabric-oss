"use client";

import { CopilotKit } from "@copilotkit/react-core";
import "@copilotkit/react-ui/styles.css";
import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { useCopilotErrorHandler } from "@saas/shared/components/copilot/use-copilot-error-handler";
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
import { toast } from "sonner";
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

	const { data: prompt, isLoading } = useQuery(
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

	if (!prompt) {
		return (
			<div className="flex flex-col items-center justify-center py-12">
				<p className="text-muted-foreground mb-4">Prompt not found</p>
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
		<div className="fixed inset-0 bg-background">
			{/* Breadcrumbs - Compact header */}
			<div className="flex items-center gap-3 px-6 py-2.5 border-b bg-background">
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

			{/* Content Enhancer with CopilotKit - Full height */}
			<div className="h-[calc(100vh-53px)]">
				<CopilotKit
					runtimeUrl={
						organizationId
							? `/api/copilotkit?organizationId=${organizationId}`
							: "/api/copilotkit"
					}
					agent="prompt_enhancer"
					showDevConsole={false}
					onError={onError}
				>
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
				</CopilotKit>
			</div>
		</div>
	);
}
