"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation } from "@tanstack/react-query";
import { Alert, AlertDescription } from "@ui/components/alert";
import { Button } from "@ui/components/button";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import { Switch } from "@ui/components/switch";
import { Textarea } from "@ui/components/textarea";
import { useId, useState } from "react";
import { toast } from "sonner";

type Schedule = {
	id: string;
	enabled: boolean;
	cronExpression: string;
	timezone: string;
	input: unknown;
};

export function AgentRunSchedule({
	instanceId,
	organizationId,
	schedule,
	defaultMessage,
	onSaved,
	onClose,
}: {
	instanceId: string;
	organizationId: string;
	schedule: Schedule | null;
	defaultMessage: string;
	onSaved: () => void;
	onClose: () => void;
}) {
	const id = useId();
	const initialInput = schedule?.input as { message?: unknown } | undefined;
	const [cron, setCron] = useState(schedule?.cronExpression ?? "0 9 * * 1-5");
	const [timezone, setTimezone] = useState(
		schedule?.timezone ??
			Intl.DateTimeFormat().resolvedOptions().timeZone ??
			"UTC",
	);
	const [message, setMessage] = useState(
		typeof initialInput?.message === "string"
			? initialInput.message
			: defaultMessage,
	);
	const [enabled, setEnabled] = useState(schedule?.enabled ?? true);
	const mutation = useMutation({
		mutationFn: () =>
			orpcClient.agentDeployments.runs.schedule({
				instanceId,
				organizationId,
				cronExpression: cron.trim(),
				timezone: timezone.trim(),
				input: { message: message.trim() },
				enabled,
			}),
		retry: false,
		onSuccess: () => {
			toast.success(enabled ? "Schedule saved" : "Schedule paused");
			onSaved();
		},
	});
	return (
		<form
			className="space-y-4 border-t border-border p-4"
			onSubmit={(event) => {
				event.preventDefault();
				mutation.mutate();
			}}
			aria-label="Agent schedule"
		>
			<div className="flex items-center justify-between gap-3">
				<h4 className="font-semibold text-sm">
					{schedule ? "Edit schedule" : "Schedule this agent"}
				</h4>
				<Button
					variant="ghost"
					size="sm"
					type="button"
					onClick={onClose}
				>
					Close
				</Button>
			</div>
			<p className="text-sm text-muted-foreground">
				Run with this agent’s saved project, knowledge and connections.
				This schedule is separate from its other triggers.
			</p>
			<fieldset disabled={mutation.isPending} className="space-y-4">
				<div className="space-y-2">
					<Label htmlFor={`${id}-task`}>Scheduled task</Label>
					<Textarea
						id={`${id}-task`}
						required
						maxLength={20000}
						value={message}
						onChange={(event) => setMessage(event.target.value)}
						rows={3}
						placeholder="Create a delivery report from the project’s latest documents."
					/>
				</div>
				<fieldset className="flex flex-wrap gap-2">
					<legend className="sr-only">Schedule presets</legend>
					{[
						{ name: "Weekdays at 9 AM", cron: "0 9 * * 1-5" },
						{ name: "Mondays at 9 AM", cron: "0 9 * * 1" },
						{ name: "First of month", cron: "0 9 1 * *" },
					].map((preset) => (
						<Button
							type="button"
							key={preset.cron}
							size="sm"
							variant={
								cron === preset.cron ? "secondary" : "outline"
							}
							onClick={() => setCron(preset.cron)}
						>
							{preset.name}
						</Button>
					))}
				</fieldset>
				<div className="grid gap-4 sm:grid-cols-2">
					<div className="space-y-2">
						<Label htmlFor={`${id}-cron`}>Cron expression</Label>
						<Input
							id={`${id}-cron`}
							required
							value={cron}
							onChange={(event) => setCron(event.target.value)}
							aria-describedby={`${id}-hint`}
						/>
						<p
							id={`${id}-hint`}
							className="text-xs text-muted-foreground"
						>
							Minute, hour, day, month, weekday. Runs use the
							timezone beside it.
						</p>
					</div>
					<div className="space-y-2">
						<Label htmlFor={`${id}-timezone`}>Timezone</Label>
						<Input
							id={`${id}-timezone`}
							required
							value={timezone}
							onChange={(event) =>
								setTimezone(event.target.value)
							}
							placeholder="America/Phoenix"
						/>
					</div>
				</div>
				<div className="flex items-center gap-2">
					<Switch
						id={`${id}-enabled`}
						checked={enabled}
						onCheckedChange={setEnabled}
					/>
					<Label htmlFor={`${id}-enabled`}>Schedule enabled</Label>
				</div>
			</fieldset>
			{mutation.error && (
				<Alert variant="error">
					<AlertDescription>
						{mutation.error.message}
					</AlertDescription>
				</Alert>
			)}
			<Button
				type="submit"
				loading={mutation.isPending}
				disabled={
					!message.trim() ||
					!cron.trim() ||
					!timezone.trim() ||
					mutation.isPending
				}
			>
				{enabled ? "Save schedule" : "Save paused schedule"}
			</Button>
		</form>
	);
}
