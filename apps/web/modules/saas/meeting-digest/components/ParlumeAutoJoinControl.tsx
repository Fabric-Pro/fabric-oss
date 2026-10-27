"use client";

import { ParlumeModePicker } from "@saas/parlume/components/ParlumeModePicker";
import { ParlumeSuggestionsToggle } from "@saas/parlume/components/ParlumeSuggestionsToggle";
import { useSettingsReturnUrl } from "@saas/settings/hooks/use-settings-return-url";
import { Label } from "@ui/components/label";
import { Switch } from "@ui/components/switch";
import { CircleAlertIcon } from "lucide-react";
import Link from "next/link";
import type {
	ParlumeAutoJoinSettings,
	ParlumeAutoJoinState,
} from "../hooks/use-meeting-digest";

const FIX_PAGES = [
	{
		phrase: "Settings → Integrations",
		page: "integrations",
		label: "Open Integrations",
	},
	{
		phrase: "Settings → Meeting assistant",
		page: "meeting-assistant",
		label: "Open Meeting assistant",
	},
	{
		phrase: "Settings → AI Providers",
		page: "ai-providers",
		label: "Open AI Providers",
	},
] as const;

/**
 * The settings page an auto-join error names, if any. Every message the
 * server writes that a setting can fix ends by naming its page.
 */
export function autoJoinFixLink(
	error: string,
	settingsBasePath: string,
): { href: string; label: string } | null {
	const fix = FIX_PAGES.find((candidate) => error.includes(candidate.phrase));
	return fix
		? { href: `${settingsBasePath}/${fix.page}`, label: fix.label }
		: null;
}

const DEFAULT_STATE: ParlumeAutoJoinState = {
	enabled: false,
	toolsReadOnly: true,
	suggestionsEnabled: true,
	enabledBy: null,
	error: null,
	errorAt: null,
	syncStopped: false,
};

/**
 * One linked series' "Parlume joins automatically" switch and, while it is
 * on, the mode and chat-suggestion choices its joins use.
 */
export function ParlumeAutoJoinControl({
	linkedMeetingId,
	subject,
	state,
	settingsBasePath,
	pending,
	onChange,
}: {
	linkedMeetingId: string;
	subject: string | null;
	state: ParlumeAutoJoinState | null | undefined;
	/** `/app/{org}/settings`, where an error's fix link points. */
	settingsBasePath: string;
	pending: boolean;
	onChange: (settings: ParlumeAutoJoinSettings) => void;
}) {
	const withReturn = useSettingsReturnUrl();
	const current = state ?? DEFAULT_STATE;
	const idPrefix = `parlume-auto-join-${linkedMeetingId}`;
	const switchId = `${idPrefix}-switch`;
	const settings: ParlumeAutoJoinSettings = {
		enabled: current.enabled,
		toolsReadOnly: current.toolsReadOnly,
		suggestionsEnabled: current.suggestionsEnabled,
	};
	const fix = current.error
		? autoJoinFixLink(current.error, settingsBasePath)
		: null;
	return (
		<div className="space-y-3 rounded-md bg-muted/40 p-3">
			<div className="flex items-start gap-3">
				<Switch
					id={switchId}
					checked={current.enabled}
					onCheckedChange={(enabled) =>
						onChange({ ...settings, enabled })
					}
					// A switch already on stays operable so it can be turned off.
					disabled={
						pending || (current.syncStopped && !current.enabled)
					}
					aria-describedby={`${switchId}-description`}
					className="mt-0.5"
				/>
				<div className="space-y-0.5">
					<Label htmlFor={switchId} className="text-sm font-medium">
						Parlume joins automatically
						<span className="sr-only">
							{" "}
							for {subject ?? "this meeting"}
						</span>
					</Label>
					<p
						id={`${switchId}-description`}
						className="text-xs text-muted-foreground"
					>
						{current.syncStopped
							? "Syncing is stopped for this series, so Parlume cannot join it automatically. Resume syncing in the project's Settings → Meeting Transcript Sync first."
							: "Parlume joins each meeting in this series about a minute before it starts, with no invite needed. The organizer may need to admit it from the lobby."}
					</p>
				</div>
			</div>

			{current.enabled && (
				<div className="space-y-3 sm:pl-12">
					<p className="text-xs text-muted-foreground">
						{current.enabledBy
							? `Turned on by ${current.enabledBy.name}. Joins use their Teams calendar and their permissions.`
							: "The person who turned this on no longer has an account. Turn it off and on again to keep it working."}
					</p>
					<ParlumeModePicker
						toolsReadOnly={current.toolsReadOnly}
						onChange={(toolsReadOnly) =>
							onChange({ ...settings, toolsReadOnly })
						}
						disabled={pending}
						idPrefix={idPrefix}
					/>
					<ParlumeSuggestionsToggle
						checked={current.suggestionsEnabled}
						onChange={(suggestionsEnabled) =>
							onChange({ ...settings, suggestionsEnabled })
						}
						disabled={pending}
						idPrefix={idPrefix}
					/>
				</div>
			)}

			{current.error && (
				<p className="flex gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm">
					<CircleAlertIcon
						className="mt-0.5 size-4 shrink-0 text-destructive"
						aria-hidden="true"
					/>
					<span className="space-x-1.5">
						<span className="text-foreground">{current.error}</span>
						{fix && (
							<Link
								href={withReturn(fix.href)}
								className="text-primary underline underline-offset-4"
							>
								{fix.label}
							</Link>
						)}
					</span>
				</p>
			)}
		</div>
	);
}
