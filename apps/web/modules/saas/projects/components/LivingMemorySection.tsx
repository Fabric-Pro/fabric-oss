"use client";

import { FolderSyncIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { type ReactNode, useId } from "react";
import type { ContextSyncState } from "../lib/context-repository-sync";
import { ContextRepositorySyncStatus } from "./ContextRepositorySyncStatus";

/**
 * The Context tab's Living Memory section: its heading, the repository-sync
 * entry point and status (Fizzy #2657), and the synced folders as `children`.
 *
 * Shown whenever there is a synced file or something the sync status can say
 * (a configuration, a configurer's "Sync from repository" offer, or a failed
 * read of the state). The tab renders it whether or not the project has any
 * context: a sync whose every run fails leaves no synced file, and its failure
 * and the offer to set one up must not hide behind the empty state.
 */
export function LivingMemorySection({
	projectId,
	organizationId,
	state,
	readFailed,
	onRetry,
	onChanged,
	children,
}: {
	projectId: string;
	organizationId: string | null;
	state: ContextSyncState | undefined;
	readFailed: boolean;
	onRetry: () => void;
	onChanged: () => void;
	children?: ReactNode;
}) {
	const t = useTranslations("projects.contexts.livingMemory");
	const titleId = useId();
	return (
		<section
			aria-labelledby={titleId}
			className="space-y-3"
			data-testid="context-living-memory"
		>
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div>
					<h3
						id={titleId}
						className="flex items-center gap-2 font-semibold text-sm"
					>
						<FolderSyncIcon
							className="size-4 shrink-0 text-primary"
							aria-hidden="true"
						/>
						{t("title")}
					</h3>
					<p className="mt-1 text-foreground/50 text-xs">
						{t("description")}
					</p>
				</div>
				<ContextRepositorySyncStatus
					projectId={projectId}
					organizationId={organizationId}
					state={state}
					readFailed={readFailed}
					onRetry={onRetry}
					onChanged={onChanged}
				/>
			</div>
			{children}
		</section>
	);
}
