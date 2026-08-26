"use client";

/**
 * "Re-map relationships" control for the Atlas graph + System map.
 *
 * A split-less dropdown button (mirrors the Re-analyse split button's visual
 * language — same outline button + recompute icon + chevron menu) offering two
 * regeneration modes:
 *
 *  - Re-map (keep my edits)  — `fresh: false`. Regenerates the AI-derived
 *    connections while preserving the user's manual / edited / deleted edges.
 *  - Re-map fresh…           — `fresh: true`. DESTRUCTIVE: behind an explicit
 *    confirmation (AlertDialog) because it permanently wipes ALL of the user's
 *    edge edits, manual connections, deletions and their history across BOTH
 *    the Business and Technical lenses before regenerating.
 *
 * The same component drives both scopes — `scope="solo"` (one repo's intra-repo
 * references, `remapSolo`) and `scope="system"` (the cross-repo relationships,
 * `remapSystem`). Only the menu/button copy adapts; the orchestrator owns the
 * mutation and passes `onRemap(fresh)` + `isPending`.
 */
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@ui/components/alert-dialog";
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
import { cn } from "@ui/lib";
import {
	ChevronDownIcon,
	Loader2Icon,
	RefreshCwIcon,
	Trash2Icon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";

interface AtlasRemapMenuProps {
	/**
	 * Which relationships are being re-mapped: a single repo's intra-repo
	 * references ("solo") or the cross-repo System-map relationships ("system").
	 * Drives only the button/menu copy — the mutation lives in the orchestrator.
	 */
	scope: "solo" | "system";
	/** Fire the re-map. `fresh: true` is the destructive reset variant. */
	onRemap: (fresh: boolean) => void;
	/** A re-map mutation is in flight — show a spinner and disable both items. */
	isPending: boolean;
	/** Externally disable (e.g. credentials dead / no analysis yet). */
	disabled?: boolean;
}

export function AtlasRemapMenu({
	scope,
	onRemap,
	isPending,
	disabled = false,
}: AtlasRemapMenuProps) {
	const t = useTranslations("projects.atlas.remap");
	// The destructive "Re-map fresh" path opens a confirm dialog; the dropdown
	// closes first (Radix), then the dialog is the only thing on screen.
	const [confirmOpen, setConfirmOpen] = useState(false);

	const buttonLabel =
		scope === "system" ? t("systemButton") : t("soloButton");
	const isDisabled = disabled || isPending;

	return (
		<>
			<div className="inline-flex items-center">
				<Tooltip>
					<TooltipTrigger asChild>
						{/* A disabled trigger emits no pointer events, so the
						    tooltip sits on a wrapper span that still receives
						    hover/focus. */}
						<span className="inline-flex">
							<DropdownMenu>
								<DropdownMenuTrigger asChild>
									<Button
										type="button"
										size="sm"
										variant="outline"
										disabled={isDisabled}
										aria-label={buttonLabel}
										className="gap-1.5"
									>
										{isPending ? (
											<>
												<Loader2Icon
													aria-hidden="true"
													className="size-4 motion-safe:animate-spin"
												/>
												{t("pending")}
											</>
										) : (
											<>
												<RefreshCwIcon
													aria-hidden="true"
													className="size-4"
												/>
												{t("button")}
												<ChevronDownIcon
													aria-hidden="true"
													className="size-4 text-muted-foreground"
												/>
											</>
										)}
									</Button>
								</DropdownMenuTrigger>
								<DropdownMenuContent
									align="end"
									className="w-72"
								>
									<DropdownMenuItem
										onSelect={() => onRemap(false)}
										disabled={isPending}
										className="flex-col items-start gap-0.5"
									>
										<span className="flex items-center gap-1.5 font-medium">
											<RefreshCwIcon
												aria-hidden="true"
												className="size-3.5"
											/>
											{t("keep")}
										</span>
										<span className="text-xs text-muted-foreground">
											{t("keepHint")}
										</span>
									</DropdownMenuItem>
									<DropdownMenuSeparator />
									<DropdownMenuItem
										// Opening a dialog from a menu item: let the
										// menu close on select, then open the confirm
										// on the next tick so focus lands cleanly in
										// the dialog (Radix focus management).
										onSelect={(event) => {
											event.preventDefault();
											setConfirmOpen(true);
										}}
										disabled={isPending}
										className="flex-col items-start gap-0.5 text-destructive focus:text-destructive"
									>
										<span className="flex items-center gap-1.5 font-medium">
											<Trash2Icon
												aria-hidden="true"
												className="size-3.5"
											/>
											{t("fresh")}
										</span>
										<span className="text-xs text-muted-foreground">
											{t("freshHint")}
										</span>
									</DropdownMenuItem>
								</DropdownMenuContent>
							</DropdownMenu>
						</span>
					</TooltipTrigger>
					<TooltipContent>{buttonLabel}</TooltipContent>
				</Tooltip>
			</div>

			{/* Destructive confirmation — required before a fresh re-map wipes the
			    user's edits/deletions across both lenses. */}
			<AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>{t("confirmTitle")}</AlertDialogTitle>
						<AlertDialogDescription>
							{t("confirmBody")}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
						<AlertDialogAction
							className={cn(
								"bg-destructive text-white",
								"hover:bg-destructive/90",
								"focus-visible:ring-destructive/40",
							)}
							onClick={() => {
								setConfirmOpen(false);
								onRemap(true);
							}}
						>
							{t("confirmAction")}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
}
