"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
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
import { Checkbox } from "@ui/components/checkbox";
import { Label } from "@ui/components/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { Switch } from "@ui/components/switch";
import { useId, useState } from "react";

/** The select's value for "no automatic screenshots". */
const NO_ENVIRONMENT = "none";

type EnvironmentChange = {
	screenshotEnvironmentId: string | null;
	screenshotSampleDataConfirmed?: boolean;
};

type NewsletterImagesChange =
	| { screenshotsEnabled: boolean }
	| EnvironmentChange;

/**
 * "Images in highlights", and where screenshots are captured from. Choosing
 * an environment asks for one confirmation: that it shows sample data only,
 * because its screens go out to external readers.
 */
export function NewsletterImagesSetting({
	projectId,
	screenshotsEnabled,
	requireApproval,
	screenshotEnvironmentId,
	disabled,
	onChange,
}: {
	projectId: string;
	screenshotsEnabled: boolean;
	requireApproval: boolean;
	screenshotEnvironmentId: string | null;
	disabled: boolean;
	onChange: (change: NewsletterImagesChange) => void;
}) {
	return (
		<div className="rounded-lg border border-border p-4">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div className="min-w-0">
					<p className="font-medium text-foreground">
						Images in highlights
					</p>
					<p className="break-words text-sm text-muted-foreground">
						Add up to two images to each highlight. Choose an
						environment to capture screenshots automatically.
					</p>
				</div>
				<Switch
					checked={screenshotsEnabled}
					disabled={disabled}
					aria-label="Images in highlights"
					onCheckedChange={(checked) =>
						onChange({ screenshotsEnabled: checked })
					}
				/>
			</div>

			{screenshotsEnabled ? (
				<CaptureFromPicker
					projectId={projectId}
					requireApproval={requireApproval}
					screenshotEnvironmentId={screenshotEnvironmentId}
					disabled={disabled}
					onChange={onChange}
				/>
			) : null}
		</div>
	);
}

/** Mounted only while images are on, so the environments load only then. */
function CaptureFromPicker({
	projectId,
	requireApproval,
	screenshotEnvironmentId,
	disabled,
	onChange,
}: {
	projectId: string;
	requireApproval: boolean;
	screenshotEnvironmentId: string | null;
	disabled: boolean;
	onChange: (change: EnvironmentChange) => void;
}) {
	const captureFromId = useId();
	const confirmId = useId();
	const environmentsQuery = useQuery(
		orpc.projects.environments.list.queryOptions({
			input: { projectId },
		}),
	);
	// Production shows real data; the server refuses it as a capture source.
	const environments = (environmentsQuery.data ?? []).filter(
		(environment) => environment.type !== "PRODUCTION",
	);
	const [pendingEnvironmentId, setPendingEnvironmentId] = useState<
		string | null
	>(null);
	const [confirmed, setConfirmed] = useState(false);
	const pendingEnvironment = environments.find(
		(e) => e.id === pendingEnvironmentId,
	);

	const closeConfirmation = () => {
		setPendingEnvironmentId(null);
		setConfirmed(false);
	};

	return (
		<>
			<div className="mt-4 space-y-1.5">
				<Label htmlFor={captureFromId}>Capture from</Label>
				<Select
					value={screenshotEnvironmentId ?? NO_ENVIRONMENT}
					disabled={disabled || environmentsQuery.isLoading}
					onValueChange={(value) => {
						if (value === NO_ENVIRONMENT) {
							onChange({ screenshotEnvironmentId: null });
						} else if (value !== screenshotEnvironmentId) {
							setPendingEnvironmentId(value);
						}
					}}
				>
					<SelectTrigger id={captureFromId} className="max-w-sm">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value={NO_ENVIRONMENT}>
							Don't capture automatically
						</SelectItem>
						{environments.map((environment) => (
							<SelectItem
								key={environment.id}
								value={environment.id}
							>
								{environment.name}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				{environments.length === 0 && !environmentsQuery.isLoading ? (
					<p className="text-muted-foreground text-xs">
						Add an environment under Settings, Environments to
						capture screenshots from it.
					</p>
				) : null}
				{screenshotHint(requireApproval, screenshotEnvironmentId)}
			</div>

			<AlertDialog
				open={pendingEnvironmentId !== null}
				onOpenChange={(open) => {
					if (!open) {
						closeConfirmation();
					}
				}}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							Capture from{" "}
							{pendingEnvironment?.name ?? "this environment"}?
						</AlertDialogTitle>
						<AlertDialogDescription>
							Screenshots of this environment are sent to everyone
							who receives the release notes.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<div className="flex items-start gap-2">
						<Checkbox
							id={confirmId}
							checked={confirmed}
							onCheckedChange={(checked) =>
								setConfirmed(checked === true)
							}
							className="mt-0.5"
						/>
						<Label htmlFor={confirmId} className="font-normal">
							This environment shows sample data only
						</Label>
					</div>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction
							disabled={!confirmed}
							onClick={() => {
								if (
									pendingEnvironmentId !== null &&
									confirmed
								) {
									onChange({
										screenshotEnvironmentId:
											pendingEnvironmentId,
										screenshotSampleDataConfirmed: true,
									});
								}
								closeConfirmation();
							}}
						>
							Use this environment
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
}

function screenshotHint(
	requireApproval: boolean,
	screenshotEnvironmentId: string | null,
) {
	if (requireApproval) {
		return null;
	}
	return (
		<p className="text-muted-foreground text-xs">
			{screenshotEnvironmentId
				? "Review is off, so screenshots are captured and sent without review."
				: "Turn on review to add images yourself."}
		</p>
	);
}
