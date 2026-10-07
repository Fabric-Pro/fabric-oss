"use client";

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
	ClipboardCheckIcon,
	DownloadIcon,
	FilePlusIcon,
	GitBranchIcon,
	HistoryIcon,
	Loader2Icon,
	MoreHorizontalIcon,
	RefreshCwIcon,
	SettingsIcon,
	UploadIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

type AddFileMode = "suggest" | "add" | "propose";

/**
 * What the tab's header offers. Every flag is decided by the published view,
 * which owns the permissions; this component only lays the actions out.
 */
export interface InstructionsActions {
	/**
	 * Upload folder when nothing is published, Upload new version when something
	 * is (History keeps the old one). `pausedReason` keeps the action on the
	 * page but disabled, with the reason a press gives, while a move into a
	 * repository has paused changes.
	 */
	upload?: {
		published: boolean;
		onClick: () => void;
		pausedReason?: string | null;
	};
	/**
	 * The branch's commits on a repository-backed project, the project's
	 * versions otherwise; the button says which.
	 */
	history?: { onOpen: () => void; commits?: boolean };
	download?: { pending: boolean; onDownload: () => void };
	/**
	 * `awaitingReview` is how many proposals wait for THIS viewer to decide. With
	 * some, the header carries a button with the count; with none the entry
	 * stays under More.
	 */
	proposals?: {
		label:
			| "suggestionsButton"
			| "reviewProposalsButton"
			| "proposalsButton";
		onOpen: () => void;
		awaitingReview?: number;
	};
	syncNow?: {
		label?: string;
		running: boolean;
		busy: boolean;
		onSync: () => void;
	};
	syncFromRepository?: { onOpen: () => void };
	/** Add file for an editor, Propose file for a reader, Suggest a change on a repository project. */
	addFile?: {
		mode: AddFileMode;
		onOpen: () => void;
		pausedReason?: string | null;
	};
	settings: { onOpen: () => void };
}

const ADD_FILE_LABEL: Record<
	AddFileMode,
	"addFileButton" | "proposeFileButton" | "suggestChangeButton"
> = {
	add: "addFileButton",
	propose: "proposeFileButton",
	suggest: "suggestChangeButton",
};

/** The shared menu item sets no gap between an icon and its label. */
const MENU_ITEM = "gap-2";

/**
 * The Coding Instructions tab's actions, in the order a person reaches for
 * them: what is waiting for their review, the two they read the tab with
 * (History, Download), everything else under More, and the one primary action
 * last, named for what it does. Connecting an agent is not here: it sits beside
 * the Fabric MCP fact it belongs to in the status strip.
 *
 * The page tour's anchors sit on the buttons themselves. A closed menu renders
 * none of its items, so what lives in the menu is one tour step, anchored on
 * the More button (`instructions-more-actions`), not one step per item.
 */
export function InstructionsActionBar({
	actions,
}: {
	actions: InstructionsActions;
}) {
	const t = useTranslations("projects.codingInstructions.publishedView");
	const {
		upload,
		history,
		download,
		proposals,
		syncNow,
		syncFromRepository,
		addFile,
		settings,
	} = actions;
	const awaitingReview = proposals?.awaitingReview ?? 0;
	const reviewInHeader = proposals !== undefined && awaitingReview > 0;

	return (
		<div
			className="flex flex-wrap items-center gap-2"
			data-testid="instructions-actions"
		>
			{proposals && reviewInHeader ? (
				<Button
					variant="outline"
					aria-label={t("reviewProposalsCountLabel", {
						count: awaitingReview,
					})}
					onClick={proposals.onOpen}
				>
					<ClipboardCheckIcon className="size-4" aria-hidden="true" />
					<span className="hidden sm:inline">
						{t(proposals.label)}
					</span>
					<span
						aria-hidden="true"
						className="min-w-5 rounded-full bg-highlight px-1.5 text-center font-mono text-[11px] text-highlight-foreground"
					>
						{awaitingReview}
					</span>
				</Button>
			) : null}
			{/* The secondary actions drop their labels below `sm` so the bar
			    stays within two rows on a phone; `aria-label` keeps the name. */}
			{history ? (
				<Button
					variant="outline"
					data-onboarding-target="coding-instructions-history"
					aria-label={t(
						history.commits ? "commitsButton" : "historyButton",
					)}
					onClick={history.onOpen}
				>
					<HistoryIcon className="size-4" aria-hidden="true" />
					<span className="hidden sm:inline">
						{t(history.commits ? "commitsButton" : "historyButton")}
					</span>
				</Button>
			) : null}
			{download ? (
				<Button
					variant="outline"
					disabled={download.pending}
					aria-label={t("downloadButton")}
					onClick={download.onDownload}
				>
					<DownloadIcon className="size-4" aria-hidden="true" />
					<span className="hidden sm:inline">
						{t("downloadButton")}
					</span>
				</Button>
			) : null}
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button
						variant="outline"
						size="icon"
						data-onboarding-target="instructions-more-actions"
						aria-label={t("moreButton")}
					>
						<MoreHorizontalIcon
							className="size-4"
							aria-hidden="true"
						/>
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end" className="min-w-52">
					{syncNow ? (
						<DropdownMenuItem
							className={MENU_ITEM}
							disabled={syncNow.busy}
							onSelect={syncNow.onSync}
						>
							{syncNow.busy ? (
								<Loader2Icon
									className="size-4 motion-safe:animate-spin"
									aria-hidden="true"
								/>
							) : (
								<RefreshCwIcon
									className="size-4"
									aria-hidden="true"
								/>
							)}
							{syncNow.label ??
								t(
									syncNow.running
										? "syncingButton"
										: "syncNowButton",
								)}
						</DropdownMenuItem>
					) : null}
					{syncFromRepository ? (
						<DropdownMenuItem
							className={MENU_ITEM}
							onSelect={syncFromRepository.onOpen}
						>
							<GitBranchIcon
								className="size-4"
								aria-hidden="true"
							/>
							{t("syncFromRepositoryButton")}
						</DropdownMenuItem>
					) : null}
					{proposals && !reviewInHeader ? (
						<DropdownMenuItem
							className={MENU_ITEM}
							onSelect={proposals.onOpen}
						>
							<ClipboardCheckIcon
								className="size-4"
								aria-hidden="true"
							/>
							{t(proposals.label)}
						</DropdownMenuItem>
					) : null}
					{addFile ? (
						<DropdownMenuItem
							className={
								addFile.pausedReason
									? `${MENU_ITEM} opacity-50`
									: MENU_ITEM
							}
							aria-disabled={
								addFile.pausedReason ? true : undefined
							}
							onSelect={
								addFile.pausedReason
									? () => toast.info(addFile.pausedReason)
									: addFile.onOpen
							}
						>
							<FilePlusIcon
								className="size-4"
								aria-hidden="true"
							/>
							{t(ADD_FILE_LABEL[addFile.mode])}
						</DropdownMenuItem>
					) : null}
					{syncNow ||
					syncFromRepository ||
					(proposals && !reviewInHeader) ||
					addFile ? (
						<DropdownMenuSeparator />
					) : null}
					<DropdownMenuItem
						className={MENU_ITEM}
						onSelect={settings.onOpen}
					>
						<SettingsIcon className="size-4" aria-hidden="true" />
						{t("settingsButton")}
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
			{upload ? (
				upload.pausedReason ? (
					// `aria-disabled`, not `disabled`: a disabled button is not
					// focusable, so the reason would be mouse-only. Pressing it
					// says why instead of doing nothing.
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								aria-disabled
								className="opacity-50"
								onClick={() => toast.info(upload.pausedReason)}
							>
								<UploadIcon
									className="size-4"
									aria-hidden="true"
								/>
								{upload.published
									? t("uploadNewVersionButton")
									: t("uploadButton")}
							</Button>
						</TooltipTrigger>
						<TooltipContent>{upload.pausedReason}</TooltipContent>
					</Tooltip>
				) : (
					<Button onClick={upload.onClick}>
						<UploadIcon className="size-4" aria-hidden="true" />
						{upload.published
							? t("uploadNewVersionButton")
							: t("uploadButton")}
					</Button>
				)
			) : null}
		</div>
	);
}
