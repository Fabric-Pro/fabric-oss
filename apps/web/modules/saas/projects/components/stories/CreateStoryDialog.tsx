"use client";

import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { Label } from "@ui/components/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { Textarea } from "@ui/components/textarea";
import { Loader2Icon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import {
	type CreateStoryInput,
	PRIORITY_OPTIONS,
	SIZE_OPTIONS,
	type StoryStatus,
} from "../../lib/stories/types";
import type { PendingDocAttachment } from "../../lib/text-attachment-validation";
import { AttachmentsField } from "./AttachmentsField";
import { CreateStoryDocAttachmentsField } from "./CreateStoryDocAttachmentsField";

/**
 * Shape the dialog needs from the create-story mutation result so it can fire
 * the soft-warn toast when the server-side title generator fell back to the
 * timestamped placeholder. The server returns either the kebab-case helper
 * source (`"untitled-fallback"`) or the SCREAMING_SNAKE Prisma enum value
 * (`"UNTITLED_FALLBACK"`); the dialog accepts both so wire-shape evolution
 * doesn't silently break the warning toast.
 */
interface CreateStoryDialogResult {
	titleSource?:
		| "ai"
		| "description-fallback"
		| "untitled-fallback"
		| "AI"
		| "DESCRIPTION_FALLBACK"
		| "UNTITLED_FALLBACK"
		| null;
}

export interface CreateStoryDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	statusId: string | null;
	statuses?: StoryStatus[];
	projectId: string;
	/**
	 * Caller drives the create mutation and resolves with the new row's
	 * `titleSource` so the dialog can fire the loading / success / warning
	 * toasts. Returning `undefined` is tolerated (treated as "title source
	 * unknown" — no soft-warn fires). Rejecting transitions the loading toast
	 * to the failure toast.
	 */
	onSubmit: (
		data: CreateStoryInput,
		files: File[],
		docAttachments: PendingDocAttachment[],
	) =>
		| CreateStoryDialogResult
		| undefined
		| Promise<CreateStoryDialogResult | undefined>;
	isSubmitting: boolean;
}

/**
 * Kanban / Roadmap Add dialog. Single entry point — the classifier in
 * createStoryFromProposal decides BUG vs FEATURE from the description text
 * server-side (F-171). The form only collects description / priority / size.
 *
 * Toast lifecycle: `toast.loading` fires on submit and is
 * upgraded in-place to `toast.success` or `toast.error` via the sonner
 * `{ id }` idiom. A separate `toast.warning` fires after success when the
 * server returns the timestamped-untitled fallback. We intentionally do NOT
 * differentiate `is_insufficient` from system-failure at the UI — both produce
 * `titleSource: UNTITLED_FALLBACK` on the wire. Telemetry distinguishes via
 * `logModelUsageAsync.metadata.isInsufficient` server-side.
 */
export function CreateStoryDialog({
	open,
	onOpenChange,
	statusId,
	projectId,
	onSubmit,
	isSubmitting,
}: CreateStoryDialogProps) {
	const tCreate = useTranslations("projects.stories.create");
	const [description, setDescription] = useState("");
	const [priority, setPriority] = useState<string>("P2_MEDIUM");
	const [size, setSize] = useState<string>("");
	const [pendingFiles, setPendingFiles] = useState<File[]>([]);
	const [pendingDocs, setPendingDocs] = useState<PendingDocAttachment[]>([]);
	// Tracks the entire async onSubmit chain (create + uploads + updateStory).
	// `isSubmitting` (from props) only mirrors the create mutation's isPending,
	// which flips back to false as soon as create resolves — opening a window
	// where the user could click Create again while uploads/update are still
	// in flight. `isOrchestrating` stays true until the awaited onSubmit
	// resolves (Codex review of PR 1: double-submit guard).
	const [isOrchestrating, setIsOrchestrating] = useState(false);

	const titleText = "Create work item";
	const subtitleText =
		"Describe what's needed or what's broken — the system classifies it as a feature or a bug.";

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!description.trim()) {
			return;
		}

		// Title and kind are intentionally omitted — the server generates a
		// title from the description and the classifier decides the kind.
		const payload: CreateStoryInput = {
			projectId,
			statusId: statusId ?? undefined,
			description: description.trim(),
			priority: priority as CreateStoryInput["priority"],
			size: size ? (size as CreateStoryInput["size"]) : undefined,
		};

		// TODO(Group 8 — i18n): once the new keys land in `de.json`, drop the
		// hardcoded English fallbacks. The keys already exist in `en.json` so
		// `tCreate(...)` resolves correctly today.
		const toastId = toast.loading(tCreate("titleGenerating"));

		setIsOrchestrating(true);
		try {
			const result = await onSubmit(payload, pendingFiles, pendingDocs);
			toast.success(tCreate("titleGenerated"), { id: toastId });

			// Wire-shape tolerance: helper emits kebab-case, Prisma enum emits
			// SCREAMING_SNAKE. Accept both so a future procedure-return change
			// doesn't silently break the soft-warn.
			const titleSource = result?.titleSource;
			if (
				titleSource === "untitled-fallback" ||
				titleSource === "UNTITLED_FALLBACK"
			) {
				toast.warning(tCreate("titleInsufficient"));
			}

			setDescription("");
			setPriority("P2_MEDIUM");
			setSize("");
			setPendingFiles([]);
			setPendingDocs([]);
		} catch {
			toast.error(tCreate("titleGenerationFailed"), { id: toastId });
		} finally {
			setIsOrchestrating(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle>{titleText}</DialogTitle>
					<DialogDescription>{subtitleText}</DialogDescription>
				</DialogHeader>

				<form onSubmit={handleSubmit} className="space-y-4">
					<div className="space-y-2">
						<Label htmlFor="description">
							{tCreate("descriptionLabel")}
						</Label>
						<Textarea
							id="description"
							placeholder="Describe what's needed or what's broken…"
							value={description}
							onChange={(e) => setDescription(e.target.value)}
							rows={3}
							required
						/>
					</div>

					<AttachmentsField
						files={pendingFiles}
						onChange={setPendingFiles}
						onValidationError={(msg) => toast.error(msg)}
						disabled={isSubmitting || isOrchestrating}
					/>

					<CreateStoryDocAttachmentsField
						items={pendingDocs}
						onChange={setPendingDocs}
						onValidationError={(msg) => toast.error(msg)}
						disabled={isSubmitting || isOrchestrating}
					/>

					<div className="grid grid-cols-2 gap-4">
						<div className="space-y-2">
							<Label htmlFor="priority">Priority</Label>
							<Select
								value={priority}
								onValueChange={setPriority}
							>
								<SelectTrigger id="priority">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{PRIORITY_OPTIONS.map((opt) => (
										<SelectItem
											key={opt.value}
											value={opt.value}
										>
											<div className="flex items-center gap-2">
												<div
													className="size-2 rounded-full"
													style={{
														backgroundColor:
															opt.color,
													}}
												/>
												{opt.label}
											</div>
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>

						<div className="space-y-2">
							<Label htmlFor="size">Size</Label>
							<Select value={size} onValueChange={setSize}>
								<SelectTrigger id="size">
									<SelectValue placeholder="Select size" />
								</SelectTrigger>
								<SelectContent>
									{SIZE_OPTIONS.map((opt) => (
										<SelectItem
											key={opt.value}
											value={opt.value}
										>
											{opt.label} - {opt.description}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
					</div>

					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							onClick={() => onOpenChange(false)}
						>
							Cancel
						</Button>
						<Button
							type="submit"
							disabled={
								isSubmitting ||
								isOrchestrating ||
								!description.trim()
							}
						>
							{isSubmitting || isOrchestrating ? (
								<>
									<Loader2Icon className="mr-2 size-4 animate-spin motion-safe:animate-spin" />
									Creating…
								</>
							) : (
								"Create"
							)}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
