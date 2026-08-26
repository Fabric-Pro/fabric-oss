"use client";

import { prefixDiffPart } from "@shared/lib/line-diff";
import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { cn } from "@ui/lib";
import { diffLines } from "diff";
import { Loader2Icon, RotateCcwIcon } from "lucide-react";
import { useMemo } from "react";

type ComparableVersion = {
	id: string;
	version: number;
	content: string;
	changeNote?: string | null;
};

type Props = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	version: ComparableVersion;
	/** Body of the prompt's latest version — the right-hand side of the diff. */
	currentContent: string;
	currentVersionNumber: number;
	/** Same gate as editing: non-SYSTEM prompts, or SYSTEM for platform admins. */
	canRestore: boolean;
	isRestoring: boolean;
	onRestore: (content: string, fromVersion: number) => void;
};

/**
 * Show an older prompt version against the current one, and offer to bring it
 * back.
 *
 * Restoring saves the old body forward as a NEW version rather than rewriting
 * history — `createPromptVersion` then advances same-scope bindings onto it, so
 * the restore reaches agent runs the same way an ordinary edit does. Nothing is
 * deleted, so a restore is itself undoable from this same dialog.
 */
export function PromptVersionCompareDialog({
	open,
	onOpenChange,
	version,
	currentContent,
	currentVersionNumber,
	canRestore,
	isRestoring,
	onRestore,
}: Props) {
	const parts = useMemo(
		() => diffLines(version.content, currentContent),
		[version.content, currentContent],
	);

	const isIdentical = version.content === currentContent;

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="flex max-h-[90vh] flex-col overflow-hidden sm:max-w-3xl">
				<DialogHeader>
					<DialogTitle>
						Version v{version.version} vs current (v
						{currentVersionNumber})
					</DialogTitle>
					<DialogDescription>
						{isIdentical
							? "This version is identical to the current one."
							: "Lines removed since this version are marked with −, lines added with +."}
					</DialogDescription>
				</DialogHeader>

				{version.changeNote && (
					<p className="text-muted-foreground text-sm">
						{version.changeNote}
					</p>
				)}

				<pre
					data-testid="prompt-version-diff"
					className="min-h-0 flex-1 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs"
				>
					{parts.map((part, index) => (
						<span
							key={`${index}-${part.value.length}`}
							className={cn(
								part.added &&
									"bg-emerald-500/15 text-emerald-800 dark:text-emerald-300",
								part.removed &&
									"bg-red-500/15 text-red-800 dark:text-red-300",
							)}
						>
							{prefixDiffPart(part)}
						</span>
					))}
				</pre>

				<DialogFooter>
					<Button
						variant="outline"
						onClick={() => onOpenChange(false)}
					>
						Close
					</Button>
					{canRestore && (
						<Button
							disabled={isIdentical || isRestoring}
							onClick={() =>
								onRestore(version.content, version.version)
							}
						>
							{isRestoring ? (
								<Loader2Icon className="mr-2 h-4 w-4 animate-spin" />
							) : (
								<RotateCcwIcon className="mr-2 h-4 w-4" />
							)}
							Restore this version
						</Button>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
