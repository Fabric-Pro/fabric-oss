"use client";

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
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
import { RadioGroup, RadioGroupItem } from "@ui/components/radio-group";
import { Textarea } from "@ui/components/textarea";
import { CheckCircleIcon, Loader2Icon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useId, useState } from "react";
import { toast } from "sonner";
import {
	acceptSpikeRun,
	SPIKE_NEXT_TRACKS,
	SPIKE_PLAY_NOTES_MIN_LENGTH,
	type SpikeNextTrack,
} from "../../lib/spike-runs";
import { DELIVERY_TRACK_META } from "../../lib/stories/types";
import { InfoTip } from "./InfoTip";
import { invalidateStoryReadiness } from "./useStoryReadiness";

type Props = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	codingRunId: string;
	projectId: string;
	storyId: string;
	/** The spike question, shown for context. */
	question?: string | null;
	onAccepted?: () => void;
};

const NO_NEXT_TRACK = "__none__";

/**
 * Accept a spike's findings (inverted-loop plan, Slice 3). Records play notes
 * — who tried the demo, what happened, what was decided — which the backend
 * requires (≥ 20 characters) before it snapshots a feature version, appends
 * the findings and marks the run COMPLETED. Optionally records the next
 * delivery track the reviewer recommends.
 */
export function AcceptSpikeDialog({
	open,
	onOpenChange,
	codingRunId,
	projectId,
	storyId,
	question,
	onAccepted,
}: Props) {
	const t = useTranslations("projects.stories.spike");
	const tTips = useTranslations("tooltips.stories");
	const tTracks = useTranslations("projects.stories.readiness.tracks");
	const { organizationId } = useOrganizationContext();
	const queryClient = useQueryClient();
	const notesId = useId();
	const notesHintId = useId();
	const [playNotes, setPlayNotes] = useState("");
	const [nextTrack, setNextTrack] = useState<string>(NO_NEXT_TRACK);
	const [touched, setTouched] = useState(false);

	useEffect(() => {
		if (open) {
			setPlayNotes("");
			setNextTrack(NO_NEXT_TRACK);
			setTouched(false);
		}
	}, [open]);

	const trimmedNotes = playNotes.trim();
	const notesTooShort = trimmedNotes.length < SPIKE_PLAY_NOTES_MIN_LENGTH;
	const showNotesError = touched && notesTooShort;

	const acceptMutation = useMutation({
		mutationFn: async () =>
			await acceptSpikeRun({
				codingRunId,
				projectId,
				organizationId: organizationId ?? null,
				playNotes: trimmedNotes,
				nextTrack:
					nextTrack === NO_NEXT_TRACK
						? undefined
						: (nextTrack as SpikeNextTrack),
			}),
		onSuccess: async () => {
			await Promise.all([
				queryClient.invalidateQueries({
					queryKey: orpc.codingRuns.list.key(),
				}),
				queryClient.invalidateQueries({
					queryKey: ["codingRun", codingRunId],
				}),
				queryClient.invalidateQueries({
					queryKey: orpc.projects.stories.list.key(),
				}),
				queryClient.invalidateQueries({
					queryKey: orpc.projects.stories.get.key(),
				}),
				invalidateStoryReadiness(queryClient, { projectId, storyId }),
			]);
			toast.success(t("accept.success"), {
				description: t("accept.successDescription"),
			});
			onOpenChange(false);
			onAccepted?.();
		},
		onError: (error) => {
			toast.error(t("accept.failed"), { description: error.message });
		},
	});

	const canSubmit = !notesTooShort && !acceptMutation.isPending;

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="flex max-h-[90vh] flex-col sm:max-w-[560px]">
				<DialogHeader className="flex-shrink-0 space-y-4 text-left">
					<div className="flex items-start gap-3">
						<div className="flex size-11 shrink-0 items-center justify-center rounded-2xl border border-secondary/30 bg-secondary/10">
							<CheckCircleIcon className="size-5 text-secondary" />
						</div>
						<div className="min-w-0 flex-1 space-y-2 pr-8">
							<Badge
								variant="outline"
								className="rounded-full border-primary/20 bg-primary/5 px-2.5 py-0.5 text-[11px] uppercase tracking-[0.16em] text-primary"
							>
								{t("kindBadge")}
							</Badge>
							<DialogTitle className="text-xl leading-tight sm:text-2xl">
								<span className="inline-flex items-center gap-2">
									{t("accept.title")}
									<InfoTip label={tTips("spikeAcceptHelp")}>
										<p>{tTips("spikeAccept")}</p>
									</InfoTip>
								</span>
							</DialogTitle>
							<DialogDescription className="max-w-[60ch] text-sm leading-6">
								{t("accept.description")}
							</DialogDescription>
						</div>
					</div>
				</DialogHeader>

				<form
					className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto py-1 pr-1"
					onSubmit={(event) => {
						event.preventDefault();
						setTouched(true);
						if (canSubmit) {
							acceptMutation.mutate();
						}
					}}
				>
					{question && (
						<div className="rounded-2xl border border-border/60 bg-muted/40 p-4">
							<p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
								{t("questionLabel")}
							</p>
							<p className="mt-2 text-sm leading-6 text-foreground/90">
								{question}
							</p>
						</div>
					)}

					<div className="space-y-2">
						<Label htmlFor={notesId}>
							{t("accept.playNotesLabel")}
						</Label>
						<Textarea
							id={notesId}
							value={playNotes}
							onChange={(event) =>
								setPlayNotes(event.target.value)
							}
							onBlur={() => setTouched(true)}
							rows={5}
							placeholder={t("accept.playNotesPlaceholder")}
							aria-describedby={notesHintId}
							aria-invalid={showNotesError || undefined}
							className="resize-none text-sm"
						/>
						<p
							id={notesHintId}
							className={
								showNotesError
									? "text-xs leading-5 text-destructive"
									: "text-xs leading-5 text-muted-foreground"
							}
							role={showNotesError ? "alert" : undefined}
						>
							{showNotesError
								? t("accept.playNotesTooShort", {
										min: SPIKE_PLAY_NOTES_MIN_LENGTH,
									})
								: t("accept.playNotesHint", {
										min: SPIKE_PLAY_NOTES_MIN_LENGTH,
									})}
						</p>
					</div>

					<fieldset className="space-y-3">
						<legend className="text-sm font-medium leading-none">
							{t("accept.nextTrackLabel")}
						</legend>
						<p className="text-xs leading-5 text-muted-foreground">
							{t("accept.nextTrackHint")}
						</p>
						<RadioGroup
							value={nextTrack}
							onValueChange={setNextTrack}
							className="space-y-2"
						>
							<div className="flex items-start gap-3">
								<RadioGroupItem
									value={NO_NEXT_TRACK}
									id={`${notesId}-track-none`}
									className="mt-1"
								/>
								<Label
									htmlFor={`${notesId}-track-none`}
									className="cursor-pointer font-normal leading-6"
								>
									{t("accept.nextTrackNone")}
								</Label>
							</div>
							{SPIKE_NEXT_TRACKS.map((track) => (
								<div
									key={track}
									className="flex items-start gap-3"
								>
									<RadioGroupItem
										value={track}
										id={`${notesId}-track-${track}`}
										className="mt-1"
									/>
									<div className="min-w-0 flex-1">
										<Label
											htmlFor={`${notesId}-track-${track}`}
											className="cursor-pointer font-medium leading-6"
										>
											{tTracks(track)}
										</Label>
										<p className="text-xs leading-5 text-muted-foreground">
											{
												DELIVERY_TRACK_META[track]
													.description
											}
										</p>
									</div>
								</div>
							))}
						</RadioGroup>
					</fieldset>

					<DialogFooter className="flex-shrink-0 gap-2 pt-1">
						<Button
							type="button"
							variant="outline"
							onClick={() => onOpenChange(false)}
							disabled={acceptMutation.isPending}
						>
							{t("cancel")}
						</Button>
						<Button type="submit" disabled={!canSubmit}>
							{acceptMutation.isPending ? (
								<>
									<Loader2Icon className="mr-2 size-4 motion-safe:animate-spin" />
									{t("accept.submitting")}
								</>
							) : (
								t("accept.submit")
							)}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
