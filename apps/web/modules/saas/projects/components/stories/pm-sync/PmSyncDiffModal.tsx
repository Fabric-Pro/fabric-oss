"use client";

import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { cn } from "@ui/lib";
import { ExternalLinkIcon } from "lucide-react";
import { type PmSyncError, PmSyncErrorPanel } from "./pmSyncError";

type PmDiffSide = {
	title: string;
	description: string;
};

type Props = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	pmToolName: string;
	pmCurrent?: PmDiffSide;
	fabricProposed: PmDiffSide;
	pmUrl?: string;
	onPushAnyway: () => void;
	onSkip: () => void;
	isPushing?: boolean;
	/**
	 * When set, the current user's PM connection couldn't load the PM side
	 * (credentials missing/expired, etc). The modal then shows an actionable
	 * error in place of the diff and offers only "Skip this one" — pushing
	 * would fail without a working connection.
	 */
	pmError?: PmSyncError;
	pmTool?: string | null;
	settingsHref?: string;
};

/**
 * Validate that a URL is a safe http/https external URL.
 * Returns undefined for any other scheme (e.g. `javascript:`) — `rel`
 * attributes do not block scheme-based execution, so we must filter here.
 */
function getSafeExternalUrl(url: string | undefined): string | undefined {
	if (!url) {
		return undefined;
	}
	const trimmed = url.trim();
	if (/^https?:\/\//i.test(trimmed)) {
		return trimmed;
	}
	return undefined;
}

export function PmSyncDiffModal({
	open,
	onOpenChange,
	pmToolName,
	pmCurrent,
	fabricProposed,
	pmUrl,
	onPushAnyway,
	onSkip,
	isPushing,
	pmError,
	pmTool,
	settingsHref,
}: Props) {
	const safePmUrl = getSafeExternalUrl(pmUrl);
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				className="max-w-3xl bg-card border border-border"
				onInteractOutside={(e) => {
					if (isPushing) {
						e.preventDefault();
					}
				}}
			>
				<DialogHeader className="space-y-2">
					<DialogTitle
						className="font-normal text-2xl"
						style={{ fontFamily: "var(--font-serif)" }}
					>
						{pmError
							? `Couldn't check ${pmToolName}`
							: "PM ticket has changed"}
					</DialogTitle>
					<p className="text-sm text-muted-foreground">
						{pmError
							? `We couldn't load this item's ${pmToolName} version, so its conflict status is unknown.`
							: `Someone edited this ticket in ${pmToolName} after your last sync. Choose how to proceed.`}
					</p>
				</DialogHeader>

				{pmError ? (
					<PmSyncErrorPanel
						error={pmError}
						pmTool={pmTool ?? null}
						settingsHref={settingsHref}
						className="my-1"
					/>
				) : pmCurrent ? (
					<div className="grid grid-cols-1 gap-4 md:grid-cols-2">
						<DiffColumn
							label={`${pmToolName.toUpperCase()} CURRENT`}
							editorialLabel="PM CURRENT"
							side={pmCurrent}
						/>
						<DiffColumn
							label="FABRIC PROPOSED"
							editorialLabel="FABRIC PROPOSED"
							side={fabricProposed}
						/>
					</div>
				) : null}

				<div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:items-center sm:justify-between">
					{safePmUrl ? (
						<Button
							variant="ghost"
							size="sm"
							asChild
							className="text-muted-foreground hover:text-foreground"
						>
							<a
								href={safePmUrl}
								target="_blank"
								rel="noopener noreferrer"
							>
								<ExternalLinkIcon
									className="size-3.5 mr-1.5"
									aria-hidden="true"
								/>
								Open in {pmToolName}
							</a>
						</Button>
					) : (
						<span />
					)}
					<div className="flex flex-col gap-2 sm:flex-row">
						<Button
							variant="outline"
							size="sm"
							onClick={() => {
								onSkip();
								onOpenChange(false);
							}}
							disabled={isPushing}
						>
							Skip this one
						</Button>
						{pmError ? null : (
							<Button
								variant="destructive"
								size="sm"
								onClick={onPushAnyway}
								disabled={isPushing}
							>
								{isPushing ? "Pushing…" : "Push anyway"}
							</Button>
						)}
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}

function DiffColumn({
	label,
	editorialLabel,
	side,
}: {
	label: string;
	editorialLabel: string;
	side: PmDiffSide;
}) {
	return (
		<section
			aria-label={label}
			className="rounded-md border border-border bg-muted/40 p-4 space-y-3"
		>
			<span className="editorial-label">{editorialLabel}</span>
			<div className="space-y-2">
				<DiffField fieldLabel="Title" value={side.title} />
				<DiffField fieldLabel="Description" value={side.description} />
			</div>
		</section>
	);
}

function DiffField({
	fieldLabel,
	value,
}: {
	fieldLabel: string;
	value: string;
}) {
	return (
		<div className="space-y-1">
			<span
				className={cn(
					"block text-[10px] font-medium uppercase tracking-[0.2em]",
					"text-muted-foreground",
				)}
			>
				{fieldLabel}
			</span>
			<p className="whitespace-pre-wrap break-words text-sm text-foreground">
				{value || (
					<span className="italic text-muted-foreground">empty</span>
				)}
			</p>
		</div>
	);
}
