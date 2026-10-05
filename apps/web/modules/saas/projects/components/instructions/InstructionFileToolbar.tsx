"use client";

import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import {
	CopyIcon,
	MoreHorizontalIcon,
	SquarePenIcon,
	Trash2Icon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { type ReactNode, useState } from "react";
import type { ChangeMark } from "../../lib/instructions-base-changes";
import { formatFileSize } from "../../lib/instructions-file-size";

/** One entry of the File actions menu. */
export type FileMenuAction = {
	onSelect: () => void;
	/**
	 * Why the action cannot run right now, or null. The item stays on the menu
	 * and says so when pressed: a move into a repository pauses every change.
	 */
	refusal: string | null;
	/** An action is already running. */
	busy: boolean;
};

/**
 * The bar above a file: its path in full ink, what kind of file it is, whether
 * the published version added or changed it, its size, and what can be done
 * with it. Edit is the one visible action. Copy path is an icon, and Rename
 * and Delete file sit in the File actions menu, so the destructive one is not a
 * button's width from Edit.
 *
 * `edit` is the Edit control, built by the file view (it has to explain a
 * refusal and carries the Commit tour anchor); `menu` is absent when nobody
 * viewing may change the file.
 */
export function InstructionFileToolbar({
	path,
	kindLabel,
	fromBranch,
	change,
	version,
	size,
	onCopyPath,
	edit,
	menu,
}: {
	path: string;
	kindLabel: string;
	fromBranch: boolean;
	/** How the published version differs from the one it was edited from, for this file. */
	change: ChangeMark | null;
	/** The published version, named in the change badge. */
	version: number;
	size: number;
	/** Resolves true when the path reached the clipboard. */
	onCopyPath: () => Promise<boolean>;
	edit: ReactNode;
	menu: {
		/** Absent where rename is not offered. */
		rename?: FileMenuAction;
		delete: FileMenuAction;
	} | null;
}) {
	const t = useTranslations("projects.codingInstructions.fileView");
	const [copied, setCopied] = useState(false);
	const [tooltipOpen, setTooltipOpen] = useState(false);

	return (
		<div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-border border-b bg-muted/40 py-2.5 pr-3 pl-4">
			<div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
				<code className="min-w-0 truncate text-foreground text-xs">
					{path}
				</code>
				<Badge variant="secondary">{kindLabel}</Badge>
				{fromBranch ? (
					<Badge variant="outline">{t("fromBranchLabel")}</Badge>
				) : null}
				{change ? (
					<Badge variant={change === "added" ? "success" : "warning"}>
						{t(
							change === "added"
								? "addedInVersion"
								: "changedInVersion",
							{ version },
						)}
					</Badge>
				) : null}
				<span className="text-muted-foreground text-xs">
					{formatFileSize(size)}
				</span>
			</div>
			<div className="flex items-center gap-1.5">
				<Tooltip
					open={tooltipOpen}
					onOpenChange={(next) => {
						setTooltipOpen(next);
						if (!next) {
							setCopied(false);
						}
					}}
				>
					<TooltipTrigger asChild>
						<Button
							size="icon-sm"
							variant="ghost"
							aria-label={t("copyPath")}
							onClick={() => {
								// Not returned: the shared Button keeps a spinner up
								// until a returned promise settles, and a clipboard
								// write can stay pending indefinitely (document not
								// focused, permission blocked), so the button spun
								// forever. Fire it, report the outcome, move on.
								void onCopyPath().then((ok) => {
									setCopied(ok);
									setTooltipOpen(ok);
								});
							}}
						>
							<CopyIcon className="size-4" aria-hidden="true" />
						</Button>
					</TooltipTrigger>
					<TooltipContent>
						{copied ? t("copiedTooltip") : t("copyPath")}
					</TooltipContent>
				</Tooltip>
				{edit}
				{menu ? (
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button
								size="icon-sm"
								variant="ghost"
								aria-label={t("fileActions")}
							>
								<MoreHorizontalIcon
									className="size-4"
									aria-hidden="true"
								/>
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end" className="min-w-44">
							{menu.rename ? (
								<>
									<DropdownMenuItem
										className={`gap-2 ${menu.rename.refusal ? "opacity-50" : ""}`}
										aria-disabled={
											menu.rename.refusal
												? true
												: undefined
										}
										disabled={menu.rename.busy}
										onSelect={menu.rename.onSelect}
									>
										<SquarePenIcon
											className="size-4"
											aria-hidden="true"
										/>
										{t("renameButton")}
									</DropdownMenuItem>
									<DropdownMenuSeparator />
								</>
							) : null}
							<DropdownMenuItem
								className={`gap-2 text-destructive focus:text-destructive ${menu.delete.refusal ? "opacity-50" : ""}`}
								aria-disabled={
									menu.delete.refusal ? true : undefined
								}
								disabled={menu.delete.busy}
								onSelect={menu.delete.onSelect}
							>
								<Trash2Icon
									className="size-4"
									aria-hidden="true"
								/>
								{t("deleteButton")}
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				) : null}
			</div>
		</div>
	);
}
