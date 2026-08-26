"use client";

/**
 * TeamsChannelPickerDialog
 *
 * Dialog for selecting Microsoft Teams channels (team channels only, not
 * group chats) to link to the project's Teams Channel Monitor. Lets the user
 * pick one or more channels and choose a backfill mode before confirming.
 *
 * Reuses `orpc.projects.contexts.listAvailableTeamsChats` — it already returns
 * the `channels` array. Channels already linked to the monitor are disabled.
 */

import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Checkbox } from "@ui/components/checkbox";
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
import { cn } from "@ui/lib";
import {
	AlertCircleIcon,
	ChevronDownIcon,
	ChevronRightIcon,
	HashIcon,
	LoaderIcon,
	UsersIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

type BackfillMode = "from-now" | "latest-30";

type Props = {
	projectId: string;
	organizationId?: string | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
};

type LinkedChannel = {
	id: string;
	teamId: string;
	channelId: string;
};

export function TeamsChannelPickerDialog({
	projectId,
	organizationId,
	open,
	onOpenChange,
}: Props) {
	const queryClient = useQueryClient();
	const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
	const [expandedTeams, setExpandedTeams] = useState<Set<string>>(new Set());
	const [backfillMode, setBackfillMode] = useState<BackfillMode>("from-now");

	// Reset selection when dialog opens
	useEffect(() => {
		if (open) {
			setSelectedKeys(new Set());
			setBackfillMode("from-now");
			setExpandedTeams(new Set());
		}
	}, [open]);

	// Fetch available Teams channels via the existing contexts procedure
	const teamsQuery = useQuery({
		queryKey: [
			"teams-channel-picker-available",
			projectId,
			organizationId ?? null,
		],
		queryFn: async () => {
			return await orpcClient.projects.contexts.listAvailableTeamsChats({
				projectId,
				organizationId: organizationId ?? null,
			});
		},
		enabled: open,
	});

	// Fetch currently linked channels to pre-disable them
	const linkedChannelsQuery = useQuery({
		queryKey: [
			"teams-channel-monitor-linked",
			projectId,
			organizationId ?? null,
		],
		queryFn: async () => {
			const result =
				await orpcClient.projects.teamsChannelMonitor.listLinkedChannels(
					{
						projectId,
						organizationId: organizationId ?? null,
					},
				);
			return (result ?? []) as LinkedChannel[];
		},
		enabled: open,
	});

	const channels = useMemo(
		() => teamsQuery.data?.channels ?? [],
		[teamsQuery.data],
	);
	const isConnected = teamsQuery.data?.isConnected ?? true;
	const fetchError = teamsQuery.data?.error;

	// Build a set of already-linked channel keys: teamId:channelId
	const linkedKeys = useMemo(() => {
		const keys = new Set<string>();
		for (const row of linkedChannelsQuery.data ?? []) {
			keys.add(`${row.teamId}:${row.channelId}`);
		}
		return keys;
	}, [linkedChannelsQuery.data]);

	// Group channels by team for the disclosure UI
	const channelsByTeam = useMemo(() => {
		const grouped = new Map<
			string,
			{ teamId: string; teamName: string; channels: typeof channels }
		>();
		for (const ch of channels) {
			const existing = grouped.get(ch.teamId);
			if (existing) {
				existing.channels.push(ch);
			} else {
				grouped.set(ch.teamId, {
					teamId: ch.teamId,
					teamName: ch.teamName,
					channels: [ch],
				});
			}
		}
		return grouped;
	}, [channels]);

	const toggleSelection = useCallback((key: string, isLinked: boolean) => {
		if (isLinked) {
			return;
		}
		setSelectedKeys((prev) => {
			const next = new Set(prev);
			if (next.has(key)) {
				next.delete(key);
			} else {
				next.add(key);
			}
			return next;
		});
	}, []);

	const toggleTeamExpanded = useCallback((teamId: string) => {
		setExpandedTeams((prev) => {
			const next = new Set(prev);
			if (next.has(teamId)) {
				next.delete(teamId);
			} else {
				next.add(teamId);
			}
			return next;
		});
	}, []);

	// Link mutation — fired once per selected channel
	const linkMutation = useMutation({
		mutationFn: async () => {
			const keys = Array.from(selectedKeys);
			const results = await Promise.allSettled(
				keys.map((key) => {
					// Teams channel IDs contain colons (e.g. "19:abc@thread.tacv2"),
					// so split on the first colon only and keep the remainder intact.
					const colonIndex = key.indexOf(":");
					const teamId = key.slice(0, colonIndex);
					const channelId = key.slice(colonIndex + 1);
					const channel = channels.find(
						(c) => c.teamId === teamId && c.id === channelId,
					);
					return orpcClient.projects.teamsChannelMonitor.linkChannel({
						projectId,
						organizationId: organizationId ?? null,
						teamId,
						channelId,
						teamName: channel?.teamName,
						channelName: channel?.name,
						backfillMode,
					});
				}),
			);
			const succeeded = results.filter(
				(r) => r.status === "fulfilled",
			).length;
			const failed = results.length - succeeded;
			return { succeeded, failed, total: results.length };
		},
		onSuccess: ({ succeeded, failed, total }) => {
			if (succeeded > 0) {
				toast.success(
					`Linked ${succeeded} channel${succeeded === 1 ? "" : "s"}`,
					failed > 0
						? {
								description: `${failed} failed to link.`,
							}
						: undefined,
				);
			} else if (failed > 0) {
				toast.error(
					`Failed to link ${failed} channel${failed === 1 ? "" : "s"}`,
				);
				return;
			}
			queryClient.invalidateQueries({
				queryKey: [
					"teams-channel-monitor-linked",
					projectId,
					organizationId ?? null,
				],
			});
			queryClient.invalidateQueries({
				queryKey: [
					"teams-channel-monitor-pending-proposals-count",
					projectId,
					organizationId ?? null,
				],
			});
			if (succeeded === total) {
				onOpenChange(false);
			}
		},
		onError: (error) => {
			toast.error("Failed to link channels", {
				description:
					error instanceof Error ? error.message : "Unknown error",
			});
		},
	});

	const isLoading = teamsQuery.isLoading || linkedChannelsQuery.isLoading;
	const hasContent = channels.length > 0;
	const selectedCount = selectedKeys.size;

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-lg">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<HashIcon className="size-5 text-primary" />
						Link Teams Channels
					</DialogTitle>
					<DialogDescription>
						Choose channels whose threads Fabric should analyze for
						backlog proposals.
					</DialogDescription>
				</DialogHeader>

				{isLoading && (
					<div className="flex flex-col items-center gap-3 py-10 text-center">
						<LoaderIcon className="size-6 animate-spin text-primary" />
						<p className="text-sm text-foreground/70">
							Loading your Teams channels...
						</p>
					</div>
				)}

				{!isLoading && teamsQuery.error && (
					<div className="flex flex-col items-center gap-3 py-8 text-center">
						<AlertCircleIcon className="size-8 text-destructive" />
						<p className="text-foreground/70">
							Failed to load Teams data
						</p>
						<p className="text-foreground/50 text-sm">
							{teamsQuery.error instanceof Error
								? teamsQuery.error.message
								: "An unexpected error occurred"}
						</p>
					</div>
				)}

				{!isLoading && !teamsQuery.error && !isConnected && (
					<div className="flex flex-col items-center gap-4 py-8 text-center">
						<div className="rounded-full bg-highlight/10 p-4">
							<AlertCircleIcon className="size-8 text-highlight" />
						</div>
						<div>
							<p className="font-medium text-foreground/80">
								Microsoft account not connected
							</p>
							<p className="mt-1 text-foreground/50 text-sm">
								{fetchError ||
									"Connect your Microsoft account in Settings → Integrations to access Teams channels."}
							</p>
						</div>
					</div>
				)}

				{!isLoading &&
					!teamsQuery.error &&
					isConnected &&
					!hasContent && (
						<div className="flex flex-col items-center gap-3 py-8 text-center">
							<HashIcon className="size-8 text-foreground/30" />
							<p className="text-foreground/70">
								No team channels found
							</p>
							<p className="text-foreground/50 text-sm">
								You must be a member of a team with channels in
								Microsoft Teams.
							</p>
						</div>
					)}

				{!isLoading &&
					!teamsQuery.error &&
					isConnected &&
					hasContent && (
						<>
							<div className="max-h-[300px] space-y-1 overflow-y-auto rounded-lg border">
								{Array.from(channelsByTeam.values()).map(
									(team) => {
										const isExpanded = expandedTeams.has(
											team.teamId,
										);
										const teamLinkedCount =
											team.channels.filter((c) =>
												linkedKeys.has(
													`${c.teamId}:${c.id}`,
												),
											).length;
										return (
											<div key={team.teamId}>
												<button
													type="button"
													onClick={() =>
														toggleTeamExpanded(
															team.teamId,
														)
													}
													className="flex w-full items-center gap-2 px-3 py-2.5 text-left hover:bg-accent/50"
												>
													{isExpanded ? (
														<ChevronDownIcon className="size-4 shrink-0 text-foreground/50" />
													) : (
														<ChevronRightIcon className="size-4 shrink-0 text-foreground/50" />
													)}
													<UsersIcon className="size-4 shrink-0 text-foreground/50" />
													<span className="truncate font-medium text-sm">
														{team.teamName}
													</span>
													<span className="ml-auto shrink-0 text-foreground/40 text-xs">
														{team.channels.length}{" "}
														channel
														{team.channels
															.length !== 1
															? "s"
															: ""}
														{teamLinkedCount >
															0 && (
															<>
																{" · "}
																{
																	teamLinkedCount
																}{" "}
																linked
															</>
														)}
													</span>
												</button>
												{isExpanded && (
													<div className="space-y-0.5 border-t px-2 py-1.5">
														{team.channels.map(
															(ch) => {
																const key = `${ch.teamId}:${ch.id}`;
																const isLinked =
																	linkedKeys.has(
																		key,
																	);
																const isSelected =
																	selectedKeys.has(
																		key,
																	);
																return (
																	// biome-ignore lint/a11y/noLabelWithoutControl: wraps a Radix Checkbox which renders a <button>, not a native <input>
																	<label
																		key={
																			key
																		}
																		className={cn(
																			"flex items-center gap-2.5 rounded-md px-2 py-2 transition-colors",
																			isLinked
																				? "cursor-not-allowed bg-muted/50 opacity-60"
																				: isSelected
																					? "cursor-pointer bg-primary/10"
																					: "cursor-pointer hover:bg-accent/50",
																		)}
																	>
																		<Checkbox
																			checked={
																				isSelected ||
																				isLinked
																			}
																			disabled={
																				isLinked
																			}
																			onCheckedChange={() =>
																				toggleSelection(
																					key,
																					isLinked,
																				)
																			}
																		/>
																		<HashIcon className="size-3.5 shrink-0 text-foreground/40" />
																		<span className="truncate text-sm">
																			{
																				ch.name
																			}
																		</span>
																		{isLinked && (
																			<span className="ml-auto shrink-0 rounded-full bg-primary/10 px-1.5 py-0.5 text-primary text-xs">
																				Linked
																			</span>
																		)}
																	</label>
																);
															},
														)}
													</div>
												)}
											</div>
										);
									},
								)}
							</div>

							<div className="space-y-3 rounded-lg border border-foreground/10 bg-muted/30 p-4">
								<div>
									<p className="text-sm font-medium">
										Backfill behavior
									</p>
									<p className="mt-0.5 text-xs text-muted-foreground">
										Applies to every channel you link now.
									</p>
								</div>
								<RadioGroup
									value={backfillMode}
									onValueChange={(v) =>
										setBackfillMode(v as BackfillMode)
									}
									className="space-y-2"
								>
									<div className="flex items-start gap-3">
										<RadioGroupItem
											value="from-now"
											id="backfill-from-now"
											className="mt-0.5"
										/>
										<Label
											htmlFor="backfill-from-now"
											className="flex-1 cursor-pointer space-y-0.5 font-normal"
										>
											<span className="block text-sm font-medium">
												Only new messages from now
											</span>
											<span className="block text-xs text-muted-foreground">
												Recommended. Best for busy
												channels with lots of history.
											</span>
										</Label>
									</div>
									<div className="flex items-start gap-3">
										<RadioGroupItem
											value="latest-30"
											id="backfill-latest-30"
											className="mt-0.5"
										/>
										<Label
											htmlFor="backfill-latest-30"
											className="flex-1 cursor-pointer space-y-0.5 font-normal"
										>
											<span className="block text-sm font-medium">
												Include last 30 messages
											</span>
											<span className="block text-xs text-muted-foreground">
												Use when the recent history
												already contains feature
												discussions worth capturing.
											</span>
										</Label>
									</div>
								</RadioGroup>
							</div>

							<div className="text-sm text-muted-foreground">
								{selectedCount} channel
								{selectedCount !== 1 ? "s" : ""} selected
							</div>
						</>
					)}

				<DialogFooter>
					<Button
						variant="outline"
						onClick={() => onOpenChange(false)}
					>
						Cancel
					</Button>
					<Button
						onClick={() => linkMutation.mutate()}
						disabled={
							selectedCount === 0 ||
							linkMutation.isPending ||
							!isConnected
						}
					>
						{linkMutation.isPending ? (
							<>
								<LoaderIcon className="mr-2 size-4 animate-spin" />
								Linking...
							</>
						) : (
							`Link ${selectedCount} Channel${
								selectedCount !== 1 ? "s" : ""
							}`
						)}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
