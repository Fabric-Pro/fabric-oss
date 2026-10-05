"use client";

import { Label } from "@ui/components/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { useTranslations } from "next-intl";
import type { RepositorySyncIntegration } from "../../lib/instructions-repository-sync";

/**
 * The repository a project's coding instructions are pointed at, as the
 * configure dialog and the move dialog both choose it: a select when the
 * project has several connected repositories, a plain line when it has one.
 * Choosing hands back the whole integration, so the caller can also take its
 * default branch.
 */
export function RepositoryChoice({
	integrations,
	integrationId,
	onChoose,
}: {
	/** ACTIVE integrations only, as `repositorySync.get` returns them. */
	integrations: RepositorySyncIntegration[];
	integrationId: string;
	onChoose: (integration: RepositorySyncIntegration) => void;
}) {
	const t = useTranslations("projects.codingInstructions.repositorySync");
	const selected = integrations.find((i) => i.id === integrationId) ?? null;
	if (integrations.length > 1) {
		return (
			<div className="flex flex-col gap-1.5">
				<Label htmlFor="instructions-sync-repository">
					{t("configureDialog.repositoryLabel")}
				</Label>
				<Select
					value={integrationId}
					onValueChange={(value) => {
						const next = integrations.find((i) => i.id === value);
						if (next) {
							onChoose(next);
						}
					}}
				>
					<SelectTrigger id="instructions-sync-repository">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{integrations.map((i) => (
							<SelectItem key={i.id} value={i.id}>
								{`${t(`providers.${i.provider}`)} · ${i.repositoryOwner}/${i.repositoryName}`}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>
		);
	}
	return selected ? (
		<p className="text-sm">
			<span className="text-muted-foreground">
				{t("configureDialog.repositoryLabel")}:{" "}
			</span>
			<span>{`${selected.repositoryOwner}/${selected.repositoryName}`}</span>
		</p>
	) : null;
}
