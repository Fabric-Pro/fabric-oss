"use client";

import type { StoryKind } from "@repo/database";
import { useActiveOrganization } from "@saas/organizations/hooks/use-active-organization";
import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { Label } from "@ui/components/label";
import { SearchInput } from "@ui/components/search-input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { Loader2Icon, SearchIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useDebounceValue } from "usehooks-ts";
import { PROJECT_DOC_GEN_AGENT_KEY } from "../lib/agent-keys";

type Props = {
	open: boolean;
	/** Stage documentType string (e.g. "PLACEHOLDER", "DRAFT"). Plain string
	 *  so this dialog can be reused across stage panels. */
	documentType: string;
	stageLabel: string;
	organizationId: string | null;
	/** Required so the binding writes to the correct kind-scoped bucket. */
	storyKind: StoryKind;
	onOpenChange: (open: boolean) => void;
	onBound: () => void;
};

/** The tiers this picker offers. SYSTEM is deliberately absent — a stage
 *  default is either one person's or the organization's. */
type BindingScope = "USER" | "ORG";

export function PickDefaultForStageDialog({
	open,
	documentType,
	stageLabel,
	organizationId,
	storyKind,
	onOpenChange,
	onBound,
}: Props) {
	const { isOrganizationAdmin } = useActiveOrganization();
	const [search, setSearch] = useState("");
	const [debouncedSearch] = useDebounceValue(search, 300);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [selectedScope, setSelectedScope] = useState<BindingScope>("USER");

	useEffect(() => {
		if (open) {
			setSelectedScope("USER");
		}
	}, [open]);

	const { data, isLoading } = useQuery(
		orpc.prompts.list.queryOptions({
			input: {
				organizationId,
				search: debouncedSearch || undefined,
				limit: 50,
				offset: 0,
			},
		}),
	);
	const prompts = data?.prompts ?? [];
	const selected = prompts.find((p) => p.id === selectedId) ?? null;

	// A shared tier you may not write yourself is one you may PROPOSE — the
	// same verb swap SetAsDefaultDialog makes. Without it a member picking any
	// prompt at Organization hit a bare FORBIDDEN, and the dialog offered no
	// personal route either, which read as "binding does not work".
	const mustPropose =
		selectedScope === "ORG" &&
		Boolean(organizationId) &&
		!isOrganizationAdmin;

	const bind = useMutation({
		mutationFn: async () => {
			if (!selected) {
				throw new Error("No prompt selected");
			}
			const latest = selected.versions[0];
			if (!latest) {
				throw new Error("Prompt has no version");
			}
			const target = {
				targetKey: PROJECT_DOC_GEN_AGENT_KEY,
				documentType,
				storyKind,
			};

			if (mustPropose) {
				return await orpcClient.prompts.nominations.create({
					promptVersionId: latest.id,
					targetScope: "ORG",
					organizationId,
					targets: [target],
				});
			}

			return await orpcClient.prompts.bind.set({
				targetType: "AGENT",
				...target,
				scope: selectedScope,
				organizationId: selectedScope === "ORG" ? organizationId : null,
				promptVersionId: latest.id,
				isDefault: true,
			});
		},
		onSuccess: () => {
			toast.success(
				mustPropose
					? `Proposed for ${stageLabel} — an admin will review it`
					: `Default set for ${stageLabel}`,
			);
			onBound();
			onOpenChange(false);
			setSelectedId(null);
		},
		onError: (err) => {
			toast.error(
				mustPropose
					? "Failed to propose default"
					: "Failed to set default",
				{
					description:
						err instanceof Error ? err.message : String(err),
				},
			);
		},
	});

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			{/* Pinned header/footer, scrolling body — see PromptBindingManager. */}
			<DialogContent className="flex max-h-[90vh] flex-col overflow-hidden sm:max-w-lg">
				<DialogHeader className="shrink-0">
					<DialogTitle>Set default prompt — {stageLabel}</DialogTitle>
					<DialogDescription>
						Pick a prompt to use as the default for the {stageLabel}{" "}
						stage.
					</DialogDescription>
				</DialogHeader>

				<div className="min-h-0 flex-1 space-y-3 overflow-y-auto pb-2 pr-1">
					<div className="relative">
						<SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
						<SearchInput
							placeholder="Search prompts…"
							value={search}
							onChange={(e) => setSearch(e.target.value)}
							className="pl-9"
						/>
					</div>

					<div className="max-h-72 overflow-y-auto rounded-md border divide-y">
						{isLoading ? (
							<div className="p-4 text-center text-sm text-muted-foreground">
								Loading…
							</div>
						) : prompts.length === 0 ? (
							<div className="p-4 text-center text-sm text-muted-foreground">
								No prompts match your search.
							</div>
						) : (
							prompts.map((p) => (
								<button
									key={p.id}
									type="button"
									className={`w-full text-left px-3 py-2 flex items-center justify-between hover:bg-muted/60 ${
										selectedId === p.id ? "bg-muted" : ""
									}`}
									onClick={() => setSelectedId(p.id)}
								>
									<span className="text-sm font-medium">
										{p.name}
									</span>
									<Badge
										variant="outline"
										className="text-xs"
									>
										{p.scope}
									</Badge>
								</button>
							))
						)}
					</div>

					{organizationId && (
						<div className="space-y-2">
							<Label htmlFor="pick-default-scope">Scope</Label>
							<Select
								value={selectedScope}
								onValueChange={(val) =>
									setSelectedScope(val as BindingScope)
								}
							>
								<SelectTrigger id="pick-default-scope">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="USER">
										Personal (just for me)
									</SelectItem>
									<SelectItem value="ORG">
										Organization (for all members)
									</SelectItem>
								</SelectContent>
							</Select>
							<p className="text-xs text-muted-foreground">
								{mustPropose
									? "An organization admin reviews this before it applies to anyone else."
									: selectedScope === "USER"
										? "This will only affect your documents."
										: "This will affect all organization members."}
							</p>
						</div>
					)}
				</div>

				<DialogFooter className="shrink-0 border-t pt-4">
					<Button
						variant="outline"
						onClick={() => onOpenChange(false)}
					>
						Cancel
					</Button>
					<Button
						onClick={() => bind.mutate()}
						disabled={!selected || bind.isPending}
					>
						{bind.isPending && (
							<Loader2Icon className="mr-2 h-4 w-4 animate-spin" />
						)}
						{mustPropose ? "Propose default" : "Set default"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
