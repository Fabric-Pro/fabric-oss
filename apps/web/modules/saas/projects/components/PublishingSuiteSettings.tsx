"use client";

/**
 * Publishing Suite project-settings card — Phase 1C-1 Task 8.
 *
 * Two capabilities, not one (see the task brief / roles.ts): the cadence,
 * lookback and notification controls are gated on `canEdit`
 * (PROJECT_SETTINGS_EDIT, admin/owner only), but "Generate now" is gated on
 * the separate `canGenerate` (PUBLISHING_TOPIC_CREATE, which Editors hold
 * too). Collapsing both into one prop would make the manual trigger
 * unreachable for the role the endpoint was written for, and MANUAL cadence
 * unusable for them.
 *
 * Auto-save per control, invalidate on success, no optimistic updates —
 * mirrors `ProjectNewsletterSettings`.
 */
// Deep import, NOT the `@repo/database` barrel: that would pull the generated
// Prisma client into a browser bundle. This module's only Prisma reference is
// `import type`, which the compiler erases — the same path
// `PublishingSuiteList.tsx` already takes for FUNCTION_TAG_LABELS.
import {
	MAX_PUBLISHING_PREFERENCE_ITEM_LENGTH,
	MAX_PUBLISHING_PREFERENCE_ITEMS,
	MAX_PUBLISHING_STRATEGIC_PRIORITIES_LENGTH,
	normalizePreferenceLabel,
	PUBLISHING_POST_TYPE_OPTIONS,
	type PublishingPostTypeValue,
} from "@repo/database/src/publishing-post-types";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Card } from "@ui/components/card";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { Switch } from "@ui/components/switch";
import { Textarea } from "@ui/components/textarea";
import { SparklesIcon } from "lucide-react";
import { toast } from "sonner";

type PublishingCadence = "MANUAL" | "WEEKLY" | "BIWEEKLY" | "MONTHLY";

const CADENCE_OPTIONS: { value: PublishingCadence; label: string }[] = [
	{ value: "MANUAL", label: "Manual only" },
	{ value: "WEEKLY", label: "Weekly" },
	{ value: "BIWEEKLY", label: "Biweekly" },
	{ value: "MONTHLY", label: "Monthly" },
];

const sectionTitleClass =
	"text-[11px] font-medium uppercase tracking-[0.22em] text-muted-foreground";

/** A selected chat broadcast target. Mirrors `PublishingChatChannel` from
 *  `@repo/database`; declared locally because this component talks to the
 *  procedure over the wire and never imports the database package. */
type PublishingChatChannel = {
	platform: "TEAMS" | "SLACK";
	teamId: string;
	channelId: string;
	channelName?: string;
};

function chatChannelKey(c: {
	platform: string;
	teamId: string;
	channelId: string;
}): string {
	return `${c.platform}:${c.teamId}:${c.channelId}`;
}

type Props = {
	projectId: string;
	organizationId: string | null;
	/** PROJECT_SETTINGS_EDIT — admin/owner only. Gates cadence, lookback and
	 *  the notification switch. */
	canEdit: boolean;
	/** PUBLISHING_TOPIC_CREATE — Editors too. Gates ONLY "Generate now". */
	canGenerate: boolean;
};

export function PublishingSuiteSettings({
	projectId,
	organizationId,
	canEdit,
	canGenerate,
}: Props) {
	const queryClient = useQueryClient();
	const queryKey = [
		"publishing-suite-settings",
		projectId,
		organizationId,
	] as const;

	const settingsQuery = useQuery({
		queryKey,
		queryFn: () =>
			orpcClient.projects.publishingSuite.getSettings({
				projectId,
				organizationId,
			}),
	});

	// Both linked-channel lists are fetched unconditionally, unlike the newsletter
	// card, which gates them behind its delivery-destination selector. There is no
	// equivalent gate here BY DESIGN — the selection itself is the on/off state —
	// and hiding the list behind a disclosure would hide existing state, which is
	// worse than two reads on a settings page an admin opens rarely.
	const teamsLinkedQuery = useQuery({
		queryKey: [
			"publishing-linked-teams",
			projectId,
			organizationId,
		] as const,
		queryFn: () =>
			orpcClient.projects.teamsChannelMonitor.listLinkedChannels({
				projectId,
				organizationId,
			}),
	});
	const slackLinkedQuery = useQuery({
		queryKey: [
			"publishing-linked-slack",
			projectId,
			organizationId,
		] as const,
		queryFn: () =>
			orpcClient.projects.slackChannelMonitor.listLinkedChannels({
				projectId,
				organizationId,
			}),
	});

	const updateSettings = useMutation({
		mutationFn: (input: {
			cadence?: PublishingCadence;
			lookbackDays?: number | null;
			notificationsEnabled?: boolean;
			chatChannels?: PublishingChatChannel[];
			preferredThemes?: string[];
			preferredPostTypes?: PublishingPostTypeValue[];
			strategicPriorities?: string | null;
		}) =>
			orpcClient.projects.publishingSuite.updateSettings({
				projectId,
				organizationId,
				...input,
			}),
		onSuccess: () => {
			toast.success("Publishing settings saved");
			queryClient.invalidateQueries({ queryKey });
		},
		onError: (error) => {
			toast.error(
				error instanceof Error
					? error.message
					: "Failed to save publishing settings",
			);
		},
	});

	const generateNow = useMutation({
		mutationFn: () =>
			orpcClient.projects.publishingSuite.generateNow({
				projectId,
				organizationId,
			}),
		onSuccess: (result) => {
			switch (result.status) {
				case "started":
					toast.success("Generating new topic suggestions now.");
					break;
				case "in_flight":
					toast.info("A generation run is already in progress.");
					break;
				case "rate_limited":
					toast.error(
						"Generate now was used recently — please wait up to an hour before trying again.",
					);
					break;
				case "unavailable":
					toast.error(
						"Topic generation is temporarily unavailable. Try again shortly.",
					);
					break;
				default:
					// Guards against a server-side status the client doesn't
					// know about yet — silence here would look like a dead
					// button, so surface something actionable instead.
					toast.error(
						"Generate now returned an unrecognized response. Try again shortly.",
					);
					break;
			}
		},
		onError: (error) => {
			toast.error(
				error instanceof Error
					? error.message
					: "Failed to start topic generation",
			);
		},
	});

	const s = settingsQuery.data?.settings;
	// No client-side default here, deliberately: the server read already
	// synthesizes the shared default cadence for a project with no settings
	// row, so inventing one here would be a second copy of that default that
	// goes stale exactly the way the old hardcoded literal did. Until the read
	// resolves (or if it fails) there is no cadence to show, so the Select
	// stays controlled on "" and renders its placeholder instead.
	const cadence = (s?.cadence ?? "") as PublishingCadence | "";
	const lookbackDays = s?.lookbackDays ?? null;
	const notificationsEnabled = s?.notificationsEnabled ?? true;
	// ANNOTATED, never asserted. An `as string[]` here type-checks at the cast
	// and then fails at `updateSettings`, because the boundary wants the post-type
	// UNION back — the assertion throws away exactly what the write demands. An
	// annotation makes the compiler prove the stored value already has the shape
	// this component claims, at the line that claims it.
	const preferredThemes: string[] = s?.preferredThemes ?? [];
	const preferredPostTypes: PublishingPostTypeValue[] =
		s?.preferredPostTypes ?? [];
	const strategicPriorities: string | null = s?.strategicPriorities ?? null;

	// One line per theme rather than a comma-separated field. A comma is a
	// plausible character inside a theme, and a delimiter the value can
	// legitimately contain is a delimiter that will eventually split somebody's
	// input in half.
	// The SAME per-item rule the write boundary and the prompt snapshot apply,
	// imported rather than re-spelled. Trimming alone was not enough and the gap
	// was one-directional: the boundary collapses inner whitespace before it
	// measures, so "40 chars + 5 spaces + 19 chars" is 60 to the server and 64
	// here — the form refused to save a value the API would have accepted, and
	// the user's only clue was a length error about a length they could not see.
	// Collapsing here also makes the "nothing changed" short-circuit below
	// compare like with like, since the stored values are already normalized.
	const parseThemeLines = (raw: string) =>
		raw
			.split("\n")
			.map((line) => normalizePreferenceLabel(line))
			.filter((line) => line.length > 0);

	const saveThemes = (raw: string) => {
		const next = parseThemeLines(raw);
		// Rejected here rather than truncated. Silently dropping the 26th theme
		// would save something the user did not type and show them no reason.
		if (next.length > MAX_PUBLISHING_PREFERENCE_ITEMS) {
			toast.error(
				`Keep it to ${MAX_PUBLISHING_PREFERENCE_ITEMS} themes or fewer.`,
			);
			return;
		}
		const tooLong = next.find(
			(t) => t.length > MAX_PUBLISHING_PREFERENCE_ITEM_LENGTH,
		);
		if (tooLong) {
			toast.error(
				`Each theme must be ${MAX_PUBLISHING_PREFERENCE_ITEM_LENGTH} characters or fewer.`,
			);
			return;
		}
		// `[]` is the CLEAR and must be sent as itself — `undefined` would mean
		// "leave the stored list alone", so emptying the box would silently do
		// nothing.
		if (
			next.length === preferredThemes.length &&
			next.every((t, i) => t === preferredThemes[i])
		) {
			return;
		}
		updateSettings.mutate({ preferredThemes: next });
	};

	const savePriorities = (raw: string) => {
		const trimmed = raw.trim();
		if (trimmed.length > MAX_PUBLISHING_STRATEGIC_PRIORITIES_LENGTH) {
			toast.error(
				`Keep priorities to ${MAX_PUBLISHING_STRATEGIC_PRIORITIES_LENGTH} characters or fewer.`,
			);
			return;
		}
		// NULL, never "". An empty string stored where null belongs hashes
		// differently from "never set", which would buy the project a
		// reprocessing run it did not earn.
		const next = trimmed === "" ? null : trimmed;
		if (next === strategicPriorities) {
			return;
		}
		updateSettings.mutate({ strategicPriorities: next });
	};

	const togglePostType = (value: PublishingPostTypeValue) => {
		const next = preferredPostTypes.includes(value)
			? preferredPostTypes.filter((v) => v !== value)
			: [...preferredPostTypes, value];
		updateSettings.mutate({ preferredPostTypes: next });
	};

	const linkedChatChannels: PublishingChatChannel[] = [
		...(teamsLinkedQuery.data ?? []).map((c) => ({
			platform: "TEAMS" as const,
			teamId: c.teamId,
			channelId: c.channelId,
			channelName: c.channelName ?? undefined,
		})),
		...(slackLinkedQuery.data ?? []).map((c) => ({
			platform: "SLACK" as const,
			teamId: c.slackTeamId,
			channelId: c.channelId,
			channelName: c.channelName ?? undefined,
		})),
	];
	const linkedChatChannelsLoaded =
		!teamsLinkedQuery.isLoading && !slackLinkedQuery.isLoading;
	const selectedChatChannels = (s?.chatChannels ??
		[]) as PublishingChatChannel[];

	const toggleChatChannel = (channel: PublishingChatChannel) => {
		const targetKey = chatChannelKey(channel);
		const isSelected = selectedChatChannels.some(
			(c) => chatChannelKey(c) === targetKey,
		);
		// The mutation always carries the FULL next list, including the empty one:
		// with no separate boolean, unchecking the last channel is the only way to
		// turn chat off, so skipping the call on an empty array would leave it on
		// with no control that says so.
		updateSettings.mutate({
			chatChannels: isSelected
				? selectedChatChannels.filter(
						(c) => chatChannelKey(c) !== targetKey,
					)
				: [...selectedChatChannels, channel],
		});
	};

	const settingsDisabled =
		!canEdit || settingsQuery.isLoading || updateSettings.isPending;
	// Deliberately NOT gated on `settingsQuery.isLoading` — Generate now
	// doesn't read the settings row at all, and an Editor (who can't see the
	// settings load complete any differently than an admin) must be able to
	// use it the instant the card mounts, not after an unrelated fetch settles.
	const generateDisabled = !canGenerate || generateNow.isPending;

	return (
		<Card className="bg-card p-6">
			<p className={sectionTitleClass}>Publishing</p>
			<h3 className="mt-2 text-xl font-semibold text-foreground">
				Suggestion cadence &amp; lookback
			</h3>
			<p className="mt-2 max-w-2xl text-sm text-muted-foreground">
				Control how often Fabric looks for new topic suggestions, how
				much history each run considers, and trigger a run on demand.
			</p>

			<div className="mt-5 space-y-5">
				<div className="grid gap-4 sm:grid-cols-2">
					<div className="space-y-2">
						<Label htmlFor="publishing-cadence">
							Suggestion cadence
						</Label>
						<Select
							value={cadence}
							disabled={settingsDisabled}
							onValueChange={(value) =>
								updateSettings.mutate({
									cadence: value as PublishingCadence,
								})
							}
						>
							<SelectTrigger
								id="publishing-cadence"
								className="w-full"
							>
								<SelectValue placeholder="Select cadence" />
							</SelectTrigger>
							<SelectContent>
								{CADENCE_OPTIONS.map((c) => (
									<SelectItem key={c.value} value={c.value}>
										{c.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						<p className="text-xs text-muted-foreground">
							Manual disables scheduled runs — use Generate now
							below whenever you want new suggestions.
						</p>
					</div>

					<div className="space-y-2">
						<Label htmlFor="publishing-lookback">
							Lookback window (days)
						</Label>
						<Input
							id="publishing-lookback"
							type="number"
							min={1}
							max={365}
							inputMode="numeric"
							disabled={settingsDisabled}
							defaultValue={lookbackDays ?? ""}
							key={`lookback-${lookbackDays ?? "default"}`}
							placeholder="Default"
							onBlur={(e) => {
								const raw = e.target.value.trim();
								if (raw !== "" && Number.isNaN(Number(raw))) {
									return;
								}
								const next =
									raw === ""
										? null
										: Math.min(
												365,
												Math.max(
													1,
													Math.round(Number(raw)),
												),
											);
								if (next === lookbackDays) {
									return;
								}
								updateSettings.mutate({ lookbackDays: next });
							}}
						/>
						<p className="text-xs text-muted-foreground">
							How many days of history each run considers. Leave
							blank to use the engine default.
						</p>
					</div>
				</div>

				{/*
				 * 1C-1b part 2 (§7.1(a), FR8–FR10): advisory guidance for topic
				 * SELECTION. Nothing here enforces anything — the deterministic
				 * exclusion filter and its keyword control ship together in a
				 * later slice, deliberately, so an admin is never handed a
				 * switch that visibly does nothing.
				 */}
				<div className="space-y-4 rounded-xl border border-border p-4">
					<div>
						<p className="font-medium text-foreground">
							Recommendation preferences
						</p>
						<p className="text-sm text-muted-foreground">
							Guidance for what each run should look for. It
							shapes which topics are suggested; it does not
							invent material the project has not produced.
						</p>
					</div>

					<div className="space-y-2">
						<Label htmlFor="publishing-preferred-themes">
							Preferred themes
						</Label>
						<Textarea
							id="publishing-preferred-themes"
							rows={4}
							disabled={settingsDisabled}
							defaultValue={preferredThemes.join("\n")}
							// JSON, not `join`. The key exists to REMOUNT this
							// uncontrolled textarea when the server value changes, and a
							// joined key is not injective: ["a", "b"] and ["a b"] produce
							// the same string, so a refetch between those two shapes
							// leaves the old text on screen with nothing to signal it.
							// JSON.stringify separates them, and separates a theme that
							// contains the separator too.
							key={`themes-${JSON.stringify(preferredThemes)}`}
							placeholder={
								"Developer experience\nRelease engineering"
							}
							onBlur={(e) => saveThemes(e.target.value)}
						/>
						<p className="text-xs text-muted-foreground">
							One per line, up to{" "}
							{MAX_PUBLISHING_PREFERENCE_ITEMS}. Leave blank for
							no theme preference.
						</p>
					</div>

					<fieldset className="space-y-2">
						<legend className="font-medium text-foreground text-sm">
							Preferred post types
						</legend>
						<ul className="flex flex-wrap gap-x-6 gap-y-2">
							{PUBLISHING_POST_TYPE_OPTIONS.map((option) => (
								<li key={option.value}>
									<label
										htmlFor={`publishing-post-type-${option.value}`}
										className="flex items-center gap-2 text-foreground text-sm"
									>
										<input
											id={`publishing-post-type-${option.value}`}
											type="checkbox"
											checked={preferredPostTypes.includes(
												option.value,
											)}
											disabled={settingsDisabled}
											aria-label={option.label}
											onChange={() =>
												togglePostType(option.value)
											}
										/>
										<span>{option.label}</span>
									</label>
								</li>
							))}
						</ul>
						<p className="text-xs text-muted-foreground">
							A fixed set — these are the only formats the
							generator produces. Leave all unticked for no
							preference.
						</p>
					</fieldset>

					<div className="space-y-2">
						<Label htmlFor="publishing-strategic-priorities">
							Strategic priorities
						</Label>
						<Textarea
							id="publishing-strategic-priorities"
							rows={4}
							disabled={settingsDisabled}
							defaultValue={strategicPriorities ?? ""}
							// Same reason, narrower collision: "none" is also a string
							// a person can type, and `?? "none"` maps both it and the
							// cleared state to one key.
							key={`priorities-${JSON.stringify(strategicPriorities)}`}
							placeholder="What this project wants its publishing to achieve."
							onBlur={(e) => savePriorities(e.target.value)}
						/>
						<p className="text-xs text-muted-foreground">
							Free text, up to{" "}
							{MAX_PUBLISHING_STRATEGIC_PRIORITIES_LENGTH}{" "}
							characters. Line breaks are kept as written.
						</p>
					</div>
				</div>

				<div className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-border p-4">
					<div className="min-w-0">
						<p className="font-medium text-foreground">
							Notify contributors
						</p>
						<p className="break-words text-sm text-muted-foreground">
							Contributors are notified in-app when they're
							recommended for a suggested topic. Turn this off to
							stop notifications for this project.
						</p>
					</div>
					<Switch
						checked={notificationsEnabled}
						disabled={settingsDisabled}
						aria-label="Notify contributors"
						onCheckedChange={(checked) =>
							updateSettings.mutate({
								notificationsEnabled: checked,
							})
						}
					/>
				</div>

				<div className="space-y-2">
					<p className={sectionTitleClass}>Chat channels</p>
					<p className="text-sm text-muted-foreground">
						Selected channels get a message when a run produces new
						topic suggestions. Leave every channel unchecked to keep
						chat off.
					</p>
					{linkedChatChannels.length > 0 ? (
						<ul className="divide-y divide-border rounded-xl border border-border">
							{linkedChatChannels.map((channel) => {
								const key = chatChannelKey(channel);
								const checked = selectedChatChannels.some(
									(c) => chatChannelKey(c) === key,
								);
								const label = `${channel.platform}: ${
									channel.channelName ?? channel.channelId
								}`;
								return (
									<li
										key={key}
										className="flex items-center gap-3 p-3"
									>
										<label
											htmlFor={`publishing-chat-channel-${key}`}
											className="flex flex-1 items-center gap-3 text-sm text-foreground"
										>
											<input
												id={`publishing-chat-channel-${key}`}
												type="checkbox"
												checked={checked}
												disabled={settingsDisabled}
												aria-label={label}
												onChange={() =>
													toggleChatChannel(channel)
												}
											/>
											<span className="truncate">
												{label}
											</span>
										</label>
									</li>
								);
							})}
						</ul>
					) : linkedChatChannelsLoaded ? (
						<div className="rounded-lg border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
							<p>
								<strong className="text-foreground">
									Connect a Teams or Slack channel
								</strong>{" "}
								to broadcast topic suggestions to chat.
							</p>
						</div>
					) : (
						<p className="text-sm text-muted-foreground">
							Loading connected channels…
						</p>
					)}
				</div>

				<div>
					<Button
						onClick={() => generateNow.mutate()}
						disabled={generateDisabled}
						loading={generateNow.isPending}
					>
						<SparklesIcon className="size-4" aria-hidden="true" />
						Generate now
					</Button>
					<p className="mt-2 text-xs text-muted-foreground">
						Runs the topic-suggestion generator immediately, outside
						the configured cadence. Limited to once per hour.
					</p>
				</div>
			</div>
		</Card>
	);
}
