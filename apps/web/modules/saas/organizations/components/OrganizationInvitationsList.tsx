"use client";

import type { OrganizationMemberRole } from "@repo/auth";
import { isOrganizationAdmin } from "@repo/auth/lib/helper";
import { useSession } from "@saas/auth/hooks/use-session";
import {
	orgInvitationsQueryKey,
	useFullOrganizationQuery,
	useOrgInvitationsQuery,
} from "@saas/organizations/lib/api";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import {
	flexRender,
	getCoreRowModel,
	getFilteredRowModel,
	getPaginationRowModel,
	getSortedRowModel,
	useReactTable,
} from "@tanstack/react-table";
import { Button } from "@ui/components/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import { Table, TableBody, TableCell, TableRow } from "@ui/components/table";
import { cn } from "@ui/lib";
import {
	CheckIcon,
	ClockIcon,
	MailIcon,
	MailXIcon,
	MoreVerticalIcon,
	XIcon,
} from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useMemo } from "react";
import { toast } from "sonner";
import { OrganizationRoleSelect } from "./OrganizationRoleSelect";

type OrgInvitation = {
	id: string;
	email: string;
	role: string | null;
	status: string;
	expiresAt: Date;
	inviterId: string;
	inviterName: string | null;
	inviterEmail: string | null;
};

export function OrganizationInvitationsList({
	organizationId,
}: {
	organizationId: string;
}) {
	const t = useTranslations();
	const queryClient = useQueryClient();
	const { user } = useSession();
	const formatter = useFormatter();
	const { data: organization } = useFullOrganizationQuery(organizationId);
	const { data: invitationsData } = useOrgInvitationsQuery(organizationId);

	const canUserEditInvitations = isOrganizationAdmin(organization, user);

	const invitations = useMemo(
		() =>
			invitationsData?.filter(
				(invitation) => invitation.status === "pending",
			) ?? [],
		[invitationsData],
	);

	const resendMutation = useMutation({
		mutationFn: (invitationId: string) =>
			orpcClient.organizations.invitations.resend({
				invitationId,
				organizationId,
			}),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: orgInvitationsQueryKey(organizationId),
			});
			toast.success(
				t(
					"organizations.settings.members.notifications.resendInvitation.success.description",
				),
			);
		},
		onError: (error: unknown) => {
			const isRateLimited =
				(error as { code?: string })?.code === "TOO_MANY_REQUESTS" ||
				(error as { message?: string })?.message
					?.toLowerCase()
					.includes("please wait");
			if (isRateLimited) {
				toast.error(
					t(
						"organizations.settings.members.notifications.resendInvitation.rateLimited.description",
					),
				);
			} else {
				toast.error(
					t(
						"organizations.settings.members.notifications.resendInvitation.error.description",
					),
				);
			}
		},
	});

	const revokeInvitation = (invitationId: string) => {
		toast.promise(
			async () => {
				await orpcClient.organizations.invitations.cancel({
					invitationId,
					organizationId,
				});
			},
			{
				loading: t(
					"organizations.settings.members.notifications.revokeInvitation.loading.description",
				),
				success: () => {
					queryClient.invalidateQueries({
						queryKey: orgInvitationsQueryKey(organizationId),
					});
					return t(
						"organizations.settings.members.notifications.revokeInvitation.success.description",
					);
				},
				error: t(
					"organizations.settings.members.notifications.revokeInvitation.error.description",
				),
			},
		);
	};

	const columns: ColumnDef<OrgInvitation>[] = [
		{
			accessorKey: "email",
			accessorFn: (row) => row.email,
			cell: ({ row }) => {
				const InvitationStatusIcon =
					{
						pending: ClockIcon,
						accepted: CheckIcon,
						rejected: XIcon,
						canceled: XIcon,
					}[
						row.original.status as
							| "pending"
							| "accepted"
							| "rejected"
							| "canceled"
					] ?? ClockIcon;

				const isExpired = new Date(row.original.expiresAt) < new Date();
				const inviterDisplay =
					row.original.inviterName || row.original.inviterEmail;

				return (
					<div className="leading-normal">
						<strong
							className={cn("block", {
								"opacity-50":
									row.original.status === "canceled",
							})}
						>
							{row.original.email}
						</strong>
						<small className="flex flex-wrap gap-1 text-foreground/60">
							<span className="flex items-center gap-0.5">
								<InvitationStatusIcon className="size-3" />
								{t(
									`organizations.settings.members.invitations.invitationStatus.${row.original.status}`,
								)}
							</span>
							<span>-</span>
							<span
								className={cn({
									"text-destructive": isExpired,
								})}
							>
								{isExpired
									? t(
											"organizations.settings.members.invitations.expired",
										)
									: t(
											"organizations.settings.members.invitations.expiresAt",
											{
												date: formatter.dateTime(
													new Date(
														row.original.expiresAt,
													),
													{
														dateStyle: "medium",
														timeStyle: "short",
													},
												),
											},
										)}
							</span>
							{inviterDisplay && (
								<>
									<span>·</span>
									<span>
										{t(
											"organizations.settings.members.invitations.invitedBy",
											{ name: inviterDisplay },
										)}
									</span>
								</>
							)}
						</small>
					</div>
				);
			},
		},
		{
			accessorKey: "actions",
			cell: ({ row }) => {
				const isPending = row.original.status === "pending";

				return (
					<div className="flex flex-row justify-end gap-2">
						<OrganizationRoleSelect
							value={
								(row.original.role as OrganizationMemberRole) ??
								"member"
							}
							disabled
							onSelect={() => {
								return;
							}}
						/>

						{canUserEditInvitations && (
							<DropdownMenu>
								<DropdownMenuTrigger asChild>
									<Button size="icon" variant="ghost">
										<MoreVerticalIcon className="size-4" />
									</Button>
								</DropdownMenuTrigger>
								<DropdownMenuContent>
									<DropdownMenuItem
										disabled={
											!isPending ||
											resendMutation.isPending
										}
										onClick={() =>
											resendMutation.mutate(
												row.original.id,
											)
										}
									>
										<MailIcon className="mr-2 size-4" />
										{t(
											"organizations.settings.members.invitations.resend",
										)}
									</DropdownMenuItem>
									<DropdownMenuItem
										disabled={
											!isPending ||
											resendMutation.isPending
										}
										onClick={() =>
											revokeInvitation(row.original.id)
										}
									>
										<MailXIcon className="mr-2 size-4" />
										{t(
											"organizations.settings.members.invitations.revoke",
										)}
									</DropdownMenuItem>
								</DropdownMenuContent>
							</DropdownMenu>
						)}
					</div>
				);
			},
		},
	];

	const table = useReactTable({
		data: invitations,
		columns,
		getCoreRowModel: getCoreRowModel(),
		getPaginationRowModel: getPaginationRowModel(),
		getSortedRowModel: getSortedRowModel(),
		getFilteredRowModel: getFilteredRowModel(),
	});

	return (
		<div className="rounded-md border">
			<Table>
				<TableBody>
					{table.getRowModel().rows?.length ? (
						table.getRowModel().rows.map((row) => (
							<TableRow
								key={row.id}
								data-state={row.getIsSelected() && "selected"}
							>
								{row.getVisibleCells().map((cell) => (
									<TableCell key={cell.id}>
										{flexRender(
											cell.column.columnDef.cell,
											cell.getContext(),
										)}
									</TableCell>
								))}
							</TableRow>
						))
					) : (
						<TableRow>
							<TableCell
								colSpan={columns.length}
								className="h-24 text-center"
							>
								{t(
									"organizations.settings.members.invitations.empty",
								)}
							</TableCell>
						</TableRow>
					)}
				</TableBody>
			</Table>
		</div>
	);
}
