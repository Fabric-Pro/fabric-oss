"use client";

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { Spinner } from "@shared/components/Spinner";
import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import { SearchInput } from "@ui/components/search-input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@ui/components/table";
import {
	EditIcon,
	GitFork,
	MoreVerticalIcon,
	PlusIcon,
	SearchIcon,
	TrashIcon,
} from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useDebounceValue } from "usehooks-ts";
import { usePromptDeletion } from "../hooks/use-prompt-deletion";
import { PromptBindingManager } from "./PromptBindingManager";
import { PromptFormatBadge } from "./PromptFormatBadge";
import { PromptScopeBadge } from "./PromptScopeBadge";
import { PromptsHero } from "./PromptsHero";
import { PromptTag } from "./PromptTag";

type Props = {
	/**
	 * Optional organizationSlug for organization context.
	 * If not provided, uses personal context.
	 * Note: This is the slug, not the ID. The ID will be resolved via useOrganizationContext hook.
	 */
	organizationSlug?: string;
};

export function PromptManagementPage({ organizationSlug }: Props) {
	const router = useRouter();
	const searchParams = useSearchParams();
	const { organizationId: contextOrgId, basePath } = useOrganizationContext();

	// Use organization ID if in organization context (when slug is provided)
	// IMPORTANT: Use null (not undefined) for personal context to prevent session fallback
	// The resolveOrganizationId function on the backend will only fall back to session
	// when the value is undefined, but will NOT fall back when null is explicitly passed
	const organizationId = organizationSlug
		? (contextOrgId ?? undefined)
		: null;
	const [searchQuery, setSearchQuery] = useState("");
	// Apply the `?search=` deep-link filter on mount so links (e.g. the project
	// AI-settings "Customize these prompts" link) arrive pre-filtered. Done in an
	// effect, not a useState initializer: under SSR `useSearchParams()` is empty
	// and a useState initializer would capture "" and never update.
	const appliedUrlSearch = useRef(false);
	useEffect(() => {
		if (appliedUrlSearch.current) {
			return;
		}
		const initial = searchParams.get("search");
		if (initial) {
			setSearchQuery(initial);
			appliedUrlSearch.current = true;
		}
	}, [searchParams]);
	const [debouncedSearch] = useDebounceValue(searchQuery, 300);
	const [scopeFilter, setScopeFilter] = useState<string>("all");
	const [categoryFilter, setCategoryFilter] = useState<string>("all");

	// Fetch prompts with filters
	// IMPORTANT: Pass null for personal context to prevent session fallback
	const { data, isLoading, refetch } = useQuery(
		orpc.prompts.list.queryOptions({
			input: {
				organizationId: organizationId ?? null,
				scope: scopeFilter === "all" ? undefined : (scopeFilter as any),
				category: categoryFilter === "all" ? undefined : categoryFilter,
				search: debouncedSearch || undefined,
				limit: 100,
				offset: 0,
			},
		}),
	);

	// Fetch categories for filter
	// IMPORTANT: Pass null for personal context to prevent session fallback
	const { data: categoriesData } = useQuery(
		orpc.prompts.categories.queryOptions({
			input: { organizationId: organizationId ?? null },
		}),
	);

	const prompts = data?.prompts ?? [];
	const categories = categoriesData?.categories ?? [];

	// Fork mutation
	const forkMutation = useMutation({
		mutationFn: async ({
			promptId,
			targetScope,
		}: {
			promptId: string;
			targetScope: "USER" | "ORG";
		}) => {
			return await orpcClient.prompts.fork.fork({
				sourcePromptId: promptId,
				targetScope,
				organizationId:
					targetScope === "ORG" ? organizationId : undefined,
			});
		},
		onSuccess: (forkedPrompt) => {
			toast.success("Prompt forked successfully");
			refetch();
			// Navigate to the forked prompt
			router.push(`${basePath}/prompts/${forkedPrompt.id}`);
		},
		onError: (error) => {
			toast.error("Failed to fork prompt", {
				description:
					error instanceof Error ? error.message : String(error),
			});
		},
	});

	const handleFork = (promptId: string, scope: "SYSTEM" | "ORG" | "USER") => {
		// System prompts can be forked to USER or ORG
		// ORG prompts can be forked to USER
		// USER prompts cannot be forked (just duplicate)
		const targetScope =
			scope === "SYSTEM" && organizationId ? "ORG" : "USER";
		forkMutation.mutate({ promptId, targetScope });
	};

	return (
		<div className="space-y-8">
			{/* Hero Section */}
			<PromptsHero />

			{/* Header */}
			<div className="flex items-center justify-between">
				<Button onClick={() => router.push(`${basePath}/prompts/new`)}>
					<PlusIcon className="mr-2 h-4 w-4" />
					New Prompt
				</Button>
			</div>

			{/* Filters */}
			<div className="flex gap-4 items-center">
				<div className="relative flex-1 max-w-sm">
					<SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
					<SearchInput
						placeholder="Search prompts..."
						value={searchQuery}
						onChange={(e) => setSearchQuery(e.target.value)}
						className="pl-9"
					/>
				</div>
				<Select value={scopeFilter} onValueChange={setScopeFilter}>
					<SelectTrigger className="w-[180px]">
						<SelectValue placeholder="All Scopes" />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="all">All Scopes</SelectItem>
						<SelectItem value="SYSTEM">System</SelectItem>
						{organizationId && (
							<SelectItem value="ORG">Organization</SelectItem>
						)}
						<SelectItem value="USER">Personal</SelectItem>
					</SelectContent>
				</Select>
				<Select
					value={categoryFilter}
					onValueChange={setCategoryFilter}
				>
					<SelectTrigger className="w-[200px]">
						<SelectValue placeholder="All Categories" />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="all">All Categories</SelectItem>
						{categories.map((cat) => (
							<SelectItem key={cat} value={cat}>
								{cat}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>

			{/* Prompts Table */}
			<div className="border rounded-lg">
				{isLoading ? (
					<div className="flex items-center justify-center py-12">
						<Spinner />
					</div>
				) : prompts.length === 0 ? (
					<div className="flex flex-col items-center justify-center py-12 text-center">
						<p className="text-muted-foreground">
							No prompts found
						</p>
						<p className="text-sm text-muted-foreground mt-1">
							Try adjusting your filters or create a new prompt
						</p>
					</div>
				) : (
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>Name</TableHead>
								<TableHead>Scope</TableHead>
								<TableHead>Category</TableHead>
								<TableHead>Format</TableHead>
								<TableHead>Tags</TableHead>
								<TableHead>Versions</TableHead>
								<TableHead className="text-right">
									Actions
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{prompts.map((prompt) => (
								<TableRow key={prompt.id}>
									<TableCell>
										<div className="flex items-center gap-2">
											{prompt.forkedFrom && (
												<GitFork className="h-4 w-4 text-muted-foreground" />
											)}
											<div>
												<p className="font-medium">
													{prompt.name}
												</p>
												{prompt.description && (
													<p className="text-xs text-muted-foreground line-clamp-1">
														{prompt.description}
													</p>
												)}
											</div>
										</div>
									</TableCell>
									<TableCell>
										<PromptScopeBadge
											scope={prompt.scope as any}
										/>
									</TableCell>
									<TableCell>
										{prompt.category && (
											<Badge variant="outline">
												{prompt.category}
											</Badge>
										)}
									</TableCell>
									<TableCell>
										<PromptFormatBadge
											format={prompt.format as any}
										/>
									</TableCell>
									<TableCell>
										<div className="flex flex-wrap gap-1">
											{prompt.tags
												.slice(0, 2)
												.map((tag) => (
													<PromptTag key={tag}>
														{tag}
													</PromptTag>
												))}
											{prompt.tags.length > 2 && (
												<Badge
													variant="secondary"
													className="text-xs"
												>
													+{prompt.tags.length - 2}
												</Badge>
											)}
										</div>
									</TableCell>
									<TableCell>
										<span className="text-sm text-muted-foreground">
											{(prompt as any)._count?.versions ??
												0}
										</span>
									</TableCell>
									<TableCell className="text-right">
										<div className="flex items-center justify-end gap-2">
											<PromptBindingManager
												promptId={prompt.id}
												promptName={prompt.name}
												promptScope={
													prompt.scope as any
												}
												organizationId={
													organizationId ?? undefined
												}
											/>
											<PromptRowActions
												prompt={prompt}
												onEdit={() =>
													router.push(
														`${basePath}/prompts/${prompt.id}`,
													)
												}
												onFork={() =>
													handleFork(
														prompt.id,
														prompt.scope as any,
													)
												}
												onDeleted={refetch}
											/>
										</div>
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				)}
			</div>
		</div>
	);
}

/**
 * One row's overflow menu.
 *
 * A component of its own because the deletion is a hook, and a hook cannot be
 * called inside the row loop above. That is the whole reason for the split —
 * everything it renders was inline in the table a moment ago.
 *
 * This surface used to confirm through the browser's native `confirm()`, which
 * cannot carry the impact sentence and looked nothing like any other
 * destructive action in the product. It now uses the same shared dialog as its
 * two sibling surfaces (KTD7).
 */
function PromptRowActions({
	prompt,
	onEdit,
	onFork,
	onDeleted,
}: {
	/**
	 * Structural, and deliberately minimal. `organizationId` and `userId` are
	 * required: the delete predicate cannot judge an ORG or USER prompt without
	 * them, and `prompts.list` returns whole prompt rows, so both are already
	 * on the wire.
	 */
	prompt: {
		id: string;
		name: string;
		scope: string;
		organizationId: string | null;
		userId: string | null;
	};
	onEdit: () => void;
	onFork: () => void;
	onDeleted: () => void;
}) {
	const deletion = usePromptDeletion({ prompt, onDeleted });

	return (
		<>
			<DropdownMenu>
				{/* Stays visible while it is busy: the menu has already
				    closed, so a trigger that faded out would leave the wait
				    with no on-screen home. */}
				<DropdownMenuTrigger asChild>
					<Button
						variant="ghost"
						size="sm"
						{...deletion.triggerProps}
					>
						{deletion.isPreparing ? (
							<Spinner className="motion-reduce:animate-none" />
						) : (
							<MoreVerticalIcon className="h-4 w-4" />
						)}
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end">
					<DropdownMenuItem onClick={onEdit}>
						<EditIcon className="mr-2 h-4 w-4" />
						View/Edit
					</DropdownMenuItem>
					<DropdownMenuItem onClick={onFork}>
						<GitFork className="mr-2 h-4 w-4" />
						Fork
					</DropdownMenuItem>
					{deletion.canDelete && (
						<>
							<DropdownMenuSeparator />
							<DropdownMenuItem
								onClick={() => deletion.requestDelete()}
								className="text-destructive"
							>
								<TrashIcon className="mr-2 h-4 w-4" />
								Delete
							</DropdownMenuItem>
						</>
					)}
				</DropdownMenuContent>
			</DropdownMenu>
			{deletion.announcement}
		</>
	);
}
