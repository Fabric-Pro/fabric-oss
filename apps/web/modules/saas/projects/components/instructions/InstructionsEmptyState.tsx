"use client";

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { ConnectCliDialog } from "@saas/projects/components/cli-connection/ConnectCliDialog";
import { Button } from "@ui/components/button";
import { Card } from "@ui/components/card";
import {
	FolderIcon,
	GitBranchIcon,
	PlugIcon,
	RefreshCwIcon,
	ShieldCheckIcon,
	TerminalSquareIcon,
	UploadIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";

export function InstructionsEmptyState({
	projectId,
	projectName,
	onUploadClick,
	canUpload = true,
	repositoryName,
	localSyncAvailable = false,
}: {
	projectId: string;
	/** Named in the "Connect your agent" starter instruction. */
	projectName: string;
	onUploadClick: () => void;
	/** Folder uploads create a direct snapshot and are unavailable to readers or repository-backed projects. */
	canUpload?: boolean;
	repositoryName?: string | null;
	/**
	 * Whether the Connect dialog offers `fabric instructions init`. True when
	 * Fabric authors this project's instructions. Before anything is
	 * published the command installs the session-start check and copies
	 * nothing; the check then reports the first version when it arrives.
	 */
	localSyncAvailable?: boolean;
}) {
	const t = useTranslations("projects.codingInstructions.emptyState");
	const [connectOpen, setConnectOpen] = useState(false);
	// Fails closed the same way InstructionsPublishedView does: with no
	// organization id there is nothing to mint the key against. An invited
	// guest views this project under the HOST organization's thin record
	// (`isGuest: true`) and has no membership row there, so the create
	// procedure's host-membership check would refuse them — hide the
	// action for them instead of surfacing a FORBIDDEN.
	const { organizationId, organizationSlug, isGuest } =
		useOrganizationContext();
	const canConnectAgent = Boolean(organizationId) && !isGuest;
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
					{canUpload ? (
						<Button onClick={onUploadClick}>
							<UploadIcon className="size-4" aria-hidden="true" />
							{t("uploadButton")}
						</Button>
					) : null}
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
					{canConnectAgent ? (
						<Button
							className="w-fit"
							size="sm"
							variant="outline"
							onClick={() => setConnectOpen(true)}
						>
							<PlugIcon className="size-4" aria-hidden="true" />
							{t("connectButton")}
						</Button>
					) : null}
				</Card>
			</div>
			{canConnectAgent && organizationId ? (
				<ConnectCliDialog
					open={connectOpen}
					onOpenChange={setConnectOpen}
					organizationId={organizationId}
					organizationSlug={organizationSlug ?? undefined}
					projectName={projectName}
					purpose="coding-instructions"
					projectId={projectId}
					localSyncAvailable={localSyncAvailable}
				/>
			) : null}
		</div>
	);
}
