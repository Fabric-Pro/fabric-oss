"use client";
import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

const presets = {
	daily: "0 9 * * *",
	weekly: "0 9 * * 1",
	monthly: "0 9 1 * *",
};
export function WorkflowScheduleDialog({
	open,
	onOpenChange,
	workflowId,
	organizationId,
	onConfigured,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	workflowId: string;
	organizationId: string;
	onConfigured?: () => void;
}) {
	const t = useTranslations("workflows.lifecycle");
	const copy = (key: string, fallback: string) =>
		t.has(key) ? t(key) : fallback;
	const client = useQueryClient();
	const [cadence, setCadence] = useState("weekly");
	const [cron, setCron] = useState(presets.weekly);
	const [timezone, setTimezone] = useState("UTC");
	const hydrated = useRef(false);
	const query = useQuery(
		orpc.workflows.schedule.get.queryOptions({
			input: { workflowId, organizationId },
			enabled: open,
			staleTime: 0,
			gcTime: 0,
			refetchOnMount: "always",
		}),
	);
	useEffect(() => {
		if (!open) {
			hydrated.current = false;
			return;
		}
		if (
			query.data &&
			!query.isFetching &&
			!query.isError &&
			!hydrated.current
		) {
			const expression = query.data.draft?.cron ?? presets.weekly;
			setCron(expression);
			setTimezone(query.data.draft?.timezone ?? "UTC");
			setCadence(
				Object.entries(presets).find(
					([, value]) => value === expression,
				)?.[0] ?? "custom",
			);
			hydrated.current = true;
		}
	}, [open, query.data, query.isFetching, query.isError]);
	const save = useMutation(
		orpc.workflows.schedule.configure.mutationOptions({
			onSuccess: (result) => {
				toast.success(
					result.publishRequired === false
						? copy(
								"alreadyPublished",
								"Schedule saved. This cadence is already published.",
							)
						: copy(
								"draftSaved",
								"Schedule saved. Publish to activate it.",
							),
				);
				onConfigured?.();
				void client.invalidateQueries({
					queryKey: orpc.workflows.schedule.get.key(),
				});
			},
			onError: (e) => toast.error(e.message),
		}),
	);
	const transition = useMutation({
		mutationFn: async (intent: "pause" | "resume" | "sync") => {
			const args = { workflowId, organizationId };
			if (
				intent === "pause" ||
				(intent === "sync" && query.data?.status === "PAUSED")
			) {
				await orpcClient.workflows.pause(args);
				return;
			}
			if (
				intent === "resume" ||
				(intent === "sync" &&
					["PUBLISHED", "ACTIVE"].includes(query.data?.status ?? ""))
			) {
				await orpcClient.workflows.resume(args);
				return;
			}
			await orpcClient.workflows.publish.unpublish(args);
		},
		onSuccess: () => {
			onConfigured?.();
			void query.refetch();
		},
		onError: (error: Error) => toast.error(error.message),
	});
	const state = query.data?.state;
	const initializing =
		query.isPending || (!hydrated.current && query.isFetching);
	const liveTimezone = query.data?.published?.timezone || "UTC";
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>
						{copy("scheduleTitle", "Schedule workflow")}
					</DialogTitle>
					<DialogDescription>
						{copy(
							"scheduleDescription",
							"Choose when this workflow should run. Saving updates the draft; publishing activates the schedule.",
						)}
					</DialogDescription>
				</DialogHeader>
				{initializing ? (
					<p role="status">{copy("loading", "Checking schedule…")}</p>
				) : query.isError ? (
					<p role="alert">
						{copy(
							"loadError",
							"Could not load the schedule. Try again.",
						)}
					</p>
				) : (
					<>
						<section
							aria-label="Live schedule"
							className="space-y-1 rounded-lg border p-3 text-sm"
						>
							<p className="font-medium">
								{state === "active"
									? copy("active", "Schedule active")
									: state === "paused"
										? copy("paused", "Schedule paused")
										: state === "unverified"
											? copy(
													"unverified",
													"Schedule exists; cadence could not be verified",
												)
											: state === "inactive"
												? copy(
														"inactive",
														"No active schedule",
													)
												: state === "missing" ||
														state === "out-of-sync"
													? copy(
															"missing",
															"Schedule needs synchronization",
														)
													: copy(
															"unavailable",
															"Schedule status unavailable",
														)}
							</p>
							{query.data?.nextRunAt && (
								<p>
									{copy("nextRun", "Next run")}:{" "}
									{new Date(
										query.data.nextRunAt,
									).toLocaleString(undefined, {
										timeZone: liveTimezone,
										timeZoneName: "short",
									})}
								</p>
							)}
							{query.data?.published && (
								<p className="text-muted-foreground">
									{query.data.published.description}
								</p>
							)}
							{["PUBLISHED", "ACTIVE", "PAUSED"].includes(
								query.data?.status ?? "",
							) && (
								<Button
									size="sm"
									variant="outline"
									disabled={
										transition.isPending || save.isPending
									}
									onClick={() =>
										transition.mutate(
											query.data?.status === "PAUSED"
												? "resume"
												: "pause",
										)
									}
								>
									{transition.isPending
										? copy("updating", "Updating…")
										: query.data?.status === "PAUSED"
											? copy("resume", "Resume triggers")
											: copy("pause", "Pause triggers")}
								</Button>
							)}
							{[
								"missing",
								"out-of-sync",
								"paused",
								"unavailable",
							].includes(state ?? "") && (
								<Button
									size="sm"
									variant="outline"
									disabled={
										transition.isPending || save.isPending
									}
									onClick={() => transition.mutate("sync")}
								>
									{copy("retrySync", "Retry synchronization")}
								</Button>
							)}
							<p className="text-xs text-muted-foreground">
								{copy(
									"nextRunZone",
									"Next-run time uses the published schedule’s time zone.",
								)}
							</p>
							<p className="text-xs text-muted-foreground">
								{copy(
									"currentRuns",
									"These controls affect future triggers. Current runs keep their state.",
								)}
							</p>
						</section>
						{query.data?.configurationIssue && (
							<p role="note">
								{copy(
									"webhookSchedule",
									"This workflow starts from a webhook. Duplicate it to create a scheduled workflow.",
								)}
							</p>
						)}
						<div className="space-y-2">
							<Label htmlFor="workflow-cadence">
								{copy("cadence", "Repeat")}
							</Label>
							<Select
								disabled={!!query.data?.configurationIssue}
								value={cadence}
								onValueChange={(value) => {
									setCadence(value);
									if (value in presets) {
										setCron(
											presets[
												value as keyof typeof presets
											],
										);
									}
								}}
							>
								<SelectTrigger id="workflow-cadence">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="daily">
										{copy("daily", "Every day at 09:00")}
									</SelectItem>
									<SelectItem value="weekly">
										{copy(
											"weekly",
											"Every Monday at 09:00",
										)}
									</SelectItem>
									<SelectItem value="monthly">
										{copy(
											"monthly",
											"First day of each month at 09:00",
										)}
									</SelectItem>
									<SelectItem value="custom">
										{copy("custom", "Custom schedule")}
									</SelectItem>
								</SelectContent>
							</Select>
						</div>
						{cadence === "custom" && (
							<div className="space-y-2">
								<Label htmlFor="workflow-cron">
									{copy("cron", "Cron expression")}
								</Label>
								<Input
									disabled={!!query.data?.configurationIssue}
									id="workflow-cron"
									value={cron}
									maxLength={200}
									onChange={(e) => setCron(e.target.value)}
								/>
							</div>
						)}
						<div className="space-y-2">
							<Label htmlFor="workflow-timezone">
								{copy("timezone", "Time zone")}
							</Label>
							<Input
								disabled={!!query.data?.configurationIssue}
								id="workflow-timezone"
								value={timezone}
								maxLength={100}
								placeholder="UTC"
								onChange={(e) => setTimezone(e.target.value)}
							/>
							<p className="text-xs text-muted-foreground">
								{copy(
									"timezoneHelp",
									"Use UTC or an IANA time zone, such as Europe/Berlin. The repeat time uses this zone; live schedule times use the published zone.",
								)}
							</p>
						</div>
						{save.isSuccess && (
							<p role="status">
								{save.data?.publishRequired === false
									? copy(
											"alreadyPublished",
											"Schedule saved. This cadence is already published.",
										)
									: copy(
											"draftSaved",
											"Schedule saved. Publish to activate it.",
										)}
							</p>
						)}
					</>
				)}
				<DialogFooter>
					<Button
						variant="outline"
						onClick={() => onOpenChange(false)}
					>
						{copy("close", "Close")}
					</Button>
					<Button
						disabled={
							save.isPending ||
							transition.isPending ||
							!!query.data?.configurationIssue ||
							initializing ||
							query.isError ||
							!cron.trim() ||
							!timezone.trim()
						}
						onClick={() =>
							save.mutate({
								workflowId,
								organizationId,
								cron,
								timezone,
							})
						}
					>
						{save.isPending
							? copy("saving", "Saving…")
							: copy("saveDraft", "Save schedule draft")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
