"use client";

/**
 * Multi-select of connected repositories for the Atlas System map. Distinct from
 * the single-select `AtlasRepoSelector` (used by the per-repo views) —
 * this one lets the user choose which connected repos to combine. At least one
 * selection is always kept. Only repos with a real integration id are
 * selectable (the legacy single repository belongs to the per-repo view).
 */
import type { RepoOption } from "@repo/atlas/types";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ui/components/popover";
import { cn } from "@ui/lib";
import { CheckIcon, ChevronDownIcon, FolderGitIcon } from "lucide-react";
import { useTranslations } from "next-intl";

interface AtlasRepoMultiSelectProps {
	repositories: RepoOption[];
	/** Selected repositoryIntegrationIds. */
	value: string[];
	onChange: (ids: string[]) => void;
	disabled?: boolean;
}

export function AtlasRepoMultiSelect({
	repositories,
	value,
	onChange,
	disabled = false,
}: AtlasRepoMultiSelectProps) {
	const t = useTranslations("projects.atlas.system");
	const selectable = repositories.filter(
		(r) => r.repositoryIntegrationId !== null,
	);
	const selected = new Set(value);

	const toggle = (id: string) => {
		const next = new Set(selected);
		if (next.has(id)) {
			// Keep at least one selected.
			if (next.size <= 1) {
				return;
			}
			next.delete(id);
		} else {
			next.add(id);
		}
		onChange(
			selectable
				.map((r) => r.repositoryIntegrationId as string)
				.filter((id) => next.has(id)),
		);
	};

	const selectAll = () =>
		onChange(selectable.map((r) => r.repositoryIntegrationId as string));

	return (
		<Popover>
			<PopoverTrigger asChild>
				<button
					type="button"
					disabled={disabled}
					className={cn(
						"inline-flex h-8 items-center gap-1.5 rounded-lg border border-border/60 bg-transparent px-2.5 text-sm font-medium text-foreground",
						"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
						disabled && "cursor-not-allowed opacity-60",
					)}
				>
					<FolderGitIcon
						aria-hidden="true"
						className="size-4 shrink-0 text-muted-foreground"
					/>
					<span>
						{t("reposSelected", {
							count: selected.size,
							total: selectable.length,
						})}
					</span>
					<ChevronDownIcon
						aria-hidden="true"
						className="size-4 text-muted-foreground"
					/>
				</button>
			</PopoverTrigger>
			<PopoverContent align="end" className="w-64 p-2">
				<div className="mb-1.5 flex items-center justify-between px-1">
					<span className="font-medium text-[11px] text-muted-foreground uppercase tracking-[0.12em]">
						{t("reposLabel")}
					</span>
					<button
						type="button"
						className="text-[12px] text-primary hover:underline"
						onClick={selectAll}
					>
						{t("selectAll")}
					</button>
				</div>
				<ul className="flex max-h-72 flex-col gap-0.5 overflow-y-auto">
					{selectable.map((repo) => {
						const id = repo.repositoryIntegrationId as string;
						const isOn = selected.has(id);
						return (
							<li key={id}>
								<button
									type="button"
									aria-pressed={isOn}
									onClick={() => toggle(id)}
									className={cn(
										"flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm",
										"hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
									)}
								>
									<span
										className={cn(
											"grid size-4 shrink-0 place-items-center rounded border",
											isOn
												? "border-primary bg-primary text-primary-foreground"
												: "border-border",
										)}
									>
										{isOn && (
											<CheckIcon
												aria-hidden="true"
												className="size-3"
											/>
										)}
									</span>
									<span className="min-w-0 flex-1 truncate">
										{repo.repositoryName}
									</span>
									{repo.isDefault && (
										<span className="text-[10px] text-muted-foreground uppercase tracking-[0.12em]">
											{t("default")}
										</span>
									)}
								</button>
							</li>
						);
					})}
				</ul>
			</PopoverContent>
		</Popover>
	);
}
