"use client";

import { Button } from "@ui/components/button";
import { Label } from "@ui/components/label";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ui/components/popover";
import { Switch } from "@ui/components/switch";
import { SettingsIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useId, useState } from "react";
import { useTimer, useTimerActions } from "../hooks/use-timer";
import { InfoHint } from "./InfoHint";

type NotificationState = NotificationPermission | "unsupported";

function readNotificationState(): NotificationState {
	return typeof Notification === "undefined"
		? "unsupported"
		: Notification.permission;
}

/**
 * The caller's two timer settings on My time: whether the widget shows, and
 * the opt-in browser reminder. Each saves on change. Turning reminders on
 * is the one moment the browser is asked for permission to notify; when it
 * refuses, that is said beside the switch.
 */
export function TimerSettings({ organizationId }: { organizationId: string }) {
	const t = useTranslations("timeTracking.timer.settings");
	const id = useId();
	const { preference } = useTimer(organizationId);
	const actions = useTimerActions(organizationId);
	const [notifications, setNotifications] =
		useState<NotificationState | null>(null);
	useEffect(() => {
		setNotifications(readNotificationState());
	}, []);

	const remindersOn = preference?.timerReminders ?? false;

	const setReminders = async (on: boolean) => {
		if (on && readNotificationState() === "default") {
			await Notification.requestPermission();
		}
		setNotifications(readNotificationState());
		await actions.setPreference({ timerReminders: on });
	};

	const reminderNotice =
		!remindersOn || notifications === null || notifications === "granted"
			? null
			: notifications === "unsupported"
				? t("unsupported")
				: notifications === "denied"
					? t("blocked")
					: t("notAllowedYet");

	return (
		<Popover>
			<PopoverTrigger asChild>
				<Button
					type="button"
					variant="ghost"
					size="icon-sm"
					aria-label={t("open")}
				>
					<SettingsIcon aria-hidden="true" />
				</Button>
			</PopoverTrigger>
			<PopoverContent align="start" className="w-80 space-y-3">
				<p className="font-semibold text-sm">{t("title")}</p>
				<div className="flex items-center justify-between gap-3">
					<div className="flex items-center gap-1">
						<Label htmlFor={`${id}-widget`}>{t("widget")}</Label>
						<InfoHint label={t("aboutWidgetTitle")}>
							{t("aboutWidget")}
						</InfoHint>
					</div>
					<Switch
						id={`${id}-widget`}
						checked={(preference?.timerWidget ?? "SHOWN") !== "OFF"}
						disabled={!preference}
						onCheckedChange={(on) =>
							void actions.setPreference({
								timerWidget: on ? "SHOWN" : "OFF",
							})
						}
					/>
				</div>
				<div className="space-y-1">
					<div className="flex items-center justify-between gap-3">
						<div className="flex items-center gap-1">
							<Label htmlFor={`${id}-reminders`}>
								{t("reminders")}
							</Label>
							<InfoHint label={t("aboutRemindersTitle")}>
								{t("aboutReminders")}
							</InfoHint>
						</div>
						<Switch
							id={`${id}-reminders`}
							checked={remindersOn}
							disabled={!preference}
							aria-describedby={
								reminderNotice
									? `${id}-reminders-notice`
									: undefined
							}
							onCheckedChange={(on) => void setReminders(on)}
						/>
					</div>
					{reminderNotice ? (
						<p
							id={`${id}-reminders-notice`}
							className="text-muted-foreground text-xs"
						>
							{reminderNotice}
						</p>
					) : null}
				</div>
			</PopoverContent>
		</Popover>
	);
}
