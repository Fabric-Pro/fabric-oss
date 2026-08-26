"use client";

import { useSession } from "@saas/auth/hooks/use-session";
import { UserAvatar } from "@shared/components/UserAvatar";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery } from "@tanstack/react-query";
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
import { Textarea } from "@ui/components/textarea";
import { cn } from "@ui/lib";
import { LoaderIcon, UsersIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

type Props = {
	projectId: string;
	storyId: string;
	organizationId: string | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
};

const MESSAGE_MAX_LENGTH = 280;

/**
 * Tag one or more project members and notify them about the current feature.
 * The selector surfaces only project members (creator + accepted members, incl.
 * guests) minus the current user — the same set the server allow-lists in
 * `stories.share`, so a member cannot notify a non-member. An optional message
 * is threaded into the notification snippet.
 */
export function NotifyMembersDialog({
	projectId,
	storyId,
	organizationId,
	open,
	onOpenChange,
}: Props) {
	const t = useTranslations("projects.stories.workspace");
	const { user } = useSession();
	const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
	const [message, setMessage] = useState("");

	// Reset transient state each time the dialog opens.
	useEffect(() => {
		if (open) {
			setSelectedIds(new Set());
			setMessage("");
		}
	}, [open]);

	const membersQuery = useQuery({
		...orpc.projects.members.list.queryOptions({
			input: { projectId, organizationId },
		}),
		enabled: open,
	});

	// `members.list` already returns only the creator + accepted, non-expired
	// members (incl. guests) — the same allow-list the server enforces in
	// `stories.share`. We only drop the current user (can't notify yourself; the
	// server self-skips too).
	const selectableMembers = useMemo(() => {
		const members = membersQuery.data?.members ?? [];
		return members.filter((m) => m.userId !== user?.id);
	}, [membersQuery.data, user?.id]);

	const shareMutation = useMutation(
		orpc.projects.stories.share.mutationOptions({
			onSuccess: (result) => {
				// `notifiedCount` is the number of rows actually written. Zero
				// (everyone was already notified, or a suppression) is not a
				// success — surface it neutrally rather than a green "Notified 0".
				if (result.notifiedCount === 0) {
					toast.info(t("notifyNoneSent"));
				} else {
					toast.success(
						t("notifySuccess", { count: result.notifiedCount }),
					);
				}
				onOpenChange(false);
			},
			onError: () => {
				toast.error(t("notifyError"));
			},
		}),
	);

	const toggle = (userId: string) => {
		setSelectedIds((prev) => {
			const next = new Set(prev);
			if (next.has(userId)) {
				next.delete(userId);
			} else {
				next.add(userId);
			}
			return next;
		});
	};

	const handleSend = () => {
		if (selectedIds.size === 0) {
			return;
		}
		shareMutation.mutate({
			projectId,
			storyId,
			organizationId,
			recipientUserIds: Array.from(selectedIds),
			message: message.trim() ? message.trim() : undefined,
		});
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>{t("notifyTitle")}</DialogTitle>
					<DialogDescription>
						{t("notifyDescription")}
					</DialogDescription>
				</DialogHeader>

				<div className="space-y-4">
					<div className="max-h-64 overflow-y-auto rounded-md border">
						{membersQuery.isLoading ? (
							<div className="flex items-center justify-center gap-2 p-6 text-sm text-muted-foreground">
								<LoaderIcon className="size-4 animate-spin motion-reduce:animate-none" />
								{t("notifyLoadingMembers")}
							</div>
						) : membersQuery.isError ? (
							<div className="flex flex-col items-center gap-2 p-6 text-center text-sm text-muted-foreground">
								<UsersIcon className="size-5" />
								{t("notifyMembersError")}
							</div>
						) : selectableMembers.length === 0 ? (
							<div className="flex flex-col items-center gap-2 p-6 text-center text-sm text-muted-foreground">
								<UsersIcon className="size-5" />
								{t("notifyNoMembers")}
							</div>
						) : (
							<ul className="divide-y">
								{selectableMembers.map((member) => {
									const checked = selectedIds.has(
										member.userId,
									);
									return (
										<li key={member.userId}>
											<label
												className={cn(
													"flex cursor-pointer items-center gap-3 px-3 py-2 transition-colors hover:bg-muted/40",
													checked && "bg-muted/30",
												)}
											>
												<Checkbox
													checked={checked}
													onCheckedChange={() =>
														toggle(member.userId)
													}
													aria-label={t(
														"notifySelectMember",
														{
															name:
																member.user
																	.name ??
																member.user
																	.email,
														},
													)}
												/>
												<UserAvatar
													className="size-7"
													name={
														member.user.name ??
														member.user.email
													}
													avatarUrl={
														member.user.image
													}
												/>
												<span className="min-w-0 flex-1">
													<span className="block truncate text-sm font-medium">
														{member.user.name ??
															member.user.email}
													</span>
													<span className="block truncate text-xs text-muted-foreground">
														{member.isGuest
															? t("notifyGuest")
															: member.user.email}
													</span>
												</span>
											</label>
										</li>
									);
								})}
							</ul>
						)}
					</div>

					<div className="space-y-1.5">
						<Textarea
							value={message}
							onChange={(e) =>
								setMessage(
									e.target.value.slice(0, MESSAGE_MAX_LENGTH),
								)
							}
							placeholder={t("notifyMessagePlaceholder")}
							rows={3}
							maxLength={MESSAGE_MAX_LENGTH}
						/>
					</div>
				</div>

				<DialogFooter>
					<Button
						type="button"
						variant="outline"
						onClick={() => onOpenChange(false)}
					>
						{t("notifyCancel")}
					</Button>
					<Button
						type="button"
						onClick={handleSend}
						disabled={
							selectedIds.size === 0 || shareMutation.isPending
						}
					>
						{shareMutation.isPending ? (
							<LoaderIcon className="size-4 animate-spin motion-reduce:animate-none" />
						) : null}
						{t("notifySend", { count: selectedIds.size })}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
