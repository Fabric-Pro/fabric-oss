/**
 * ArtifactBrowser
 *
 * Browsable list of persisted artifacts (research reports, code, documents, data)
 * within a project. Supports filtering by type, preview, download, and delete.
 *
 * Intended to be embedded in the project detail view as an "Artifacts" tab.
 */

"use client";

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Card } from "@ui/components/card";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { cn } from "@ui/lib";
import { formatDistanceToNow } from "date-fns";
import {
	BarChart3,
	BookOpen,
	Code2,
	Copy,
	Download,
	Eye,
	FileText,
	Loader2,
	MoreVertical,
	Package,
	Search,
	Trash2,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

// =============================================================================
// Types
// =============================================================================

type ArtifactType =
	| "RESEARCH_REPORT"
	| "CODE"
	| "DOCUMENT"
	| "DATA"
	| "CHART"
	| "FILE"
	| "SUMMARY";

const TYPE_CONFIG: Record<
	ArtifactType,
	{ label: string; icon: React.ReactNode; color: string }
> = {
	RESEARCH_REPORT: {
		label: "Research Report",
		icon: <BookOpen className="h-4 w-4" />,
		color: "text-violet-600",
	},
	CODE: {
		label: "Code",
		icon: <Code2 className="h-4 w-4" />,
		color: "text-blue-600",
	},
	DOCUMENT: {
		label: "Document",
		icon: <FileText className="h-4 w-4" />,
		color: "text-emerald-600",
	},
	DATA: {
		label: "Data",
		icon: <BarChart3 className="h-4 w-4" />,
		color: "text-orange-600",
	},
	CHART: {
		label: "Chart",
		icon: <BarChart3 className="h-4 w-4" />,
		color: "text-amber-600",
	},
	FILE: {
		label: "File",
		icon: <Package className="h-4 w-4" />,
		color: "text-gray-600",
	},
	SUMMARY: {
		label: "Summary",
		icon: <FileText className="h-4 w-4" />,
		color: "text-teal-600",
	},
};

// =============================================================================
// Component
// =============================================================================

interface ArtifactBrowserProps {
	projectId: string;
	className?: string;
}

export function ArtifactBrowser({
	projectId,
	className,
}: ArtifactBrowserProps) {
	const { organizationId, basePath } = useOrganizationContext();
	const router = useRouter();
	const queryClient = useQueryClient();
	const [typeFilter, setTypeFilter] = useState<ArtifactType | "ALL">("ALL");
	const [previewArtifactId, setPreviewArtifactId] = useState<string | null>(
		null,
	);

	const { data, isLoading } = useQuery({
		queryKey: ["artifacts", projectId, organizationId, typeFilter],
		queryFn: async () => {
			return await orpcClient.artifacts.list({
				organizationId: organizationId ?? null,
				projectId,
				type: typeFilter === "ALL" ? undefined : typeFilter,
				limit: 50,
			});
		},
	});

	const deleteMutation = useMutation({
		mutationFn: async (id: string) => {
			return await orpcClient.artifacts.delete({
				id,
				organizationId: organizationId ?? null,
			});
		},
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: ["artifacts", projectId],
			});
		},
	});

	const previewQuery = useQuery({
		queryKey: ["artifact", previewArtifactId, organizationId],
		enabled: Boolean(previewArtifactId),
		queryFn: async () => {
			return await orpcClient.artifacts.get({
				id: previewArtifactId as string,
				organizationId: organizationId ?? null,
			});
		},
	});

	const openReuseChat = async (artifactId: string) => {
		try {
			const response = await orpcClient.artifacts.get({
				id: artifactId,
				organizationId: organizationId ?? null,
			});
			const artifact = response.artifact;
			const prompt = artifact.content?.trim()
				? `Use this artifact as context for the next task:\n\n${artifact.title}\n\n${artifact.content.slice(0, 6000)}`
				: `Use the artifact "${artifact.title}" as context for the next task.`;
			router.push(
				`${basePath ?? "/app"}/agents/fabric-ai?projectId=${encodeURIComponent(projectId)}&prompt=${encodeURIComponent(prompt)}`,
			);
		} catch (error) {
			toast.error("Failed to open artifact in chat", {
				description:
					error instanceof Error ? error.message : String(error),
			});
		}
	};

	const downloadArtifact = async (artifactId: string) => {
		try {
			const response = await orpcClient.artifacts.get({
				id: artifactId,
				organizationId: organizationId ?? null,
			});
			const artifact = response.artifact;
			const content = artifact.content ?? "";
			const extension = artifact.mimeType?.includes("json")
				? "json"
				: "md";
			const blob = new Blob([content], {
				type: artifact.mimeType ?? "text/markdown",
			});
			const url = URL.createObjectURL(blob);
			const a = document.createElement("a");
			a.href = url;
			a.download = `${
				artifact.title
					.toLowerCase()
					.replace(/[^a-z0-9]+/g, "-")
					.replace(/^-|-$/g, "") || "artifact"
			}.${extension}`;
			document.body.appendChild(a);
			a.click();
			document.body.removeChild(a);
			URL.revokeObjectURL(url);
		} catch (error) {
			toast.error("Failed to download artifact", {
				description:
					error instanceof Error ? error.message : String(error),
			});
		}
	};

	const artifacts = data?.artifacts ?? [];
	const total = data?.total ?? 0;

	if (isLoading) {
		return (
			<div className="flex h-[300px] items-center justify-center">
				<Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
			</div>
		);
	}

	return (
		<div className={className}>
			<Dialog
				open={Boolean(previewArtifactId)}
				onOpenChange={(open) => {
					if (!open) {
						setPreviewArtifactId(null);
					}
				}}
			>
				<DialogContent className="max-w-3xl max-h-[80vh] overflow-hidden">
					<DialogHeader>
						<DialogTitle>
							{previewQuery.data?.artifact.title ??
								"Artifact Preview"}
						</DialogTitle>
					</DialogHeader>
					<div className="overflow-auto rounded-md border bg-muted/20 p-4">
						<pre className="whitespace-pre-wrap break-words text-sm font-mono">
							{previewQuery.isLoading
								? "Loading artifact..."
								: (previewQuery.data?.artifact.content ??
									"No inline content available for this artifact.")}
						</pre>
					</div>
				</DialogContent>
			</Dialog>

			{/* Header */}
			<div className="flex items-center justify-between mb-4">
				<div>
					<h3
						className="text-lg font-medium"
						style={{
							fontFamily:
								"var(--font-serif, 'EB Garamond', Georgia, serif)",
						}}
					>
						Artifacts
					</h3>
					<p className="text-sm text-muted-foreground">
						{total} artifact{total !== 1 ? "s" : ""} from agent
						conversations
					</p>
				</div>
				<Select
					value={typeFilter}
					onValueChange={(v) =>
						setTypeFilter(v as ArtifactType | "ALL")
					}
				>
					<SelectTrigger className="w-[180px]">
						<SelectValue placeholder="Filter by type" />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="ALL">All types</SelectItem>
						{Object.entries(TYPE_CONFIG).map(([key, config]) => (
							<SelectItem key={key} value={key}>
								<span className="flex items-center gap-2">
									{config.icon}
									{config.label}
								</span>
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>

			{/* Empty state */}
			{artifacts.length === 0 && (
				<div className="flex h-[200px] flex-col items-center justify-center text-center border rounded-lg bg-muted/50">
					<Search className="h-10 w-10 text-muted-foreground mb-3" />
					<p className="text-sm text-muted-foreground">
						{typeFilter !== "ALL"
							? `No ${TYPE_CONFIG[typeFilter]?.label.toLowerCase()} artifacts yet`
							: "No artifacts yet"}
					</p>
					<p className="text-xs text-muted-foreground mt-1">
						Artifacts are saved from agent research reports and
						outputs
					</p>
				</div>
			)}

			{/* Artifact list */}
			{artifacts.length > 0 && (
				<div className="space-y-2">
					{artifacts.map((artifact: any) => {
						const typeConfig =
							TYPE_CONFIG[artifact.type as ArtifactType] ??
							TYPE_CONFIG.FILE;

						return (
							<Card
								key={artifact.id}
								className="flex items-center gap-3 p-3 hover:bg-muted/30 transition-colors"
							>
								{/* Type icon */}
								<div
									className={cn(
										"shrink-0 p-2 rounded-lg bg-muted",
										typeConfig.color,
									)}
								>
									{typeConfig.icon}
								</div>

								{/* Content */}
								<div className="flex-1 min-w-0">
									<p className="font-medium text-sm truncate">
										{artifact.title}
									</p>
									<div className="flex items-center gap-2 mt-0.5 text-xs text-muted-foreground">
										<Badge
											variant="outline"
											className="text-xs border-transparent bg-muted"
										>
											{typeConfig.label}
										</Badge>
										<span>
											{formatDistanceToNow(
												new Date(artifact.createdAt),
												{ addSuffix: true },
											)}
										</span>
										{artifact.indexedAt && (
											<Badge
												variant="outline"
												className="text-xs bg-emerald-50 text-emerald-700 border-transparent"
											>
												Indexed
											</Badge>
										)}
									</div>
								</div>

								{/* Actions */}
								<DropdownMenu>
									<DropdownMenuTrigger asChild>
										<Button
											variant="ghost"
											size="icon-sm"
											className="h-8 w-8 shrink-0"
										>
											<MoreVertical className="h-4 w-4" />
										</Button>
									</DropdownMenuTrigger>
									<DropdownMenuContent align="end">
										<DropdownMenuItem
											onClick={() =>
												setPreviewArtifactId(
													artifact.id,
												)
											}
										>
											<Eye className="mr-2 h-4 w-4" />
											Preview
										</DropdownMenuItem>
										<DropdownMenuItem
											onClick={() => {
												navigator.clipboard.writeText(
													artifact.description ||
														artifact.title,
												);
											}}
										>
											<Copy className="mr-2 h-4 w-4" />
											Copy Summary
										</DropdownMenuItem>
										<DropdownMenuItem
											onClick={() =>
												downloadArtifact(artifact.id)
											}
										>
											<Download className="mr-2 h-4 w-4" />
											Download
										</DropdownMenuItem>
										<DropdownMenuItem
											onClick={() =>
												openReuseChat(artifact.id)
											}
										>
											<BookOpen className="mr-2 h-4 w-4" />
											Use In Chat
										</DropdownMenuItem>
										<DropdownMenuItem
											onClick={() =>
												deleteMutation.mutate(
													artifact.id,
												)
											}
											className="text-destructive"
										>
											<Trash2 className="mr-2 h-4 w-4" />
											Delete
										</DropdownMenuItem>
									</DropdownMenuContent>
								</DropdownMenu>
							</Card>
						);
					})}
				</div>
			)}
		</div>
	);
}
