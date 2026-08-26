"use client";

/**
 * ProjectAttachmentPanel - Panel for attaching a project to an orchestrator conversation
 *
 * Features:
 * - List available projects
 * - Attach/detach a project to conversation
 * - Show project context counts, document counts, codebase status
 * - Search/filter projects
 */

import { useEffectiveOrganizationId } from "@saas/organizations/hooks";
import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { SearchInput } from "@ui/components/search-input";
import { Skeleton } from "@ui/components/skeleton";
import { cn } from "@ui/lib";
import { Code2, FileText, FolderKanban, Layers, Search, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

interface ProjectAttachmentPanelProps {
	conversationId: string | null;
	/**
	 * Organization ID for filtering projects.
	 * - `string`: Show projects for this organization
	 * - `null`: Show personal projects only (explicit personal context)
	 * - `undefined`: Use the current organization context
	 */
	organizationId?: string | null;
	/** Called when a project is attached or detached */
	onProjectChange?: (projectId: string | null) => void;
	/** Client-side selected project ID (for pre-conversation state) */
	selectedProjectId?: string | null;
}

export function ProjectAttachmentPanel({
	conversationId,
	organizationId: propOrgId,
	onProjectChange,
	selectedProjectId,
}: ProjectAttachmentPanelProps) {
	const queryClient = useQueryClient();
	const organizationId = useEffectiveOrganizationId(propOrgId);
	const [searchQuery, setSearchQuery] = useState("");

	// Fetch available projects
	const { data: projectsData, isLoading: isLoadingProjects } = useQuery(
		orpc.projects.list.queryOptions({
			input: {
				organizationId,
				limit: 50,
				status: "ACTIVE",
			},
		}),
	);

	// Fetch currently attached project for conversation
	const { data: attachedProjectData, isLoading: isLoadingAttached } =
		useQuery({
			...orpc.projects.conversations.getProject.queryOptions({
				input: {
					conversationId: conversationId || "",
					organizationId,
				},
			}),
			enabled: !!conversationId,
		});

	// Attach project mutation
	const attachMutation = useMutation({
		mutationFn: async (projectId: string) => {
			if (!conversationId) {
				throw new Error("No conversation selected");
			}
			return orpcClient.projects.conversations.attach({
				conversationId,
				projectId,
				organizationId,
			});
		},
		onSuccess: (_data, projectId) => {
			toast.success("Project attached to conversation");
			queryClient.invalidateQueries({
				queryKey: ["projects", "conversations", "getProject"],
			});
			onProjectChange?.(projectId);
		},
		onError: (error) => {
			toast.error(error.message || "Failed to attach project");
		},
	});

	// Detach project mutation
	const detachMutation = useMutation({
		mutationFn: async () => {
			if (!conversationId) {
				throw new Error("No conversation selected");
			}
			return orpcClient.projects.conversations.detach({
				conversationId,
				organizationId,
			});
		},
		onSuccess: () => {
			toast.success("Project detached from conversation");
			queryClient.invalidateQueries({
				queryKey: ["projects", "conversations", "getProject"],
			});
			onProjectChange?.(null);
		},
		onError: (error) => {
			toast.error(error.message || "Failed to detach project");
		},
	});

	const isLoading = isLoadingProjects || isLoadingAttached;

	if (isLoading) {
		return (
			<div className="p-3 space-y-2">
				{[1, 2, 3].map((i) => (
					<Skeleton key={i} className="h-14 w-full rounded-md" />
				))}
			</div>
		);
	}

	const dbAttachedProject = attachedProjectData?.project ?? null;
	const projects = projectsData?.projects || [];

	// Resolve the attached project: DB-persisted takes priority, then client-side selection
	const attachedProject =
		dbAttachedProject ??
		(selectedProjectId
			? (projects.find(
					(p: { id: string }) => p.id === selectedProjectId,
				) ?? null)
			: null);

	// Filter projects based on search query
	const filteredProjects = projects.filter(
		(p: { id: string; name: string }) =>
			searchQuery
				? p.name.toLowerCase().includes(searchQuery.toLowerCase())
				: true,
	);

	// Separate attached project from available projects
	const availableProjects = filteredProjects.filter(
		(p: { id: string }) => p.id !== attachedProject?.id,
	);

	const handleAttach = (projectId: string) => {
		if (conversationId) {
			// Persist to DB when conversation exists
			attachMutation.mutate(projectId);
		} else {
			// Client-side only before conversation is created
			onProjectChange?.(projectId);
			toast.success(
				"Project selected — it will be attached when you start chatting",
			);
		}
	};

	const handleDetach = () => {
		if (conversationId) {
			detachMutation.mutate();
		} else {
			onProjectChange?.(null);
			toast.success("Project removed");
		}
	};

	return (
		<div className="p-3 space-y-4">
			{/* Attached Project Section */}
			{attachedProject && (
				<div>
					<div className="flex items-center gap-1.5 mb-2">
						<div className="w-0.5 h-3 bg-primary rounded-sm" />
						<p className="text-[11px] font-medium text-muted-foreground uppercase tracking-[0.12em]">
							Attached Project
						</p>
					</div>

					<div className="rounded-md bg-primary/5 border border-primary/20 p-2.5">
						<div className="flex items-center justify-between">
							<div className="flex items-center gap-2 min-w-0 flex-1">
								<FolderKanban className="h-4 w-4 text-primary flex-shrink-0" />
								<div className="min-w-0 flex-1">
									<p className="text-sm font-medium truncate">
										{attachedProject.name}
									</p>
									<div className="flex items-center gap-2 mt-0.5 flex-wrap">
										{typeof (attachedProject as any)._count
											?.contexts === "number" && (
											<span className="text-[10px] text-muted-foreground flex items-center gap-0.5">
												<Layers className="h-2.5 w-2.5" />
												{
													(attachedProject as any)
														._count.contexts
												}{" "}
												contexts
											</span>
										)}
										{typeof (attachedProject as any)._count
											?.documents === "number" && (
											<span className="text-[10px] text-muted-foreground flex items-center gap-0.5">
												<FileText className="h-2.5 w-2.5" />
												{
													(attachedProject as any)
														._count.documents
												}{" "}
												docs
											</span>
										)}
										{(attachedProject as any)
											.codebaseConnected && (
											<span className="text-[10px] text-primary flex items-center gap-0.5">
												<Code2 className="h-2.5 w-2.5" />
												Codebase
											</span>
										)}
									</div>
								</div>
							</div>
							<Button
								variant="ghost"
								size="sm"
								className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive"
								onClick={handleDetach}
								disabled={detachMutation.isPending}
							>
								<X className="h-3 w-3 mr-1" />
								Detach
							</Button>
						</div>
					</div>
				</div>
			)}

			{/* Available Projects Section */}
			<div>
				<div className="flex items-center gap-1.5 mb-2">
					<div className="w-0.5 h-3 bg-primary rounded-sm" />
					<p className="text-[11px] font-medium text-muted-foreground uppercase tracking-[0.12em]">
						Available Projects ({availableProjects.length})
					</p>
				</div>

				{/* Search input */}
				{projects.length > 5 && (
					<div className="relative mb-2">
						<Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
						<SearchInput
							placeholder="Search projects..."
							value={searchQuery}
							onChange={(e) => setSearchQuery(e.target.value)}
							className="h-8 pl-7 text-xs"
						/>
					</div>
				)}

				{availableProjects.length === 0 ? (
					<div className="text-center py-6 text-xs text-muted-foreground">
						<FolderKanban className="h-8 w-8 mx-auto mb-2 opacity-50" />
						<p>
							{searchQuery
								? "No projects match your search"
								: "No projects available"}
						</p>
						{!searchQuery && (
							<p className="mt-1">
								Create a project to attach it here
							</p>
						)}
					</div>
				) : (
					<div className="space-y-1">
						{availableProjects.map(
							(project: {
								id: string;
								name: string;
								status?: string;
								_count?: {
									contexts?: number;
									documents?: number;
								};
								codebaseConnected?: boolean;
							}) => (
								<div
									key={project.id}
									className={cn(
										"flex items-center justify-between p-2 rounded-md transition-colors",
										"bg-card/50 border border-border/50 hover:bg-muted/50",
									)}
								>
									<div className="min-w-0 flex-1 pr-2">
										<div className="flex items-center gap-1.5">
											<FolderKanban className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
											<p className="text-sm font-medium truncate">
												{project.name}
											</p>
										</div>
										<div className="flex items-center gap-2 mt-0.5">
											{typeof project._count?.contexts ===
												"number" && (
												<span className="text-[10px] text-muted-foreground flex items-center gap-0.5">
													<Layers className="h-2.5 w-2.5" />
													{project._count.contexts}{" "}
													contexts
												</span>
											)}
											{typeof project._count
												?.documents === "number" && (
												<span className="text-[10px] text-muted-foreground flex items-center gap-0.5">
													<FileText className="h-2.5 w-2.5" />
													{project._count.documents}{" "}
													docs
												</span>
											)}
										</div>
									</div>
									<Button
										variant="outline"
										size="sm"
										className="h-7 px-2.5 text-xs flex-shrink-0"
										onClick={() => handleAttach(project.id)}
										disabled={
											attachMutation.isPending ||
											detachMutation.isPending
										}
									>
										Attach
									</Button>
								</div>
							),
						)}
					</div>
				)}
			</div>
		</div>
	);
}
