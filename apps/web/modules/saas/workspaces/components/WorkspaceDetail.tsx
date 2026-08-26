"use client";

import { useEffectiveOrganizationId } from "@saas/organizations/hooks";
import { Spinner } from "@shared/components/Spinner";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@ui/components/card";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import { SearchInput } from "@ui/components/search-input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@ui/components/tabs";
import { formatDistanceToNow } from "date-fns";
import {
	AlertCircleIcon,
	CheckCircleIcon,
	ClockIcon,
	FileTextIcon,
	MessageCircleIcon,
	MoreVerticalIcon,
	RefreshCwIcon,
	SearchIcon,
	SettingsIcon,
	TrashIcon,
	UploadIcon,
	UsersIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { DocumentUploader } from "./DocumentUploader";
import { WorkspaceDocumentChatDialog } from "./WorkspaceDocumentChatDialog";
import { WorkspaceMembersPanel } from "./WorkspaceMembersPanel";
import { WorkspaceRagSettingsForm } from "./WorkspaceRagSettingsForm";

interface WorkspaceDetailProps {
	workspaceId: string;
	/**
	 * Organization ID for filtering data.
	 * - `string`: Show data for this organization
	 * - `null`: Show personal data only (explicit personal context)
	 * - `undefined`: Use the current organization context
	 */
	organizationId?: string | null;
}

export function WorkspaceDetail({
	workspaceId,
	organizationId: propOrgId,
}: WorkspaceDetailProps) {
	const _router = useRouter();
	const _queryClient = useQueryClient();
	const organizationId = useEffectiveOrganizationId(propOrgId);
	const [activeTab, setActiveTab] = useState("documents");
	const [showUploader, setShowUploader] = useState(false);
	const [showChatDialog, setShowChatDialog] = useState(false);
	const [searchQuery, setSearchQuery] = useState("");

	// Fetch workspace - poll while documents are processing
	const {
		data: workspace,
		isLoading,
		refetch,
	} = useQuery({
		...orpc.documentWorkspaces.get.queryOptions({
			input: { workspaceId, organizationId },
		}),
		refetchInterval: (query) => {
			const data = query.state.data;
			if (!data) {
				return false;
			}
			const hasProcessing = data.documents.some((d) =>
				[
					"PENDING",
					"UPLOADING",
					"UPLOADED",
					"EXTRACTING",
					"CHUNKING",
					"EMBEDDING",
					"STORING",
				].includes(d.status),
			);
			return hasProcessing ? 3000 : false;
		},
	});

	// Delete document mutation
	const deleteDocMutation = useMutation({
		mutationFn: async (documentId: string) => {
			return orpc.documentWorkspaces.documents.delete.call({
				documentId,
			});
		},
		onSuccess: () => {
			toast.success("Document deleted");
			refetch();
		},
		onError: (error) => {
			toast.error(error.message || "Failed to delete document");
		},
	});

	// Retry document mutation
	const retryDocMutation = useMutation({
		mutationFn: async (documentId: string) => {
			return orpc.documentWorkspaces.documents.retry.call({ documentId });
		},
		onSuccess: () => {
			toast.success("Document processing restarted");
			refetch();
		},
		onError: (error) => {
			toast.error(error.message || "Failed to retry processing");
		},
	});

	// Retry all failed documents
	const [isRetryingAll, setIsRetryingAll] = useState(false);
	const retryAllFailed = async () => {
		if (!workspace) {
			return;
		}
		const failedDocs = workspace.documents.filter(
			(d) => d.status === "FAILED",
		);
		if (failedDocs.length === 0) {
			return;
		}

		setIsRetryingAll(true);
		let successCount = 0;
		let errorCount = 0;

		for (const doc of failedDocs) {
			try {
				await orpc.documentWorkspaces.documents.retry.call({
					documentId: doc.id,
				});
				successCount++;
			} catch {
				errorCount++;
			}
		}

		setIsRetryingAll(false);
		refetch();

		if (successCount > 0 && errorCount === 0) {
			toast.success(
				`Restarted processing for ${successCount} document${successCount > 1 ? "s" : ""}`,
			);
		} else if (successCount > 0 && errorCount > 0) {
			toast.warning(
				`Restarted ${successCount} document${successCount > 1 ? "s" : ""}, ${errorCount} failed`,
			);
		} else {
			toast.error("Failed to restart document processing");
		}
	};

	if (isLoading) {
		return (
			<div className="flex items-center justify-center py-12">
				<Spinner />
			</div>
		);
	}

	if (!workspace) {
		return (
			<div className="text-center py-12">
				<p className="text-muted-foreground">Workspace not found</p>
			</div>
		);
	}

	const isPersonal = workspace.type === "PERSONAL";
	const isArchived = workspace.status === "ARCHIVED";
	const canManage =
		workspace.role === "administrator" ||
		workspace.role === "owner" ||
		workspace.isOwner;
	const canEdit = canManage || workspace.role === "contributor";

	const getStatusIcon = (status: string) => {
		switch (status) {
			case "READY":
				return <CheckCircleIcon className="h-4 w-4 text-success" />;
			case "FAILED":
				return <AlertCircleIcon className="h-4 w-4 text-destructive" />;
			case "PENDING":
			case "UPLOADING":
			case "UPLOADED":
			case "EXTRACTING":
			case "CHUNKING":
			case "EMBEDDING":
			case "STORING":
				return (
					<ClockIcon className="h-4 w-4 text-yellow-500 animate-pulse" />
				);
			default:
				return <ClockIcon className="h-4 w-4 text-muted-foreground" />;
		}
	};

	const getStatusLabel = (status: string) => {
		switch (status) {
			case "READY":
				return "Ready";
			case "FAILED":
				return "Failed";
			case "PENDING":
				return "Pending";
			case "UPLOADING":
				return "Uploading";
			case "UPLOADED":
				return "Processing";
			case "EXTRACTING":
				return "Extracting text";
			case "CHUNKING":
				return "Chunking";
			case "EMBEDDING":
				return "Embedding";
			case "STORING":
				return "Storing vectors";
			default:
				return status;
		}
	};

	// Convert technical error messages to user-friendly messages
	const getUserFriendlyError = (error: string | null | undefined): string => {
		if (!error) {
			return "Processing failed";
		}

		const errorLower = error.toLowerCase();

		if (errorLower.includes("activity task failed")) {
			return "Processing service unavailable - click Retry";
		}
		if (
			errorLower.includes("wrong queue") ||
			errorLower.includes("stuck")
		) {
			return "Processing queued incorrectly - click Retry";
		}
		if (errorLower.includes("s3") || errorLower.includes("bucket")) {
			return "Could not access document storage";
		}
		if (errorLower.includes("qdrant") || errorLower.includes("vector")) {
			return "Vector database unavailable";
		}
		if (
			errorLower.includes("extraction") ||
			errorLower.includes("extract")
		) {
			return "Could not extract text from document";
		}
		if (errorLower.includes("embedding")) {
			return "Could not generate embeddings";
		}
		if (errorLower.includes("timeout")) {
			return "Processing timed out - try again";
		}
		if (errorLower.includes("not found")) {
			return "Document file not found";
		}

		// If error is short enough, show it directly
		if (error.length <= 50) {
			return error;
		}

		return "Processing failed - click Retry";
	};

	const formatFileSize = (bytes: number) => {
		if (bytes < 1024) {
			return `${bytes} B`;
		}
		if (bytes < 1024 * 1024) {
			return `${(bytes / 1024).toFixed(1)} KB`;
		}
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	};

	return (
		<div className="space-y-6">
			{/* Header */}
			<div className="flex items-start justify-between">
				<div>
					<div className="flex items-center gap-2">
						<h1
							className="text-2xl tracking-tight"
							style={{
								fontFamily:
									"var(--font-sans, 'EB Garamond', Georgia, serif)",
								fontWeight: 400,
							}}
						>
							{workspace.name}
						</h1>
						{isPersonal && (
							<Badge variant="secondary">Personal</Badge>
						)}
						{isArchived && (
							<Badge variant="outline">Archived</Badge>
						)}
					</div>
					{workspace.description && (
						<p className="text-muted-foreground mt-1">
							{workspace.description}
						</p>
					)}
				</div>
				<div className="flex items-center gap-2">
					{workspace.documents.filter((d) => d.status === "READY")
						.length > 0 && (
						<Button
							variant="outline"
							onClick={() => setShowChatDialog(true)}
						>
							<MessageCircleIcon className="h-4 w-4 mr-2" />
							Chat with Documents
						</Button>
					)}
					{canEdit && !isArchived && (
						<Button onClick={() => setShowUploader(true)}>
							<UploadIcon className="h-4 w-4 mr-2" />
							Upload Document
						</Button>
					)}
				</div>
			</div>

			{/* Stats Cards */}
			{(() => {
				const readyDocs = workspace.documents.filter(
					(d) => d.status === "READY",
				);
				const failedDocs = workspace.documents.filter(
					(d) => d.status === "FAILED",
				);
				const processingDocs = workspace.documents.filter((d) =>
					[
						"PENDING",
						"UPLOADING",
						"UPLOADED",
						"EXTRACTING",
						"CHUNKING",
						"EMBEDDING",
						"STORING",
					].includes(d.status),
				);
				const totalChunks = workspace.documents.reduce(
					(sum, d) => sum + (d.chunkCount || 0),
					0,
				);

				return (
					<>
						<div className="grid grid-cols-1 md:grid-cols-3 gap-4">
							<Card>
								<CardHeader className="pb-2">
									<CardTitle className="text-sm font-medium text-muted-foreground">
										Documents
									</CardTitle>
								</CardHeader>
								<CardContent>
									<div className="text-2xl font-bold">
										{workspace.documents.length}/
										{workspace.documentLimit}
									</div>
									{(failedDocs.length > 0 ||
										processingDocs.length > 0) && (
										<div className="text-xs text-muted-foreground mt-1">
											{readyDocs.length} ready
											{processingDocs.length > 0 &&
												`, ${processingDocs.length} processing`}
											{failedDocs.length > 0 && (
												<span className="text-destructive">
													, {failedDocs.length} failed
												</span>
											)}
										</div>
									)}
								</CardContent>
							</Card>
							<Card>
								<CardHeader className="pb-2">
									<CardTitle className="text-sm font-medium text-muted-foreground">
										Ready for Search
									</CardTitle>
								</CardHeader>
								<CardContent>
									<div className="text-2xl font-bold">
										{readyDocs.length}
									</div>
									{readyDocs.length === 0 &&
										workspace.documents.length > 0 && (
											<div className="text-xs text-muted-foreground mt-1">
												Documents need processing
											</div>
										)}
								</CardContent>
							</Card>
							<Card>
								<CardHeader className="pb-2">
									<CardTitle className="text-sm font-medium text-muted-foreground">
										Total Chunks
									</CardTitle>
								</CardHeader>
								<CardContent>
									<div className="text-2xl font-bold">
										{totalChunks}
									</div>
									{totalChunks === 0 &&
										workspace.documents.length > 0 && (
											<div className="text-xs text-muted-foreground mt-1">
												Chunks created after processing
											</div>
										)}
								</CardContent>
							</Card>
						</div>

						{/* Warning banner for failed documents */}
						{failedDocs.length > 0 && (
							<div className="flex items-center justify-between p-4 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg">
								<div className="flex items-center gap-3">
									<AlertCircleIcon className="h-5 w-5 text-amber-600" />
									<div>
										<p className="font-medium text-highlight">
											{failedDocs.length} document
											{failedDocs.length > 1 ? "s" : ""}{" "}
											failed to process
										</p>
										<p className="text-sm text-highlight/80">
											Click Retry to reprocess failed
											documents
										</p>
									</div>
								</div>
								<Button
									variant="outline"
									size="sm"
									onClick={retryAllFailed}
									disabled={isRetryingAll}
									className="border-amber-300 text-amber-700 hover:bg-amber-100 dark:border-amber-700 dark:text-amber-300 dark:hover:bg-amber-900"
								>
									<RefreshCwIcon
										className={`h-4 w-4 mr-2 ${isRetryingAll ? "animate-spin" : ""}`}
									/>
									Retry All ({failedDocs.length})
								</Button>
							</div>
						)}
					</>
				);
			})()}

			{/* Tabs */}
			<Tabs value={activeTab} onValueChange={setActiveTab}>
				<TabsList>
					<TabsTrigger value="documents">
						<FileTextIcon className="h-4 w-4 mr-2" />
						Documents
					</TabsTrigger>
					{canManage && !isPersonal && (
						<TabsTrigger value="members">
							<UsersIcon className="h-4 w-4 mr-2" />
							Members
						</TabsTrigger>
					)}
					{canManage && (
						<TabsTrigger value="settings">
							<SettingsIcon className="h-4 w-4 mr-2" />
							Settings
						</TabsTrigger>
					)}
				</TabsList>

				<TabsContent value="documents" className="mt-4">
					{workspace.documents.length === 0 ? (
						<div className="text-center py-12 border rounded-lg bg-muted/20">
							<FileTextIcon className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
							<p className="text-muted-foreground mb-4">
								No documents yet. Upload your first document to
								get started.
							</p>
							{canEdit && !isArchived && (
								<Button onClick={() => setShowUploader(true)}>
									<UploadIcon className="h-4 w-4 mr-2" />
									Upload Document
								</Button>
							)}
						</div>
					) : (
						<div className="space-y-4">
							{/* Search bar */}
							<div className="relative">
								<SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
								<SearchInput
									placeholder="Search documents..."
									value={searchQuery}
									onChange={(e) =>
										setSearchQuery(e.target.value)
									}
									className="pl-10"
								/>
							</div>

							{/* Documents list */}
							<div className="space-y-2">
								{workspace.documents
									.filter((doc) =>
										doc.originalFilename
											.toLowerCase()
											.includes(
												searchQuery.toLowerCase(),
											),
									)
									.map((doc) => (
										<div
											key={doc.id}
											className={`flex items-center justify-between p-4 border rounded-lg ${
												doc.status === "FAILED"
													? "bg-red-50 dark:bg-red-950/20 border-red-200 dark:border-red-900"
													: "bg-card"
											}`}
										>
											<div className="flex items-center gap-4">
												{getStatusIcon(doc.status)}
												<div>
													<div className="font-medium">
														{doc.originalFilename}
													</div>
													<div className="text-sm text-muted-foreground">
														{formatFileSize(
															doc.size,
														)}{" "}
														&middot;{" "}
														{getStatusLabel(
															doc.status,
														)}
														{doc.chunkCount !==
															undefined &&
															doc.chunkCount >
																0 &&
															doc.status ===
																"READY" && (
																<>
																	{" "}
																	&middot;{" "}
																	{
																		doc.chunkCount
																	}{" "}
																	chunks
																</>
															)}
													</div>
													{doc.status === "FAILED" &&
														doc.processingError && (
															<div className="text-xs text-destructive mt-1">
																{getUserFriendlyError(
																	doc.processingError,
																)}
															</div>
														)}
												</div>
											</div>
											<div className="flex items-center gap-2">
												<span className="text-xs text-muted-foreground">
													{formatDistanceToNow(
														new Date(doc.createdAt),
													)}{" "}
													ago
												</span>
												{/* Show prominent retry button for failed documents */}
												{canEdit &&
													doc.status === "FAILED" && (
														<Button
															variant="outline"
															size="sm"
															onClick={() =>
																retryDocMutation.mutate(
																	doc.id,
																)
															}
															disabled={
																retryDocMutation.isPending
															}
															className="text-highlight border-orange-300 hover:bg-orange-50 dark:hover:bg-orange-950"
														>
															<RefreshCwIcon
																className={`h-3 w-3 mr-1 ${retryDocMutation.isPending ? "animate-spin" : ""}`}
															/>
															Retry
														</Button>
													)}
												{canEdit && (
													<DropdownMenu>
														<DropdownMenuTrigger
															asChild
														>
															<Button
																variant="ghost"
																size="icon-sm"
															>
																<MoreVerticalIcon className="h-4 w-4" />
															</Button>
														</DropdownMenuTrigger>
														<DropdownMenuContent align="end">
															{doc.status ===
																"FAILED" && (
																<>
																	<DropdownMenuItem
																		onClick={() =>
																			retryDocMutation.mutate(
																				doc.id,
																			)
																		}
																	>
																		<RefreshCwIcon className="h-4 w-4 mr-2" />
																		Retry
																		Processing
																	</DropdownMenuItem>
																	<DropdownMenuSeparator />
																</>
															)}
															<DropdownMenuItem
																onClick={() =>
																	deleteDocMutation.mutate(
																		doc.id,
																	)
																}
																className="text-destructive"
															>
																<TrashIcon className="h-4 w-4 mr-2" />
																Delete
															</DropdownMenuItem>
														</DropdownMenuContent>
													</DropdownMenu>
												)}
											</div>
										</div>
									))}
							</div>
						</div>
					)}
				</TabsContent>

				{canManage && !isPersonal && (
					<TabsContent value="members" className="mt-4">
						<WorkspaceMembersPanel workspaceId={workspaceId} />
					</TabsContent>
				)}

				{canManage && (
					<TabsContent value="settings" className="mt-4">
						<WorkspaceRagSettingsForm workspaceId={workspaceId} />
					</TabsContent>
				)}
			</Tabs>

			{/* Document Uploader Dialog */}
			<DocumentUploader
				open={showUploader}
				onOpenChange={setShowUploader}
				workspaceId={workspaceId}
				organizationId={organizationId}
				onSuccess={() => {
					refetch();
					setShowUploader(false);
				}}
			/>

			{/* Workspace Document Chat Dialog */}
			<WorkspaceDocumentChatDialog
				open={showChatDialog}
				onOpenChange={setShowChatDialog}
				workspaceId={workspaceId}
				workspaceName={workspace.name}
				documentCount={
					workspace.documents.filter((d) => d.status === "READY")
						.length
				}
				organizationId={organizationId}
			/>
		</div>
	);
}
