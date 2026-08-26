"use client";

import type { RepoOption } from "@repo/atlas/types";
/**
 * Repository picker for the Atlas tab. Only rendered when the project
 * has more than one analysable repository (R11). Selecting a repo re-scopes the
 * status / graph / chat queries upstream via `onChange`.
 */
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { FolderGitIcon } from "lucide-react";
import { useTranslations } from "next-intl";

interface AtlasRepoSelectorProps {
	repositories: RepoOption[];
	/** Currently scoped repository integration id (null = project default). */
	value: string | null;
	onChange: (repositoryIntegrationId: string | null) => void;
	disabled?: boolean;
}

// Sentinel for the "project default" option — Radix Select needs a non-empty
// string value, so null is encoded as this constant on the wire.
const DEFAULT_VALUE = "__default__";

export function AtlasRepoSelector({
	repositories,
	value,
	onChange,
	disabled = false,
}: AtlasRepoSelectorProps) {
	const t = useTranslations("projects.atlas.repo");

	// When no repo is explicitly chosen, the backend analyses the project's
	// default (or first) repo. Reflect that resolved repo in the trigger so the
	// active repository is always visible — never a blank selector.
	const effectiveValue =
		value ??
		repositories.find((repo) => repo.isDefault)?.repositoryIntegrationId ??
		repositories[0]?.repositoryIntegrationId ??
		DEFAULT_VALUE;

	return (
		<Select
			value={effectiveValue}
			disabled={disabled}
			onValueChange={(next) =>
				onChange(next === DEFAULT_VALUE ? null : next)
			}
		>
			<SelectTrigger
				aria-label={t("label")}
				className="h-8 w-auto max-w-[40vw] gap-1.5 border-border/60 bg-transparent px-2.5 text-sm font-medium text-foreground"
			>
				<FolderGitIcon
					aria-hidden="true"
					className="size-4 shrink-0 text-muted-foreground"
				/>
				<SelectValue placeholder={t("placeholder")} />
			</SelectTrigger>
			<SelectContent>
				{repositories.map((repo) => {
					const optionValue =
						repo.repositoryIntegrationId ?? DEFAULT_VALUE;
					return (
						<SelectItem key={optionValue} value={optionValue}>
							<span className="flex items-center gap-2">
								<span className="truncate">
									{repo.repositoryName}
								</span>
								{repo.isDefault && (
									<span className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
										{t("default")}
									</span>
								)}
							</span>
						</SelectItem>
					);
				})}
			</SelectContent>
		</Select>
	);
}
