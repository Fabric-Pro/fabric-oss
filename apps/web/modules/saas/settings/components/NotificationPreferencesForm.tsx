"use client";

import {
	type NotificationPreferenceFlags,
	useNotificationPreferences,
	useUpdateNotificationPreferences,
} from "@saas/notifications/hooks/use-notification-preferences";
import { Button } from "@ui/components/button";
import { Card } from "@ui/components/card";
import { Switch } from "@ui/components/switch";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import {
	AtSignIcon,
	BotIcon,
	CornerDownRightIcon,
	FlagIcon,
	LayoutGridIcon,
	Loader2Icon,
	type LucideIcon,
	MailIcon,
	MegaphoneIcon,
	RefreshCwIcon,
	UserPlusIcon,
} from "lucide-react";

type ToggleKey = keyof NotificationPreferenceFlags;

const SYNC_DISABLED_TOOLTIP =
	"Connect a project-management integration to receive sync notifications.";

const TOGGLES: Array<{
	key: ToggleKey;
	label: string;
	description: string;
	icon: LucideIcon;
	/** When true, the toggle is greyed out unless the user has an integration (AC-7). */
	requiresIntegration?: boolean;
}> = [
	{
		key: "mentions",
		label: "Mentions",
		description:
			"When someone @mentions you in a story, task, or document.",
		icon: AtSignIcon,
	},
	{
		key: "replies",
		label: "Replies",
		description: "When someone replies to one of your comments.",
		icon: CornerDownRightIcon,
	},
	{
		key: "assignments",
		label: "Assignments",
		description: "When a story is assigned to you.",
		icon: UserPlusIcon,
	},
	{
		key: "status",
		label: "Status changes",
		description: "When a story you're involved in changes status.",
		icon: FlagIcon,
	},
	{
		key: "syncProject",
		label: "Sync & integrations",
		description:
			"PM-tool sync failures, conflicts, and repository integration alerts.",
		icon: RefreshCwIcon,
		requiresIntegration: true,
	},
	{
		key: "aiAgent",
		label: "AI & agents",
		description: "When an agent finishes a reply you started.",
		icon: BotIcon,
	},
	{
		key: "publishingSuggestions",
		label: "Publishing suggestions",
		description:
			"Tell me when a publishing cycle finds topics I contributed to.",
		icon: MegaphoneIcon,
	},
];

// Email-channel toggles — a separate delivery channel from the always-on
// in-app bell above. These are never gated by `requiresIntegration` and carry
// no tooltip; they're only disabled while a mutation is in flight.
const EMAIL_TOGGLES: Array<{
	key: ToggleKey;
	label: string;
	description: string;
	icon: LucideIcon;
}> = [
	{
		key: "reportEmails",
		label: "Report run emails",
		description:
			"Email me when a report run finishes — completed or failed.",
		icon: MailIcon,
	},
	{
		key: "reviewEmails",
		label: "Release notes awaiting review",
		description:
			"Email me when a release-notes draft needs approval before it goes out.",
		icon: MailIcon,
	},
	{
		key: "publishingEmails",
		label: "Publishing suggestion emails",
		description:
			"Email me the topics a publishing cycle found that I contributed to.",
		icon: MailIcon,
	},
];

export function NotificationPreferencesForm() {
	const { data, isLoading, isError, refetch } = useNotificationPreferences();
	const update = useUpdateNotificationPreferences();

	// Global QueryClient sets retry:false, so a failed getPreferences yields
	// isError (no throw, no error boundary) — surface it with a manual retry
	// instead of an indefinite spinner.
	if (isError) {
		return (
			<Card className="flex flex-col items-center gap-3 rounded-md border p-10 text-center">
				<p className="text-muted-foreground text-sm">
					Couldn't load your notification preferences.
				</p>
				<Button variant="outline" size="sm" onClick={() => refetch()}>
					Retry
				</Button>
			</Card>
		);
	}

	if (isLoading || !data) {
		return (
			<Card className="flex items-center justify-center rounded-md border p-10">
				<Loader2Icon
					className="size-5 animate-spin text-muted-foreground"
					aria-label="Loading notification preferences"
				/>
			</Card>
		);
	}

	return (
		<Card className="rounded-md border p-1 md:p-2">
			<TooltipProvider>
				{/* Display — how notifications are drawn. Deliberately separated
				    from the category toggles below: those decide whether a
				    notification is delivered at all, this one only decides how an
				    already-delivered notification looks (#2117). Same reason the
				    preference is a distinct type server-side rather than a member
				    of NotificationPreferenceFlags. */}
				<div className="px-3 pt-3 pb-1 md:px-4">
					<p className="text-muted-foreground text-xs font-medium uppercase tracking-[0.18em]">
						Display
					</p>
				</div>
				<ul className="divide-y">
					<li className="flex items-center justify-between gap-4 p-3 md:p-4">
						<label
							htmlFor="notif-pref-stackedCardStyle"
							className="flex cursor-pointer items-start gap-3"
						>
							<LayoutGridIcon
								className="mt-0.5 size-4 shrink-0 text-muted-foreground"
								aria-hidden
							/>
							<span className="flex flex-col gap-0.5">
								<span className="text-sm font-medium leading-tight">
									Stacked cards
								</span>
								<span className="text-muted-foreground text-xs">
									Show each notification as its own card
									instead of a compact row. Applies to your
									inbox and the notification bell.
								</span>
							</span>
						</label>
						<Switch
							id="notif-pref-stackedCardStyle"
							checked={data.stackedCardStyle}
							disabled={update.isPending}
							aria-label="Stacked cards"
							onCheckedChange={(value) =>
								update.mutate({ stackedCardStyle: value })
							}
						/>
					</li>
				</ul>

				<div className="border-t px-3 pt-4 pb-1 md:px-4">
					<p className="text-muted-foreground text-xs font-medium uppercase tracking-[0.18em]">
						In-app notifications
					</p>
				</div>
				<ul className="divide-y">
					{TOGGLES.map(
						({
							key,
							label,
							description,
							icon: Icon,
							requiresIntegration,
						}) => {
							const disabled =
								requiresIntegration &&
								!data.syncIntegrationAvailable;
							const switchId = `notif-pref-${key}`;
							const switchEl = (
								<Switch
									id={switchId}
									checked={data[key]}
									disabled={disabled || update.isPending}
									aria-label={
										disabled
											? `${label} — ${SYNC_DISABLED_TOOLTIP}`
											: label
									}
									onCheckedChange={(value) =>
										update.mutate({
											[key]: value,
										} as Partial<NotificationPreferenceFlags>)
									}
								/>
							);

							return (
								<li
									key={key}
									className="flex items-center justify-between gap-4 p-3 md:p-4"
								>
									<label
										htmlFor={switchId}
										className={cn(
											"flex items-start gap-3",
											disabled
												? "opacity-50"
												: "cursor-pointer",
										)}
									>
										<Icon
											className="mt-0.5 size-4 shrink-0 text-muted-foreground"
											aria-hidden
										/>
										<span className="flex flex-col gap-0.5">
											<span className="text-sm font-medium leading-tight">
												{label}
											</span>
											<span className="text-muted-foreground text-xs">
												{description}
											</span>
											{/* Visible to everyone (not hover-only) so
											    sighted keyboard users get the reason too. */}
											{disabled && (
												<span className="text-muted-foreground/80 text-xs italic">
													{SYNC_DISABLED_TOOLTIP}
												</span>
											)}
										</span>
									</label>
									{disabled ? (
										<Tooltip>
											{/* span wrapper: a disabled switch doesn't emit
											    the pointer events the tooltip needs. The
											    reason is also on the switch's aria-label so
											    screen-reader users get it without the hover. */}
											<TooltipTrigger asChild>
												<span>{switchEl}</span>
											</TooltipTrigger>
											<TooltipContent>
												{SYNC_DISABLED_TOOLTIP}
											</TooltipContent>
										</Tooltip>
									) : (
										switchEl
									)}
								</li>
							);
						},
					)}
				</ul>
				{/* Email channel — distinct from the always-on in-app bell above. */}
				<div className="border-t px-3 pt-4 pb-1 md:px-4">
					<p className="text-muted-foreground text-xs font-medium uppercase tracking-[0.18em]">
						Email notifications
					</p>
				</div>
				<ul className="divide-y">
					{EMAIL_TOGGLES.map(
						({ key, label, description, icon: Icon }) => {
							const switchId = `notif-pref-${key}`;
							return (
								<li
									key={key}
									className="flex items-center justify-between gap-4 p-3 md:p-4"
								>
									<label
										htmlFor={switchId}
										className="flex cursor-pointer items-start gap-3"
									>
										<Icon
											className="mt-0.5 size-4 shrink-0 text-muted-foreground"
											aria-hidden
										/>
										<span className="flex flex-col gap-0.5">
											<span className="text-sm font-medium leading-tight">
												{label}
											</span>
											<span className="text-muted-foreground text-xs">
												{description}
											</span>
										</span>
									</label>
									<Switch
										id={switchId}
										checked={data[key]}
										disabled={update.isPending}
										aria-label={label}
										onCheckedChange={(value) =>
											update.mutate({
												[key]: value,
											} as Partial<NotificationPreferenceFlags>)
										}
									/>
								</li>
							);
						},
					)}
				</ul>
			</TooltipProvider>
		</Card>
	);
}
