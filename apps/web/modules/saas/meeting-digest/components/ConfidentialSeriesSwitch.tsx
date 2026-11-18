"use client";

import { Label } from "@ui/components/label";
import { Switch } from "@ui/components/switch";

/** One linked series' "Confidential" switch in the Configure meetings panel. */
export function ConfidentialSeriesSwitch({
	linkedMeetingId,
	subject,
	checked,
	pending,
	onChange,
}: {
	linkedMeetingId: string;
	subject: string | null;
	checked: boolean;
	pending: boolean;
	onChange: (confidential: boolean) => void;
}) {
	const switchId = `meeting-confidential-${linkedMeetingId}-switch`;
	return (
		<div className="flex items-start gap-3 rounded-md bg-muted/40 p-3">
			<Switch
				id={switchId}
				checked={checked}
				onCheckedChange={onChange}
				disabled={pending}
				aria-describedby={`${switchId}-description`}
				className="mt-0.5"
			/>
			<div className="space-y-0.5">
				<Label htmlFor={switchId} className="text-sm font-medium">
					Confidential
					<span className="sr-only">
						{" "}
						for {subject ?? "this meeting"}
					</span>
				</Label>
				<p
					id={`${switchId}-description`}
					className="text-xs text-muted-foreground"
				>
					{
						"Keep this series' transcripts out of later answers, recaps and agendas."
					}
				</p>
			</div>
		</div>
	);
}
