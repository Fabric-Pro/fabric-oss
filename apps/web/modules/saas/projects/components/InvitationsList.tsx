"use client";

import { useOrganizationId } from "@saas/organizations/hooks/use-organization-context";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
} from "@ui/components/card";
import { Skeleton } from "@ui/components/skeleton";
import { formatDistanceToNow } from "date-fns";
import {
	CheckIcon,
	ClockIcon,
	FolderIcon,
	MailIcon,
	UserIcon,
	XIcon,
} from "lucide-react";
import { toast } from "sonner";

interface Invitation {
	id: string;
	email: string;
	role: string;
	message: string | null;
	status: string;
	createdAt: string | Date;
	expiresAt: string | Date;
	project: {
		id: string;
		name: string;
		description: string | null;
		userId: string;
		organizationId: string | null;
		user: {
			name: string | null;
			image: string | null;
		};
	};
}

function InvitationCard({
	invitation,
	onUpdate,
}: {
	invitation: Invitation;
	onUpdate: () => void;
}) {
	const queryClient = useQueryClient();

	const acceptMutation = useMutation({
		mutationFn: async () => {
			return await orpcClient.projects.members.invitations.accept({
				invitationId: invitation.id,
			});
		},
		onSuccess: () => {
			toast.success("Invitation accepted", {
				description: `You now have access to "${invitation.project.name}"`,
			});
			queryClient.invalidateQueries({
				queryKey: ["pendingProjectInvitations"],
			});
			queryClient.invalidateQueries({ queryKey: ["projects"] });
			onUpdate();
		},
		onError: (error) => {
			toast.error("Failed to accept invitation", {
				description:
					error instanceof Error ? error.message : String(error),
			});
		},
	});

	const declineMutation = useMutation({
		mutationFn: async () => {
			return await orpcClient.projects.members.invitations.decline({
				invitationId: invitation.id,
			});
		},
		onSuccess: () => {
			toast.success("Invitation declined");
			queryClient.invalidateQueries({
				queryKey: ["pendingProjectInvitations"],
			});
			onUpdate();
		},
		onError: (error) => {
			toast.error("Failed to decline invitation", {
				description:
					error instanceof Error ? error.message : String(error),
			});
		},
	});

	const isLoading = acceptMutation.isPending || declineMutation.isPending;
	const expiresAt = new Date(invitation.expiresAt);
	const isExpiringSoon =
		expiresAt.getTime() - Date.now() < 24 * 60 * 60 * 1000; // Less than 24 hours

	const roleColors: Record<string, string> = {
		OWNER: "bg-primary/10 text-primary dark:bg-primary/20 dark:text-primary",
		EDITOR: "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300",
		VIEWER: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
	};

	return (
		<Card className="overflow-hidden transition-all hover:shadow-md">
			<CardHeader className="pb-3">
				<div className="flex items-start justify-between gap-4">
					<div className="flex items-center gap-3">
						<div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
							<FolderIcon className="h-5 w-5 text-primary" />
						</div>
						<div>
							<CardTitle className="text-lg">
								{invitation.project.name}
							</CardTitle>
							<CardDescription className="flex items-center gap-1 mt-1">
								<UserIcon className="h-3 w-3" />
								From{" "}
								{invitation.project.user?.name || "Unknown"}
							</CardDescription>
						</div>
					</div>
					<Badge
						className={
							roleColors[invitation.role] || roleColors.VIEWER
						}
					>
						{invitation.role.charAt(0) +
							invitation.role.slice(1).toLowerCase()}
					</Badge>
				</div>
			</CardHeader>

			<CardContent className="pb-3">
				{invitation.project.description && (
					<p className="text-sm text-muted-foreground mb-3 line-clamp-2">
						{invitation.project.description}
					</p>
				)}

				{invitation.message && (
					<div className="bg-muted/50 rounded-lg p-3 mb-3">
						<p className="text-sm italic text-muted-foreground">
							"{invitation.message}"
						</p>
					</div>
				)}

				<div className="flex items-center gap-4 text-xs text-muted-foreground">
					<span className="flex items-center gap-1">
						<MailIcon className="h-3 w-3" />
						Invited{" "}
						{formatDistanceToNow(new Date(invitation.createdAt), {
							addSuffix: true,
						})}
					</span>
					<span
						className={`flex items-center gap-1 ${isExpiringSoon ? "text-orange-500" : ""}`}
					>
						<ClockIcon className="h-3 w-3" />
						Expires{" "}
						{formatDistanceToNow(expiresAt, { addSuffix: true })}
					</span>
				</div>
			</CardContent>

			<CardFooter className="border-t bg-muted/20 pt-3">
				<div className="flex w-full gap-2">
					<Button
						variant="outline"
						className="flex-1"
						onClick={() => declineMutation.mutate()}
						disabled={isLoading}
					>
						<XIcon className="h-4 w-4 mr-2" />
						Decline
					</Button>
					<Button
						className="flex-1"
						onClick={() => acceptMutation.mutate()}
						disabled={isLoading}
					>
						<CheckIcon className="h-4 w-4 mr-2" />
						Accept
					</Button>
				</div>
			</CardFooter>
		</Card>
	);
}

function InvitationSkeleton() {
	return (
		<Card>
			<CardHeader className="pb-3">
				<div className="flex items-start justify-between gap-4">
					<div className="flex items-center gap-3">
						<Skeleton className="h-10 w-10 rounded-lg" />
						<div>
							<Skeleton className="h-5 w-40 mb-2" />
							<Skeleton className="h-3 w-24" />
						</div>
					</div>
					<Skeleton className="h-5 w-16" />
				</div>
			</CardHeader>
			<CardContent className="pb-3">
				<Skeleton className="h-4 w-full mb-2" />
				<Skeleton className="h-4 w-3/4 mb-3" />
				<Skeleton className="h-3 w-48" />
			</CardContent>
			<CardFooter className="border-t pt-3">
				<div className="flex w-full gap-2">
					<Skeleton className="h-9 flex-1" />
					<Skeleton className="h-9 flex-1" />
				</div>
			</CardFooter>
		</Card>
	);
}

export function InvitationsList() {
	const organizationId = useOrganizationId();

	const { data, isLoading, refetch } = useQuery({
		queryKey: ["pendingProjectInvitations", organizationId],
		queryFn: async () => {
			return await orpcClient.projects.members.invitations.list({
				organizationId,
			});
		},
	});

	const invitations = data?.invitations || [];

	if (isLoading) {
		return (
			<div className="space-y-6">
				<div>
					<h1
						className="text-2xl tracking-tight"
						style={{
							fontFamily:
								"var(--font-sans, 'EB Garamond', Georgia, serif)",
							fontWeight: 400,
						}}
					>
						Project Invitations
					</h1>
					<p className="text-muted-foreground mt-1">
						Review and respond to pending project invitations
					</p>
				</div>
				<div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
					<InvitationSkeleton />
					<InvitationSkeleton />
				</div>
			</div>
		);
	}

	return (
		<div className="space-y-6">
			<div>
				<h1
					className="text-2xl tracking-tight"
					style={{
						fontFamily:
							"var(--font-sans, 'EB Garamond', Georgia, serif)",
						fontWeight: 400,
					}}
				>
					Project Invitations
				</h1>
				<p className="text-muted-foreground mt-1">
					Review and respond to pending project invitations
				</p>
			</div>

			{invitations.length === 0 ? (
				<Card className="p-12 text-center">
					<div className="flex flex-col items-center gap-4">
						<div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted">
							<MailIcon className="h-8 w-8 text-muted-foreground" />
						</div>
						<div>
							<h3 className="text-lg font-semibold">
								No pending invitations
							</h3>
							<p className="text-sm text-muted-foreground mt-1">
								You'll see invitations here when someone invites
								you to collaborate on a project.
							</p>
						</div>
					</div>
				</Card>
			) : (
				<div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
					{invitations.map((invitation) => (
						<InvitationCard
							key={invitation.id}
							invitation={invitation as Invitation}
							onUpdate={() => refetch()}
						/>
					))}
				</div>
			)}
		</div>
	);
}
