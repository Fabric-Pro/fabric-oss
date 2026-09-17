"use client";

import { Button } from "@ui/components/button";
import { Card } from "@ui/components/card";
import {
	FolderIcon,
	GitBranchIcon,
	RefreshCwIcon,
	ShieldCheckIcon,
	TerminalSquareIcon,
	UploadIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";

export function InstructionsEmptyState({
	onUploadClick,
	repositoryName,
}: {
	projectId: string;
	onUploadClick: () => void;
	repositoryName?: string | null;
}) {
	const t = useTranslations("projects.codingInstructions.emptyState");
	return (
		<div className="flex flex-col gap-6">
			<div className="flex flex-col gap-1">
				<h1 className="font-semibold text-xl">{t("title")}</h1>
				<p className="max-w-2xl text-muted-foreground">
					{t("description")}
				</p>
			</div>
			<Card className="flex flex-col items-center gap-5 px-12 py-16 text-center">
				<div className="flex size-14 items-center justify-center rounded-xl bg-muted">
					<TerminalSquareIcon
						className="size-6 text-muted-foreground"
						aria-hidden="true"
					/>
				</div>
				<div className="flex max-w-lg flex-col gap-1.5">
					<h2 className="font-semibold text-lg">{t("heading")}</h2>
					<p className="text-muted-foreground">
						{t.rich("body", {
							claudeDir: (chunks) => <code>{chunks}</code>,
							claudeMd: (chunks) => <code>{chunks}</code>,
						})}
					</p>
				</div>
				<div className="flex gap-2.5">
					<Button onClick={onUploadClick}>
						<UploadIcon className="size-4" aria-hidden="true" />
						{t("uploadButton")}
					</Button>
					<Button
						variant="outline"
						disabled
						title={t("syncButtonTitle")}
					>
						<GitBranchIcon className="size-4" aria-hidden="true" />
						{t("syncButton")}
					</Button>
				</div>
				{repositoryName ? (
					<p className="text-muted-foreground text-xs">
						{t.rich("connectedRepository", {
							repo: () => <code>{repositoryName}</code>,
						})}
					</p>
				) : null}
			</Card>
			<div className="grid grid-cols-1 gap-4 md:grid-cols-3">
				<Card className="flex flex-col gap-1.5 p-5">
					<div className="flex items-center gap-2 font-semibold">
						<ShieldCheckIcon
							className="size-4"
							aria-hidden="true"
						/>
						{t("secretsTitle")}
					</div>
					<p className="text-muted-foreground">
						{t("secretsDescription")}
					</p>
				</Card>
				<Card className="flex flex-col gap-1.5 p-5">
					<div className="flex items-center gap-2 font-semibold">
						<FolderIcon className="size-4" aria-hidden="true" />
						{t("historyTitle")}
					</div>
					<p className="text-muted-foreground">
						{t.rich("historyDescription", {
							tasksDir: (chunks) => <code>{chunks}</code>,
							fabricignore: (chunks) => <code>{chunks}</code>,
						})}
					</p>
				</Card>
				<Card className="flex flex-col gap-1.5 p-5">
					<div className="flex items-center gap-2 font-semibold">
						<RefreshCwIcon className="size-4" aria-hidden="true" />
						{t("developersTitle")}
					</div>
					<p className="text-muted-foreground">
						{t("developersDescription")}
					</p>
				</Card>
			</div>
		</div>
	);
}
