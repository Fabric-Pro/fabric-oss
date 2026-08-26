"use client";

import {
	FUNCTION_TAG_LABELS,
	FUNCTION_TAG_ORDER,
} from "@repo/database/src/function-tags";
import { useSession } from "@saas/auth/hooks/use-session";
import {
	FunctionTagSelect,
	type FunctionTagValue,
} from "@saas/shared/components/FunctionTagSelect";
import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Avatar, AvatarFallback, AvatarImage } from "@ui/components/avatar";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Card } from "@ui/components/card";
import { DestructiveTooltip } from "@ui/components/destructive-tooltip";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@ui/components/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import {
	MailIcon,
	MoreVerticalIcon,
	PencilIcon,
	PlusIcon,
	ShieldCheckIcon,
	TagIcon,
	TrashIcon,
	UsersIcon,
} from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

type Props = {
	projectId: string;
	organizationId?: string | null;
};

type ProjectMember = {
	userId: string;
	role: string;
	user: {
		id: string;
		name: string | null;
		email: string;
		image: string | null;
	};
	isOwner: boolean;
	isCreator: boolean;
	isGuest: boolean;
	invitedAt: Date | null;
	acceptedAt: Date | null;
	expiresAt: Date | null;
};

const ROLE_LABELS: Record<string, string> = {
	OWNER: "Owner",
	PROJECT_ADMIN: "Project Admin",
	EDITOR: "Editor",
	COMMENTER: "Commenter",
	VIEWER: "Viewer",
};

const ROLE_DESCRIPTIONS: Record<string, string> = {
	OWNER: "Full project access, can delete or transfer the project",
	PROJECT_ADMIN: "Manages members and settings, cannot delete the project",
	EDITOR: "Can edit documents, stories, and contexts",
	COMMENTER: "Can view and comment on project content",
	VIEWER: "Read-only access",
};

export function ProjectMembersSettings({ projectId, organizationId }: Props) {
	const queryClient = useQueryClient();
	const { user: currentUser } = useSession();
	const formatter = useFormatter();
	const t = useTranslations("tooltips.projectSettings");
	const removeMemberCopy = t.raw("removeMember") as {
		label: string;
		warning: string;
	};
	const revokeInvitationCopy = t.raw("revokeInvitation") as {
		label: string;
		warning: string;
	};
	const pendingInvitationsSectionRef = useRef<HTMLDivElement>(null);
	const [inviteDialogOpen, setInviteDialogOpen] = useState(false);
	const [inviteEmail, setInviteEmail] = useState("");
	const [inviteRole, setInviteRole] = useState<
		"OWNER" | "PROJECT_ADMIN" | "EDITOR" | "COMMENTER" | "VIEWER"
	>("VIEWER");
	const [inviteMessage, setInviteMessage] = useState("");
	const [inviteError, setInviteError] = useState<string | null>(null);
	const [isDuplicateInviteError, setIsDuplicateInviteError] = useState(false);
	const [changeRoleMember, setChangeRoleMember] =
		useState<ProjectMember | null>(null);
	const [changeRoleValue, setChangeRoleValue] = useState<
		"OWNER" | "PROJECT_ADMIN" | "EDITOR" | "COMMENTER" | "VIEWER"
	>("VIEWER");
	const [revokeTarget, setRevokeTarget] = useState<{
		id: string;
		email: string;
	} | null>(null);

	// Fetch members
	const { data: membersData, isLoading } = useQuery<{
		members: ProjectMember[];
	}>(
		orpc.projects.members.list.queryOptions({
			input: {
				projectId,
				organizationId: organizationId ?? null,
			},
		}),
	);

	const members = membersData?.members || [];

	// `canManageMembers` is the authoritative, permission-matrix-derived gate
	// for the "Set function tags" control (Task 3's `getProject` addition) —
	// definitionally identical to the write gate in `setForProjectMember`, and
	// deliberately NOT the same as the local `currentUserIsOwner` heuristic
	// used below for role management. IMPORTANT: `organizationId` is passed
	// explicitly from the `organizationId` prop (itself the project's own
	// `organizationId`, threaded down from `ProjectSettings.tsx`) — never an
	// ambient/session value — so this resolves the SAME tenant as the route
	// even if the viewer's active org differs (mirrors the documented fix for
	// Fizzy #1187 elsewhere in this module).
	const { data: projectData } = useQuery(
		orpc.projects.get.queryOptions({
			input: { id: projectId, organizationId: organizationId ?? null },
		}),
	);
	const canManageFunctionTags =
		projectData?.project?.canManageMembers ?? false;

	// Per-member function tags (roster join) — untagged members come back with
	// an empty `functionTags` array, never omitted. The "Set function tags"
	// control below is gated on `functionTagsData` being present (query
	// success), NOT on loading state: in React Query v5, `isLoading` is
	// `isPending && isFetching`, so it flips back to `false` once the query
	// terminally ERRORS even though `data` is still `undefined`. Gating on
	// `!isLoading` would then re-enable the control after a failed read,
	// letting `openTagDialog` seed `tagDraft` as `[]` and a Save silently
	// overwrite the member's real tags with an empty set. Gating on data
	// presence instead keeps the control disabled on both the pending AND
	// the error path (same save-before-load class as Task 2's
	// DefaultFunctionTagsForm).
	const { data: functionTagsData } = useQuery(
		orpc.functionTags.listForProject.queryOptions({
			input: { projectId, organizationId: organizationId ?? null },
		}),
	);
	const tagsByUserId = new Map<string, FunctionTagValue[]>(
		(functionTagsData?.members ?? []).map((m) => [
			m.userId,
			m.functionTags as FunctionTagValue[],
		]),
	);

	const [tagDialogMember, setTagDialogMember] =
		useState<ProjectMember | null>(null);
	const [tagDraft, setTagDraft] = useState<FunctionTagValue[]>([]);

	const openTagDialog = (member: ProjectMember) => {
		setTagDraft(tagsByUserId.get(member.userId) ?? []);
		setTagDialogMember(member);
	};

	// Set member function tags mutation
	const setTagsMutation = useMutation({
		mutationFn: () => {
			// `mutate()` is only reachable from the Save button inside the
			// dialog, which only renders while `tagDialogMember` is set — this
			// guard just gives TypeScript (and any stray call) a safe, typed
			// narrowing instead of a non-null assertion.
			if (!tagDialogMember) {
				throw new Error("No member selected for function tags update");
			}
			return orpcClient.functionTags.setForProjectMember({
				projectId,
				userId: tagDialogMember.userId,
				tags: tagDraft,
				organizationId: organizationId ?? null,
			});
		},
		onSuccess: () => {
			toast.success("Function tags updated");
			setTagDialogMember(null);
			queryClient.invalidateQueries({
				queryKey: orpc.functionTags.listForProject.queryKey({
					input: {
						projectId,
						organizationId: organizationId ?? null,
					},
				}),
			});
		},
		onError: (error: any) => {
			toast.error(
				error?.data?.message ||
					error?.message ||
					"Failed to update function tags",
			);
		},
	});

	// Determine current user's role
	const currentMember = members.find((m) => m.userId === currentUser?.id);
	const currentUserIsOwner =
		currentMember?.isOwner || currentMember?.role === "OWNER";

	// Fetch pending invitations (owner only)
	const { data: sentInvitationsData, isLoading: isLoadingSentInvitations } =
		useQuery(
			orpc.projects.members.listSentInvitations.queryOptions({
				input: { projectId, organizationId: organizationId ?? null },
				enabled: currentUserIsOwner,
			}),
		);
	const sentInvitations = sentInvitationsData?.invitations ?? [];

	// Pre-flight lookup for the invite dialog — shown as a contextual banner
	// once the user has typed a valid-looking email. Debounced so every
	// keystroke doesn't hit the server.
	//
	// The regex must match the stricter server-side `z.string().email()`
	// validation; otherwise a partial-but-plausible string like "x@y"
	// triggers a 400 on the lookup endpoint. Kept simple on purpose — local
	// part + '@' + at least one subdomain + '.' + TLD of 2+ characters.
	const trimmedInviteEmail = inviteEmail.trim().toLowerCase();
	const EMAIL_PREFILTER = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
	const looksLikeEmail = EMAIL_PREFILTER.test(trimmedInviteEmail);
	const [debouncedInviteEmail, setDebouncedInviteEmail] = useState("");
	useEffect(() => {
		const handle = setTimeout(() => {
			setDebouncedInviteEmail(looksLikeEmail ? trimmedInviteEmail : "");
		}, 300);
		return () => clearTimeout(handle);
	}, [trimmedInviteEmail, looksLikeEmail]);
	const { data: emailLookup } = useQuery({
		...orpc.projects.members.lookupEmail.queryOptions({
			input: { projectId, email: debouncedInviteEmail },
		}),
		enabled: inviteDialogOpen && debouncedInviteEmail.length > 0,
		staleTime: 30_000,
	});

	// Invite member mutation
	const inviteMutation = useMutation({
		mutationFn: async () => {
			setInviteError(null);
			setIsDuplicateInviteError(false);
			return await orpcClient.projects.members.invite({
				projectId,
				email: inviteEmail,
				role: inviteRole,
				message: inviteMessage || undefined,
			});
		},
		onSuccess: () => {
			toast.success("Invitation sent successfully");
			setInviteDialogOpen(false);
			setInviteEmail("");
			setInviteMessage("");
			setInviteError(null);
			setIsDuplicateInviteError(false);
			queryClient.invalidateQueries({
				queryKey: orpc.projects.members.list.queryKey({
					input: {
						projectId,
						organizationId: organizationId ?? null,
					},
				}),
			});
			queryClient.invalidateQueries({
				queryKey: orpc.projects.members.listSentInvitations.queryKey({
					input: {
						projectId,
						organizationId: organizationId ?? null,
					},
				}),
			});
		},
		onError: (error: any) => {
			const errorMessage =
				error?.data?.message ||
				error?.message ||
				"Failed to send invitation";
			if (
				errorMessage
					.toLowerCase()
					.includes("already has a pending invitation")
			) {
				setIsDuplicateInviteError(true);
			} else {
				setInviteError(errorMessage);
				toast.error(errorMessage);
			}
		},
	});

	// Remove member mutation
	const removeMutation = useMutation({
		mutationFn: async (userId: string) => {
			return await orpcClient.projects.members.remove({
				projectId,
				userId,
				organizationId: organizationId ?? null,
			});
		},
		onSuccess: () => {
			toast.success("Member removed successfully");
			queryClient.invalidateQueries({
				queryKey: orpc.projects.members.list.queryKey({
					input: {
						projectId,
						organizationId: organizationId ?? null,
					},
				}),
			});
		},
		onError: (error: any) => {
			toast.error(
				error?.data?.message ||
					error?.message ||
					"Failed to remove member",
			);
		},
	});

	// Update member role mutation
	const updateRoleMutation = useMutation({
		mutationFn: async ({
			userId,
			role,
		}: {
			userId: string;
			role: "OWNER" | "PROJECT_ADMIN" | "EDITOR" | "COMMENTER" | "VIEWER";
		}) => {
			return await orpcClient.projects.members.updateRole({
				projectId,
				userId,
				role,
				organizationId: organizationId ?? null,
			});
		},
		onSuccess: () => {
			toast.success("Member role updated successfully");
			setChangeRoleMember(null);
			queryClient.invalidateQueries({
				queryKey: orpc.projects.members.list.queryKey({
					input: {
						projectId,
						organizationId: organizationId ?? null,
					},
				}),
			});
		},
		onError: (error: any) => {
			toast.error(
				error?.data?.message ||
					error?.message ||
					"Failed to update member role",
			);
		},
	});

	// Resend invitation mutation
	const resendInvitationMutation = useMutation({
		mutationFn: async (invitationId: string) => {
			return await orpcClient.projects.members.resendInvitation({
				projectId,
				invitationId,
				organizationId: organizationId ?? null,
			});
		},
		onSuccess: () => {
			toast.success("Invitation resent — new link expires in 7 days");
			queryClient.invalidateQueries({
				queryKey: orpc.projects.members.listSentInvitations.queryKey({
					input: {
						projectId,
						organizationId: organizationId ?? null,
					},
				}),
			});
		},
		onError: (error: any) => {
			const code = error?.data?.code || error?.code;
			if (code === "TOO_MANY_REQUESTS") {
				toast.error("Please wait before resending to this address");
			} else {
				toast.error(
					error?.data?.message ||
						error?.message ||
						"Failed to resend invitation",
				);
			}
		},
	});

	// Revoke invitation mutation
	const revokeInvitationMutation = useMutation({
		mutationFn: async () => {
			if (!revokeTarget) {
				throw new Error("No invitation selected");
			}
			return await orpcClient.projects.members.revokeInvitation({
				projectId,
				invitationId: revokeTarget.id,
				organizationId: organizationId ?? null,
			});
		},
		onSuccess: () => {
			toast.success("Invitation revoked");
			setRevokeTarget(null);
			queryClient.invalidateQueries({
				queryKey: orpc.projects.members.listSentInvitations.queryKey({
					input: {
						projectId,
						organizationId: organizationId ?? null,
					},
				}),
			});
		},
		onError: (error: any) => {
			toast.error(
				error?.data?.message ||
					error?.message ||
					"Failed to revoke invitation",
			);
		},
	});

	const handleChangeRoleOpen = (member: ProjectMember) => {
		setChangeRoleMember(member);
		setChangeRoleValue(
			member.role as
				| "OWNER"
				| "PROJECT_ADMIN"
				| "EDITOR"
				| "COMMENTER"
				| "VIEWER",
		);
	};

	return (
		<Card className="border-foreground/10">
			<div className="p-4 border-b border-foreground/10">
				<div className="flex items-center justify-between">
					<div className="flex items-center gap-3">
						<div className="rounded-lg bg-gradient-to-br from-blue-500/20 to-cyan-500/20 p-2">
							<UsersIcon className="size-4 text-blue-500" />
						</div>
						<div>
							<h3 className="font-medium">Project Members</h3>
							<p className="text-sm text-muted-foreground">
								Manage who has access to this project
							</p>
						</div>
					</div>
					{currentUserIsOwner && (
						<Dialog
							open={inviteDialogOpen}
							onOpenChange={(open) => {
								setInviteDialogOpen(open);
								if (open) {
									setInviteError(null);
									setIsDuplicateInviteError(false);
								}
							}}
						>
							<Tooltip>
								<TooltipTrigger asChild>
									<DialogTrigger asChild>
										<Button size="sm">
											<PlusIcon className="size-4 mr-2" />
											Invite Member
										</Button>
									</DialogTrigger>
								</TooltipTrigger>
								<TooltipContent>
									{t("inviteMember")}
								</TooltipContent>
							</Tooltip>
							<DialogContent>
								<DialogHeader>
									<DialogTitle>Invite Member</DialogTitle>
									<DialogDescription>
										{organizationId
											? "Invite a member from your organization to collaborate on this project."
											: "Invite another user to collaborate on this project."}
									</DialogDescription>
								</DialogHeader>
								<div className="space-y-4">
									<div>
										<Label htmlFor="email">Email</Label>
										<Input
											id="email"
											type="email"
											placeholder="member@example.com"
											value={inviteEmail}
											onChange={(e) =>
												setInviteEmail(e.target.value)
											}
										/>
										{looksLikeEmail &&
											emailLookup?.status ===
												"org_member" && (
												<p className="mt-2 rounded-md border border-primary/30 bg-primary/5 p-2 text-xs text-foreground/80">
													This user is a member of
													your organization. They will
													be added directly to the
													project.
												</p>
											)}
										{looksLikeEmail &&
											emailLookup?.status ===
												"other_org" && (
												<p className="mt-2 rounded-md border border-amber-500/40 bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200">
													This user belongs to another
													Fabric organization. They
													will be invited as an
													external guest with access
													only to this project.
												</p>
											)}
										{looksLikeEmail &&
											emailLookup?.status ===
												"no_account" && (
												<p className="mt-2 rounded-md border border-amber-500/40 bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200">
													This email is not registered
													with Fabric yet. The
													recipient will be prompted
													to create an account and
													will join as a guest on this
													project only.
												</p>
											)}
										{looksLikeEmail &&
											emailLookup?.status ===
												"already_member" && (
												<p className="mt-2 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
													This user is already a
													member of the project.
												</p>
											)}
										{looksLikeEmail &&
											emailLookup?.status ===
												"already_invited" && (
												<p className="mt-2 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
													An invitation is already
													pending for this email.
												</p>
											)}
										{isDuplicateInviteError && (
											<p className="text-sm text-destructive mt-1">
												An invitation is already pending
												for this email.{" "}
												<button
													type="button"
													className="underline"
													onClick={() => {
														setInviteDialogOpen(
															false,
														);
														setTimeout(
															() =>
																pendingInvitationsSectionRef.current?.scrollIntoView(
																	{
																		behavior:
																			"smooth",
																	},
																),
															100,
														);
													}}
												>
													View pending invitations ↓
												</button>
											</p>
										)}
									</div>
									<div>
										<Label htmlFor="role">Role</Label>
										<Select
											value={inviteRole}
											onValueChange={(
												value:
													| "OWNER"
													| "PROJECT_ADMIN"
													| "EDITOR"
													| "COMMENTER"
													| "VIEWER",
											) => setInviteRole(value)}
										>
											<SelectTrigger id="role">
												<SelectValue />
											</SelectTrigger>
											<SelectContent>
												{currentUserIsOwner && (
													<SelectItem value="OWNER">
														Owner -{" "}
														{
															ROLE_DESCRIPTIONS.OWNER
														}
													</SelectItem>
												)}
												<SelectItem value="PROJECT_ADMIN">
													Project Admin -{" "}
													{
														ROLE_DESCRIPTIONS.PROJECT_ADMIN
													}
												</SelectItem>
												<SelectItem value="EDITOR">
													Editor -{" "}
													{ROLE_DESCRIPTIONS.EDITOR}
												</SelectItem>
												<SelectItem value="COMMENTER">
													Commenter -{" "}
													{
														ROLE_DESCRIPTIONS.COMMENTER
													}
												</SelectItem>
												<SelectItem value="VIEWER">
													Viewer -{" "}
													{ROLE_DESCRIPTIONS.VIEWER}
												</SelectItem>
											</SelectContent>
										</Select>
									</div>
									<div>
										<Label htmlFor="message">
											Message (Optional)
										</Label>
										<Input
											id="message"
											placeholder="Add a personal message..."
											value={inviteMessage}
											onChange={(e) =>
												setInviteMessage(e.target.value)
											}
										/>
									</div>
								</div>
								{inviteError && (
									<p className="text-sm text-destructive">
										{inviteError}
									</p>
								)}
								<DialogFooter>
									<Button
										variant="outline"
										onClick={() =>
											setInviteDialogOpen(false)
										}
									>
										Cancel
									</Button>
									<Tooltip>
										<TooltipTrigger asChild>
											<Button
												onClick={() =>
													inviteMutation.mutate()
												}
												disabled={
													!inviteEmail ||
													inviteMutation.isPending
												}
											>
												{inviteMutation.isPending
													? "Sending..."
													: "Send Invitation"}
											</Button>
										</TooltipTrigger>
										<TooltipContent>
											{t("sendInvitation")}
										</TooltipContent>
									</Tooltip>
								</DialogFooter>
							</DialogContent>
						</Dialog>
					)}
				</div>
			</div>

			<div className="p-4">
				{isLoading ? (
					<div className="text-center py-8 text-muted-foreground">
						Loading members...
					</div>
				) : members.length === 0 ? (
					<div className="text-center py-8 text-muted-foreground">
						No members yet. Invite someone to collaborate!
					</div>
				) : (
					<div className="space-y-2">
						{members.map((member: ProjectMember) => {
							// A member can be managed if the current user is an owner,
							// it's not themselves, and it's not the original project creator
							const canManage =
								currentUserIsOwner &&
								member.userId !== currentUser?.id &&
								!member.isCreator;

							return (
								<div
									key={member.userId}
									className="flex items-center justify-between p-3 rounded-lg border border-foreground/10 hover:bg-foreground/5 transition-colors"
								>
									<div className="flex items-center gap-3">
										<Avatar className="size-10">
											<AvatarImage
												src={
													member.user.image ||
													undefined
												}
											/>
											<AvatarFallback>
												{member.user.name?.[0]?.toUpperCase() ||
													"U"}
											</AvatarFallback>
										</Avatar>
										<div>
											<div className="flex items-center gap-2">
												<p className="font-medium">
													{member.user.name}
												</p>
												{member.isCreator && (
													<Badge
														variant="secondary"
														className="text-xs"
													>
														<ShieldCheckIcon className="size-3 mr-1" />
														Creator
													</Badge>
												)}
												{!member.isCreator && (
													<Badge
														variant="outline"
														className="text-xs"
													>
														{ROLE_LABELS[
															member.role
														] || member.role}
													</Badge>
												)}
												{member.isGuest && (
													<Badge
														variant="secondary"
														className="text-xs bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200"
													>
														Guest
													</Badge>
												)}
											</div>
											<p className="text-sm text-muted-foreground">
												{member.user.email}
											</p>
											{(tagsByUserId.get(member.userId)
												?.length ?? 0) > 0 && (
												<div className="mt-1 flex flex-wrap gap-1">
													{FUNCTION_TAG_ORDER.filter(
														(tag) =>
															tagsByUserId
																.get(
																	member.userId,
																)
																?.includes(tag),
													).map((tag) => (
														<Badge
															key={tag}
															variant="outline"
															className="text-xs"
														>
															{
																FUNCTION_TAG_LABELS[
																	tag
																]
															}
														</Badge>
													))}
												</div>
											)}
										</div>
									</div>

									{(canManage || canManageFunctionTags) && (
										<DropdownMenu>
											<Tooltip>
												<TooltipTrigger asChild>
													<DropdownMenuTrigger
														asChild
													>
														<Button
															variant="ghost"
															size="sm"
															aria-label="Member actions"
														>
															<MoreVerticalIcon className="size-4" />
														</Button>
													</DropdownMenuTrigger>
												</TooltipTrigger>
												<TooltipContent>
													{t("memberActions")}
												</TooltipContent>
											</Tooltip>
											<DropdownMenuContent align="end">
												{/* Separators connect ADJACENT present
												    sections only — each one is gated on the
												    section above it also being present, so no
												    two dividers ever render back-to-back (the
												    `canManage`-only load-race state previously
												    produced a double separator). */}
												{canManage && (
													<DropdownMenuItem
														onClick={() =>
															handleChangeRoleOpen(
																member,
															)
														}
													>
														<PencilIcon className="size-4 mr-2" />
														Change Role
													</DropdownMenuItem>
												)}
												{canManageFunctionTags && (
													<>
														{canManage && (
															<DropdownMenuSeparator />
														)}
														<DropdownMenuItem
															disabled={
																!functionTagsData
															}
															onClick={() =>
																openTagDialog(
																	member,
																)
															}
														>
															<TagIcon className="size-4 mr-2" />
															Set function tags
														</DropdownMenuItem>
													</>
												)}
												{canManage && (
													<>
														<DropdownMenuSeparator />
														<DestructiveTooltip
															copy={
																removeMemberCopy
															}
														>
															<DropdownMenuItem
																className="text-destructive"
																onClick={() => {
																	if (
																		confirm(
																			`Remove ${member.user.name} from this project?`,
																		)
																	) {
																		removeMutation.mutate(
																			member.userId,
																		);
																	}
																}}
															>
																<TrashIcon className="size-4 mr-2" />
																Remove Member
															</DropdownMenuItem>
														</DestructiveTooltip>
													</>
												)}
											</DropdownMenuContent>
										</DropdownMenu>
									)}
								</div>
							);
						})}
					</div>
				)}

				{!currentUserIsOwner && !isLoading && (
					<p className="text-xs text-muted-foreground mt-3 text-center">
						Only project owners can invite members and manage roles.
					</p>
				)}
			</div>

			{/* Pending Invitations Section (owner only) */}
			{currentUserIsOwner && (
				<div
					ref={pendingInvitationsSectionRef}
					className="p-4 border-t border-foreground/10"
				>
					<p className="app-editorial-label mb-4">
						Pending Invitations
					</p>
					{isLoadingSentInvitations ? (
						<div className="text-sm text-muted-foreground py-2">
							Loading...
						</div>
					) : sentInvitations.length === 0 ? (
						<p className="text-sm text-muted-foreground">
							No pending invitations
						</p>
					) : (
						<div className="space-y-2">
							{sentInvitations.map((invitation: any) => {
								const isExpired =
									new Date(invitation.expiresAt) < new Date();
								const inviterLabel =
									invitation.inviterName ||
									invitation.inviterEmail;

								return (
									<div
										key={invitation.id}
										className="flex items-center justify-between p-3 rounded-lg border border-foreground/10 hover:bg-foreground/5 transition-colors"
									>
										<div className="flex flex-col gap-0.5">
											<p className="font-medium text-sm">
												{invitation.email}
											</p>
											<div className="flex items-center gap-2 flex-wrap">
												<Badge
													variant="outline"
													className="text-xs"
												>
													{ROLE_LABELS[
														invitation.role
													] || invitation.role}
												</Badge>
												<Badge
													variant="secondary"
													className="text-xs bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200"
												>
													Pending Guest Invite
												</Badge>
												{inviterLabel && (
													<span className="text-xs text-muted-foreground">
														Invited by{" "}
														{inviterLabel}
													</span>
												)}
												<span className="text-xs text-muted-foreground">
													{formatter.relativeTime(
														new Date(
															invitation.createdAt,
														),
														new Date(),
													)}
												</span>
												<span
													className={
														isExpired
															? "text-xs text-destructive"
															: "text-xs text-muted-foreground"
													}
												>
													{isExpired
														? `Expires ${new Date(invitation.expiresAt).toLocaleDateString()}`
														: `Expires ${new Date(invitation.expiresAt).toLocaleDateString()}`}
												</span>
											</div>
										</div>
										<DropdownMenu>
											<Tooltip>
												<TooltipTrigger asChild>
													<DropdownMenuTrigger
														asChild
													>
														<Button
															variant="ghost"
															size="sm"
															aria-label="Invitation actions"
														>
															<MoreVerticalIcon className="size-4" />
														</Button>
													</DropdownMenuTrigger>
												</TooltipTrigger>
												<TooltipContent>
													{t("invitationActions")}
												</TooltipContent>
											</Tooltip>
											<DropdownMenuContent align="end">
												<Tooltip>
													<TooltipTrigger asChild>
														<DropdownMenuItem
															disabled={
																resendInvitationMutation.isPending
															}
															onClick={() =>
																resendInvitationMutation.mutate(
																	invitation.id,
																)
															}
														>
															<MailIcon className="size-4 mr-2" />
															Resend invitation
														</DropdownMenuItem>
													</TooltipTrigger>
													<TooltipContent>
														{t("resendInvitation")}
													</TooltipContent>
												</Tooltip>
												<DropdownMenuSeparator />
												<DestructiveTooltip
													copy={revokeInvitationCopy}
												>
													<DropdownMenuItem
														className="text-destructive"
														disabled={
															resendInvitationMutation.isPending
														}
														onClick={() =>
															setRevokeTarget({
																id: invitation.id,
																email: invitation.email,
															})
														}
													>
														<TrashIcon className="size-4 mr-2" />
														Revoke invitation
													</DropdownMenuItem>
												</DestructiveTooltip>
											</DropdownMenuContent>
										</DropdownMenu>
									</div>
								);
							})}
						</div>
					)}
				</div>
			)}

			{/* Change Role Dialog */}
			<Dialog
				open={!!changeRoleMember}
				onOpenChange={(open) => {
					if (!open) {
						setChangeRoleMember(null);
					}
				}}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Change Member Role</DialogTitle>
						<DialogDescription>
							Update the role for{" "}
							{changeRoleMember?.user.name ||
								changeRoleMember?.user.email}
							. Owners can invite members and manage the project.
						</DialogDescription>
					</DialogHeader>
					<div className="space-y-4">
						<div>
							<Label htmlFor="change-role">New Role</Label>
							<Select
								value={changeRoleValue}
								onValueChange={(
									value:
										| "OWNER"
										| "PROJECT_ADMIN"
										| "EDITOR"
										| "COMMENTER"
										| "VIEWER",
								) => setChangeRoleValue(value)}
							>
								<SelectTrigger id="change-role">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{currentUserIsOwner && (
										<SelectItem value="OWNER">
											Owner - {ROLE_DESCRIPTIONS.OWNER}
										</SelectItem>
									)}
									<SelectItem value="PROJECT_ADMIN">
										Project Admin -{" "}
										{ROLE_DESCRIPTIONS.PROJECT_ADMIN}
									</SelectItem>
									<SelectItem value="EDITOR">
										Editor - {ROLE_DESCRIPTIONS.EDITOR}
									</SelectItem>
									<SelectItem value="COMMENTER">
										Commenter -{" "}
										{ROLE_DESCRIPTIONS.COMMENTER}
									</SelectItem>
									<SelectItem value="VIEWER">
										Viewer - {ROLE_DESCRIPTIONS.VIEWER}
									</SelectItem>
								</SelectContent>
							</Select>
						</div>
					</div>
					<DialogFooter>
						<Button
							variant="outline"
							onClick={() => setChangeRoleMember(null)}
						>
							Cancel
						</Button>
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									onClick={() => {
										if (changeRoleMember) {
											updateRoleMutation.mutate({
												userId: changeRoleMember.userId,
												role: changeRoleValue,
											});
										}
									}}
									disabled={updateRoleMutation.isPending}
								>
									{updateRoleMutation.isPending
										? "Updating..."
										: "Update Role"}
								</Button>
							</TooltipTrigger>
							<TooltipContent>{t("updateRole")}</TooltipContent>
						</Tooltip>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			{/* Set Function Tags Dialog — gated ONLY on canManageFunctionTags, so
			    it's reachable for any real member, including the creator/self
			    (Decision 4, locked). */}
			<Dialog
				open={!!tagDialogMember}
				onOpenChange={(open) => {
					if (!open) {
						setTagDialogMember(null);
					}
				}}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Set function tags</DialogTitle>
						<DialogDescription>
							Function tags for{" "}
							{tagDialogMember?.user.name ||
								tagDialogMember?.user.email}{" "}
							on this project.
						</DialogDescription>
					</DialogHeader>
					<FunctionTagSelect
						aria-label="Member function tags"
						value={tagDraft}
						onChange={setTagDraft}
						disabled={setTagsMutation.isPending}
					/>
					<DialogFooter>
						<Button
							variant="outline"
							onClick={() => setTagDialogMember(null)}
						>
							Cancel
						</Button>
						<Button
							loading={setTagsMutation.isPending}
							disabled={
								// Defense-in-depth: never let Save persist while
								// the tags read hasn't succeeded — covers both the
								// pending state AND a terminal error (where
								// `isLoading` would already be false but `data` is
								// still undefined) — which would overwrite the real
								// set with the empty seed. Also re-gate on the
								// authoritative capability in case `canManageMembers`
								// flipped to false during a refetch while the dialog
								// is open (the server also rejects it).
								!functionTagsData || !canManageFunctionTags
							}
							onClick={() => setTagsMutation.mutate()}
						>
							Save
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			{/* Revoke Invitation Confirmation Dialog */}
			<Dialog
				open={revokeTarget !== null}
				onOpenChange={(open) => {
					if (!open) {
						setRevokeTarget(null);
					}
				}}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Revoke invitation</DialogTitle>
						<DialogDescription>
							Are you sure you want to revoke the invitation for{" "}
							{revokeTarget?.email}? They will no longer be able
							to accept it.
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button
							variant="outline"
							onClick={() => setRevokeTarget(null)}
						>
							Cancel
						</Button>
						<DestructiveTooltip copy={revokeInvitationCopy}>
							<Button
								variant="destructive"
								onClick={() =>
									revokeInvitationMutation.mutate()
								}
								disabled={revokeInvitationMutation.isPending}
							>
								{revokeInvitationMutation.isPending
									? "Revoking..."
									: "Revoke"}
							</Button>
						</DestructiveTooltip>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</Card>
	);
}
