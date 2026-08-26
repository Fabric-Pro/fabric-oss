"use client";

import {
	findPromptAgentTarget,
	promptDocumentTypeLabel,
} from "@repo/utils/prompt-action-catalog";
import { useSession } from "@saas/auth/hooks/use-session";
import { useActiveOrganization } from "@saas/organizations/hooks/use-active-organization";
import { useConfirmationAlert } from "@saas/shared/components/ConfirmationAlertProvider";
import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Avatar, AvatarFallback, AvatarImage } from "@ui/components/avatar";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import { Skeleton } from "@ui/components/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@ui/components/tabs";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { formatDistanceToNow } from "date-fns";
import {
	Check,
	Clock,
	Copy,
	Edit,
	GitFork,
	History,
	Lock,
	RotateCcw,
	SparklesIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { forkTarget, isProposalCandidate } from "../lib/fork-scope";
import {
	needsSharedEditWarning,
	sharedEditWarning,
} from "../lib/shared-edit-warning";
import {
	getUniqueVariables,
	hasVariables,
	parseVariables,
	replaceVariables,
} from "../lib/variable-detection";
import { DownloadDropdown } from "./DownloadDropdown";
import { PromptBindingManager } from "./PromptBindingManager";
import { PromptEditor } from "./PromptEditor";
import { PromptScopeBadge } from "./PromptScopeBadge";
import { PromptTag } from "./PromptTag";
import { PromptVersionCompareDialog } from "./PromptVersionCompareDialog";
import { RunPromptButton } from "./RunPromptButton";
import { ShareDropdown } from "./ShareDropdown";
import { UpvoteButton } from "./UpvoteButton";

type Props = {
	promptId: string;
	organizationId?: string;
	organizationSlug?: string;
};

type PromptFormatValue =
	| "PLAIN_TEXT"
	| "MARKDOWN"
	| "HANDLEBARS"
	| "MUSTACHE"
	| "LIQUID"
	| "JINJA2";

export function PromptDetails({
	promptId,
	organizationId,
	organizationSlug,
}: Props) {
	const router = useRouter();
	const searchParams = useSearchParams();
	// Fizzy #2068 (F11): the copy was created through Propose Change.
	const proposeChangeParam = searchParams.get("proposeChange") === "1";
	const queryClient = useQueryClient();
	const { user } = useSession();
	const { isOrganizationAdmin } = useActiveOrganization();
	const [isEditing, setIsEditing] = useState(false);
	const [copied, setCopied] = useState(false);
	// Version currently open in the compare/restore dialog, by version id.
	const [compareVersionId, setCompareVersionId] = useState<string | null>(
		null,
	);

	// Check if user is admin (can edit system prompts)
	const isAdmin = user?.role === "admin";
	const { confirm } = useConfirmationAlert();

	const promptQueryKey = orpc.prompts.get.byId.queryKey({
		input: { id: promptId, organizationId: organizationId ?? null },
	});

	const { data: prompt, isLoading } = useQuery(
		orpc.prompts.get.byId.queryOptions({
			input: { id: promptId, organizationId: organizationId ?? null },
		}),
	);

	// Which actions this prompt currently serves. Read so a save can say what
	// it reaches; a failure here must not block editing, so it degrades to an
	// empty list and the confirmation simply does not appear.
	const { data: boundActionsData } = useQuery({
		queryKey: ["prompt-bound-actions", promptId, organizationId],
		queryFn: async () =>
			await orpcClient.prompts.bind.listForPrompt({
				promptId,
				organizationId: organizationId ?? null,
			}),
	});
	const boundActions: Array<{
		targetKey: string;
		documentType: string;
		storyKind: "FEATURE" | "BUG" | null;
	}> = boundActionsData?.actions ?? [];
	const boundActionLabels = useMemo(
		() =>
			boundActions.map((a) => {
				const agent = findPromptAgentTarget(a.targetKey);
				const docType = promptDocumentTypeLabel(a.documentType);
				const kind = a.storyKind
					? ` (${a.storyKind === "FEATURE" ? "Feature" : "Bug"})`
					: "";
				return agent
					? `${agent.label} — ${docType}${kind}`
					: `${a.targetKey} — ${docType}${kind}`;
			}),
		[boundActions],
	);

	// Variable state - must be before any conditional returns
	const content = prompt?.versions?.[0]?.content || "";
	const contentHasVariables = hasVariables(content);
	const variables = useMemo(() => {
		if (!contentHasVariables) {
			return [];
		}
		const parsed = parseVariables(content);
		return getUniqueVariables(parsed);
	}, [content, contentHasVariables]);

	// Initialize values with defaults
	const [values, setValues] = useState<Record<string, string>>(() => {
		const initial: Record<string, string> = {};
		for (const variable of variables) {
			if (!(variable.name in initial)) {
				initial[variable.name] = variable.defaultValue || "";
			}
		}
		return initial;
	});

	// Check if values modified from defaults
	const isModified = useMemo(() => {
		for (const variable of variables) {
			if (values[variable.name] !== (variable.defaultValue || "")) {
				return true;
			}
		}
		return false;
	}, [values, variables]);

	// Reset values
	const handleReset = useCallback(() => {
		const initial: Record<string, string> = {};
		for (const variable of variables) {
			initial[variable.name] = variable.defaultValue || "";
		}
		setValues(initial);
	}, [variables]);

	// Get final content with variables replaced
	const getFinalContent = useCallback(() => {
		if (!contentHasVariables) {
			return content;
		}
		return replaceVariables(content, values);
	}, [content, contentHasVariables, values]);

	// Update a variable value
	const updateValue = useCallback((name: string, value: string) => {
		setValues((prev) => ({ ...prev, [name]: value }));
	}, []);

	const updateMutation = useMutation({
		mutationFn: async (updateData: {
			name?: string;
			description?: string;
			format?: PromptFormatValue;
			category?: string;
			tags?: string[];
			isPublic?: boolean;
			content?: string;
			changeNote?: string;
		}) => {
			const {
				content: newContent,
				changeNote,
				...metadataUpdate
			} = updateData;

			// Update metadata
			const result = await orpcClient.prompts.update({
				id: promptId,
				...metadataUpdate,
			});

			// If content changed, create a new version
			if (newContent && newContent !== content) {
				await orpcClient.prompts.version.create({
					id: promptId,
					content: newContent,
					changeNote,
				});
			}

			return result;
		},
		onSuccess: () => {
			toast.success("Prompt updated successfully");
			queryClient.invalidateQueries({ queryKey: promptQueryKey });
			setIsEditing(false);
		},
		onError: (error) => {
			toast.error("Failed to update prompt", {
				description:
					error instanceof Error ? error.message : String(error),
			});
		},
	});

	// Restoring saves the old body forward as a new version rather than
	// rewriting history, so `createPromptVersion` advances same-scope bindings
	// onto it exactly as an ordinary edit would. A failure here is worth
	// surfacing verbatim: the save path re-validates the body against the
	// prompt's CURRENT format, so restoring a Handlebars body onto a prompt
	// since switched to Liquid is rejected with the parser's own message.
	const restoreMutation = useMutation({
		mutationFn: async ({
			content,
			fromVersion,
		}: {
			content: string;
			fromVersion: number;
		}) =>
			await orpcClient.prompts.version.create({
				id: promptId,
				content,
				changeNote: `Restored from v${fromVersion}`,
			}),
		onSuccess: (_result, { fromVersion }) => {
			toast.success(`Restored v${fromVersion}`, {
				description:
					"Saved as a new version — agents bound to this prompt now use it.",
			});
			queryClient.invalidateQueries({ queryKey: promptQueryKey });
			setCompareVersionId(null);
		},
		onError: (error) => {
			toast.error("Failed to restore version", {
				description:
					error instanceof Error ? error.message : String(error),
			});
		},
	});

	// Fizzy #2068 (F11): Propose Change forks the prompt into the caller's own
	// scope — the copy a member edits freely and then puts forward through the
	// ordinary set-default flow, where the organization tier becomes a
	// nomination for an admin to review. Always a personal copy, whatever the
	// caller's role: an admin who wants to change an organization prompt edits
	// it in place, and a platform admin owns the system one.
	const proposeChangeMutation = useMutation({
		mutationFn: async () =>
			await orpcClient.prompts.fork.fork({
				sourcePromptId: promptId,
				targetScope: "USER" as const,
			}),
		onSuccess: (forkedPrompt) => {
			toast.success(
				"Copy created — edit it, then propose it as a default",
			);
			queryClient.invalidateQueries({ queryKey: promptQueryKey });
			router.push(
				organizationSlug
					? `/app/${organizationSlug}/prompts/${forkedPrompt.id}?proposeChange=1`
					: `/app/prompts/${forkedPrompt.id}?proposeChange=1`,
			);
		},
		onError: (error) => {
			toast.error("Failed to create the proposal copy", {
				description:
					error instanceof Error ? error.message : String(error),
			});
		},
	});

	const forkMutation = useMutation({
		mutationFn: async () =>
			await orpcClient.prompts.fork.fork({
				sourcePromptId: promptId,
				...forkTarget({ organizationId, isOrganizationAdmin }),
			}),
		onSuccess: (forkedPrompt) => {
			toast.success("Prompt forked successfully");
			queryClient.invalidateQueries({ queryKey: promptQueryKey });
			router.push(
				organizationSlug
					? `/app/${organizationSlug}/prompts/${forkedPrompt.id}`
					: `/app/prompts/${forkedPrompt.id}`,
			);
		},
		onError: (error) => {
			toast.error("Failed to fork prompt", {
				description:
					error instanceof Error ? error.message : String(error),
			});
		},
	});

	// Copy to clipboard
	const copyToClipboard = async () => {
		try {
			await navigator.clipboard.writeText(getFinalContent());
			setCopied(true);
			toast.success("Copied to clipboard");
			setTimeout(() => setCopied(false), 2000);
		} catch {
			toast.error("Failed to copy");
		}
	};

	if (isLoading) {
		return (
			<div className="container max-w-4xl py-8">
				<div className="flex gap-4 mb-6">
					<Skeleton className="h-14 w-14 rounded-full" />
					<div className="flex-1">
						<Skeleton className="h-8 w-64 mb-2" />
						<Skeleton className="h-4 w-48" />
					</div>
				</div>
				<Skeleton className="h-96 w-full" />
			</div>
		);
	}

	if (!prompt) {
		return (
			<div className="container max-w-4xl py-8">
				<div className="flex flex-col items-center justify-center py-12">
					<p className="text-muted-foreground mb-4">
						Prompt not found
					</p>
					<Button onClick={() => router.push("/app/prompts")}>
						Back to Prompts
					</Button>
				</div>
			</div>
		);
	}

	const _latestVersion = prompt.versions?.[0];
	const voteCount = (prompt as any).voteCount ?? 0;
	const hasVoted = false; // TODO: Get from API

	// Same gate as the Edit button — the save path enforces it server-side too.
	const canEditPrompt = prompt.scope !== "SYSTEM" || isAdmin;
	const comparedVersion = compareVersionId
		? prompt.versions?.find((v: any) => v.id === compareVersionId)
		: undefined;

	const handleSave = (data: any) => {
		const save = () =>
			updateMutation.mutate({
				name: data.name,
				description: data.description,
				format: data.format,
				category: data.category,
				tags: data.tags,
				isPublic: data.isPublic,
				content: data.content,
				changeNote: data.changeNote,
			});

		// FR21: the content is shared, so an edit reaches every action bound to
		// this prompt at once. Only worth interrupting for when there is more
		// than one — with a single binding the reach is exactly what the user
		// is looking at. Metadata-only saves are left alone: they change nothing
		// any agent reads.
		const contentChanged = Boolean(
			data.content && data.content !== content,
		);
		if (
			needsSharedEditWarning({
				contentChanged,
				boundActionCount: boundActions.length,
			})
		) {
			confirm({
				...sharedEditWarning(boundActionLabels),
				confirmLabel: "Save for all",
				cancelLabel: "Cancel",
				onConfirm: save,
			});
			return;
		}

		save();
	};

	const handleCancel = () => {
		setIsEditing(false);
	};

	const basePath = organizationSlug
		? `/app/${organizationSlug}/prompts`
		: "/app/prompts";

	// Render content with inline variable highlighting
	const renderContent = () => {
		if (!contentHasVariables) {
			return content || "No content yet";
		}

		const parts: React.ReactNode[] = [];
		let lastIndex = 0;
		const regex = /\$\{([^:}]+)(?::([^}]*))?\}/g;
		let match: RegExpExecArray | null;
		let keyIndex = 0;

		while (
			// biome-ignore lint/suspicious/noAssignInExpressions: standard regex iteration idiom
			(match = regex.exec(content)) !== null
		) {
			// Add text before the variable
			if (match.index > lastIndex) {
				parts.push(content.slice(lastIndex, match.index));
			}

			const name = match[1].trim();
			const currentValue = values[name] || "";
			const defaultValue = match[2]?.trim() || name;

			// Show value or placeholder
			parts.push(
				<span
					key={keyIndex++}
					className={`inline border-b-2 px-1 rounded-sm ${
						currentValue
							? "bg-primary/10 border-primary/40 text-foreground"
							: "bg-primary/5 border-primary/20 text-muted-foreground"
					}`}
				>
					{currentValue || defaultValue}
				</span>,
			);

			lastIndex = match.index + match[0].length;
		}

		// Add remaining text
		if (lastIndex < content.length) {
			parts.push(content.slice(lastIndex));
		}

		return parts;
	};

	return (
		<div className="container max-w-4xl py-8">
			{/* Fizzy #2068 (F11): the copy was created through Propose Change */}
			{isProposalCandidate({
				promptScope: prompt.scope,
				promptUserId: prompt.userId,
				viewerId: user?.id,
				proposeChangeParam,
			}) && (
				<div className="mb-4 rounded-md border border-highlight/40 bg-highlight/5 p-3 text-sm">
					<p className="font-medium">
						This copy is your proposal candidate.
					</p>
					<p className="text-muted-foreground">
						Edit it, then use Bind Prompt as Default with the
						Organization scope — a member&apos;s choice goes to the
						admins as a nomination to review.
					</p>
				</div>
			)}

			{/* Header */}
			<div className="mb-6">
				{/* Title row with upvote button */}
				<div className="flex items-center gap-4 mb-2">
					<div className="shrink-0">
						<UpvoteButton
							promptId={promptId}
							initialVoted={hasVoted}
							initialCount={voteCount}
							size="circular"
						/>
					</div>
					<div className="flex-1 flex items-center justify-between gap-4 min-w-0">
						<div className="flex items-center gap-2 flex-wrap min-w-0">
							<h1
								className="text-3xl tracking-tight"
								style={{
									fontFamily:
										"var(--font-sans, 'EB Garamond', Georgia, serif)",
									fontWeight: 400,
								}}
							>
								{prompt.name}
							</h1>
							{!prompt.isPublic && (
								<Badge variant="secondary" className="gap-1">
									<Lock className="h-3 w-3" />
									Private
								</Badge>
							)}
						</div>
						<div className="flex items-center gap-2 shrink-0">
							{!isEditing && (
								<>
									{/* Fork button - show for SYSTEM or ORG prompts */}
									{(prompt.scope === "SYSTEM" ||
										prompt.scope === "ORG") && (
										<TooltipProvider>
											<Tooltip>
												<TooltipTrigger asChild>
													<Button
														variant={
															prompt.scope ===
															"SYSTEM"
																? "default"
																: "outline"
														}
														size="icon"
														onClick={() =>
															forkMutation.mutate()
														}
														disabled={
															forkMutation.isPending
														}
														className="sm:hidden"
													>
														<GitFork className="h-4 w-4" />
													</Button>
												</TooltipTrigger>
												<TooltipContent>
													<p>
														{forkMutation.isPending
															? "Forking..."
															: "Create a copy to customize"}
													</p>
												</TooltipContent>
											</Tooltip>
										</TooltipProvider>
									)}
									{(prompt.scope === "SYSTEM" ||
										prompt.scope === "ORG") && (
										<TooltipProvider>
											<Tooltip>
												<TooltipTrigger asChild>
													<Button
														variant="outline"
														size="icon"
														onClick={() =>
															proposeChangeMutation.mutate()
														}
														disabled={
															proposeChangeMutation.isPending
														}
														className="sm:hidden"
													>
														<GitFork className="h-4 w-4" />
													</Button>
												</TooltipTrigger>
												<TooltipContent>
													<p>
														{proposeChangeMutation.isPending
															? "Creating copy..."
															: "Propose a change to this default"}
													</p>
												</TooltipContent>
											</Tooltip>
										</TooltipProvider>
									)}
									{(prompt.scope === "SYSTEM" ||
										prompt.scope === "ORG") && (
										<TooltipProvider>
											<Tooltip>
												<TooltipTrigger asChild>
													<Button
														variant="outline"
														onClick={() =>
															proposeChangeMutation.mutate()
														}
														disabled={
															proposeChangeMutation.isPending
														}
														className="hidden sm:flex"
													>
														<GitFork className="h-4 w-4 mr-2" />
														Propose change
													</Button>
												</TooltipTrigger>
												<TooltipContent>
													<p>
														{proposeChangeMutation.isPending
															? "Creating copy..."
															: "Edit a personal copy, then propose it as the default"}
													</p>
												</TooltipContent>
											</Tooltip>
										</TooltipProvider>
									)}
									{(prompt.scope === "SYSTEM" ||
										prompt.scope === "ORG") && (
										<TooltipProvider>
											<Tooltip>
												<TooltipTrigger asChild>
													<Button
														variant={
															prompt.scope ===
															"SYSTEM"
																? "default"
																: "outline"
														}
														onClick={() =>
															forkMutation.mutate()
														}
														disabled={
															forkMutation.isPending
														}
														className="hidden sm:flex"
													>
														<GitFork className="h-4 w-4 mr-2" />
														Fork
													</Button>
												</TooltipTrigger>
												<TooltipContent>
													<p>
														Create a copy to
														customize
													</p>
												</TooltipContent>
											</Tooltip>
										</TooltipProvider>
									)}
									{/* Enhance button - only for non-SYSTEM prompts or admins */}
									{(prompt.scope !== "SYSTEM" || isAdmin) && (
										<>
											<Button
												variant="outline"
												size="icon"
												asChild
												className="sm:hidden"
											>
												<Link
													href={`${basePath}/${promptId}/enhance`}
												>
													<SparklesIcon className="h-4 w-4" />
												</Link>
											</Button>
											<Button
												variant="outline"
												asChild
												className="hidden sm:flex"
											>
												<Link
													href={`${basePath}/${promptId}/enhance`}
												>
													<SparklesIcon className="h-4 w-4 mr-2" />
													Enhance
												</Link>
											</Button>
										</>
									)}
									{/* Edit metadata button - only for non-SYSTEM prompts or admins */}
									{(prompt.scope !== "SYSTEM" || isAdmin) && (
										<>
											<Button
												variant="outline"
												size="icon"
												onClick={() =>
													setIsEditing(true)
												}
												className="sm:hidden"
											>
												<Edit className="h-4 w-4" />
											</Button>
											<Button
												variant="outline"
												onClick={() =>
													setIsEditing(true)
												}
												className="hidden sm:flex"
											>
												<Edit className="h-4 w-4 mr-2" />
												Edit
											</Button>
										</>
									)}
									{/* Bind button - for any prompt to bind to agents */}
									<PromptBindingManager
										promptId={promptId}
										promptName={prompt.name}
										promptKey={prompt.key ?? undefined}
										promptScope={
											prompt.scope as
												| "USER"
												| "ORG"
												| "SYSTEM"
										}
										organizationId={organizationId}
									/>
								</>
							)}
						</div>
					</div>
				</div>

				{/* Description */}
				{prompt.description && (
					<p className="text-muted-foreground">
						{prompt.description}
					</p>
				)}
			</div>

			{/* System prompt info banner */}
			{prompt.scope === "SYSTEM" && !isAdmin && (
				<div className="mb-6 p-4 rounded-lg bg-gradient-to-r from-orange-500/10 to-red-500/10 border border-orange-500/20">
					<div className="flex items-start gap-3">
						<GitFork className="h-5 w-5 text-highlight dark:text-orange-400 mt-0.5 shrink-0" />
						<div>
							<p className="font-medium text-orange-700 dark:text-orange-300">
								This is a Fabric system prompt
							</p>
							<p className="text-sm text-highlight/80 dark:text-orange-400/80 mt-1">
								System prompts are maintained by Fabric and
								cannot be edited directly. To customize this
								prompt, click "Fork to Customize" to create your
								own copy.
							</p>
						</div>
					</div>
				</div>
			)}

			{/* Meta info */}
			<div className="flex flex-wrap items-center gap-4 text-sm text-muted-foreground mb-6">
				{/* Scope badge */}
				<PromptScopeBadge
					scope={prompt.scope as "SYSTEM" | "ORG" | "USER"}
				/>

				{/* Author */}
				<div className="flex items-center gap-2">
					<Avatar className="h-6 w-6">
						<AvatarImage src={undefined} />
						<AvatarFallback className="text-xs">
							{(prompt as any).createdBy
								?.charAt(0)
								?.toUpperCase() || "U"}
						</AvatarFallback>
					</Avatar>
					<span>{(prompt as any).createdBy || "Unknown"}</span>
				</div>

				{/* Created date */}
				<div className="flex items-center gap-1.5">
					<Clock className="h-4 w-4" />
					<span>
						{formatDistanceToNow(new Date(prompt.createdAt))} ago
					</span>
				</div>

				{/* Category */}
				{prompt.category && (
					<Badge variant="outline">{prompt.category}</Badge>
				)}
			</div>

			{/* Tags */}
			{prompt.tags && prompt.tags.length > 0 && (
				<div className="flex flex-wrap gap-2 mb-6">
					{prompt.tags.map((tag: string) => (
						<PromptTag key={tag}>{tag}</PromptTag>
					))}
				</div>
			)}

			{/* Content */}
			{isEditing ? (
				<div>
					<PromptEditor
						initialData={{
							name: prompt.name,
							description: prompt.description || undefined,
							scope: prompt.scope as any,
							format: prompt.format as any,
							category: prompt.category || undefined,
							tags: prompt.tags,
							isPublic: prompt.isPublic,
							content: content,
						}}
						onSave={handleSave}
						onCancel={handleCancel}
						isLoading={updateMutation.isPending}
						canEditScope={false}
					/>
				</div>
			) : (
				<Tabs defaultValue="content">
					<div className="flex flex-col gap-3 mb-4">
						<div className="flex items-center justify-between">
							<TabsList>
								<TabsTrigger value="content">
									Content
								</TabsTrigger>
								<TabsTrigger value="versions" className="gap-1">
									<History className="h-4 w-4" />
									Versions
									<Badge
										variant="secondary"
										className="ml-1 h-5 min-w-5 px-1 text-xs"
									>
										{prompt.versions?.[0]?.version ?? 0}
									</Badge>
								</TabsTrigger>
							</TabsList>
						</div>
					</div>

					<TabsContent value="content" className="space-y-4 mt-0">
						{/* Interactive Prompt Content */}
						<div>
							{/* Header with actions */}
							<div className="flex items-center justify-between mb-3">
								<h3 className="text-base font-semibold">
									Prompt Content
								</h3>
								<div className="flex items-center gap-2">
									{isModified && (
										<Button
											variant="ghost"
											size="sm"
											onClick={handleReset}
											className="h-7 px-2 text-xs"
										>
											<RotateCcw className="h-3 w-3 mr-1" />
											Reset
										</Button>
									)}
									<ShareDropdown title={prompt.name} />
									<DownloadDropdown
										promptId={prompt.id}
										promptName={prompt.name}
										content={getFinalContent()}
										description={
											prompt.description || undefined
										}
										category={prompt.category || undefined}
										tags={prompt.tags}
									/>
									<Button
										variant="ghost"
										size="sm"
										onClick={copyToClipboard}
									>
										{copied ? (
											<Check className="h-4 w-4 text-success" />
										) : (
											<Copy className="h-4 w-4" />
										)}
									</Button>
									<RunPromptButton
										content={getFinalContent()}
										emphasized
									/>
								</div>
							</div>

							{/* Variable inputs */}
							{contentHasVariables && variables.length > 0 && (
								<div className="mb-4 p-4 rounded-lg border bg-muted/30 space-y-3">
									<span className="text-sm font-medium">
										Variables
									</span>
									<div className="grid gap-3 sm:grid-cols-2">
										{variables.map((variable, index) => (
											<div
												key={`${variable.name}-${index}`}
												className="space-y-1"
											>
												<Label
													htmlFor={`var-${variable.name}`}
													className="text-xs text-muted-foreground"
												>
													{variable.name}
												</Label>
												<Input
													id={`var-${variable.name}`}
													value={
														values[variable.name] ||
														""
													}
													onChange={(e) =>
														updateValue(
															variable.name,
															e.target.value,
														)
													}
													placeholder={
														variable.defaultValue ||
														variable.name
													}
													className="h-8 text-sm"
												/>
											</div>
										))}
									</div>
								</div>
							)}

							{/* Content display */}
							<div className="bg-muted p-6 rounded-lg border">
								<pre className="whitespace-pre-wrap text-sm font-mono leading-7 text-foreground">
									{renderContent()}
								</pre>
							</div>
						</div>
					</TabsContent>

					<TabsContent value="versions" className="mt-0">
						<div>
							<div className="flex items-center justify-between mb-3">
								<h3 className="text-base font-semibold">
									Version History
								</h3>
							</div>
							{prompt.versions && prompt.versions.length > 0 ? (
								<div className="divide-y border rounded-lg">
									{prompt.versions.map(
										(version: any, index: number) => {
											const isLatestVersion = index === 0;
											return (
												<div
													key={version.version}
													className="px-4 py-3 flex items-start gap-3"
												>
													<div className="flex-1 min-w-0">
														<div className="flex items-center gap-2 flex-wrap">
															<span className="text-sm font-medium">
																v
																{
																	version.version
																}
															</span>
															{isLatestVersion && (
																<span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary font-medium">
																	Current
																</span>
															)}
															<span className="text-xs text-muted-foreground">
																{formatDistanceToNow(
																	new Date(
																		version.createdAt,
																	),
																)}{" "}
																ago
															</span>
															{version.author
																?.username && (
																<span className="text-xs text-muted-foreground">
																	by @
																	{
																		version
																			.author
																			.username
																	}
																</span>
															)}
														</div>
														{version.changeNote && (
															<p className="text-xs text-muted-foreground mt-1 truncate">
																{
																	version.changeNote
																}
															</p>
														)}
														{/* Content preview */}
														<pre className="text-xs text-muted-foreground mt-2 bg-muted p-2 rounded font-mono line-clamp-2 whitespace-pre-wrap">
															{version.content?.substring(
																0,
																200,
															)}
															{version.content
																?.length >
																200 && "..."}
														</pre>
													</div>
													{/* Compare button for non-current versions */}
													{!isLatestVersion && (
														<div className="flex items-center gap-1 shrink-0">
															<Button
																variant="ghost"
																size="sm"
																className="h-7 px-2 text-xs"
																onClick={() =>
																	setCompareVersionId(
																		version.id,
																	)
																}
															>
																Compare
															</Button>
														</div>
													)}
												</div>
											);
										},
									)}
								</div>
							) : (
								<p className="text-muted-foreground py-8 text-center">
									No versions yet
								</p>
							)}
						</div>
					</TabsContent>
				</Tabs>
			)}

			{comparedVersion && (
				<PromptVersionCompareDialog
					open
					onOpenChange={(next) => {
						if (!next) {
							setCompareVersionId(null);
						}
					}}
					version={comparedVersion}
					currentContent={content}
					currentVersionNumber={_latestVersion?.version ?? 0}
					canRestore={canEditPrompt}
					isRestoring={restoreMutation.isPending}
					onRestore={(restoredContent, fromVersion) =>
						restoreMutation.mutate({
							content: restoredContent,
							fromVersion,
						})
					}
				/>
			)}
		</div>
	);
}
