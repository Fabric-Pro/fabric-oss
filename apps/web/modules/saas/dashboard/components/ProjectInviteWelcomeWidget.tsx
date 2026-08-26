"use client";

import { config } from "@repo/config";
import {
	useOrganizationId,
	useOrganizationSlug,
} from "@saas/organizations/hooks";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Avatar, AvatarFallback, AvatarImage } from "@ui/components/avatar";
import { Button } from "@ui/components/button";
import { cn } from "@ui/lib";
import { ArrowRightIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";

type WelcomeWidgetCommon = {
	projectId: string;
	projectName: string;
	projectDescription: string | null;
	heroImageUrl: string | null;
	heroEmojis: string[];
	icon: string | null;
	color: string | null;
	organizationId: string | null;
	organizationSlug: string | null;
	inviter: { name: string; image: string | null; banned: boolean } | null;
	role: string;
};
export type WelcomeWidgetEntry =
	| (WelcomeWidgetCommon & {
			kind: "invite";
			invitationId: string;
			expiresAt: string | Date;
	  })
	| (WelcomeWidgetCommon & { kind: "member"; acceptedAt: string | Date });

function initialsOf(name: string): string {
	return name
		.split(" ")
		.slice(0, 2)
		.map((w) => w[0] ?? "")
		.join("")
		.toUpperCase();
}

function ProjectVisual({ invite }: { invite: WelcomeWidgetEntry }) {
	const [imgFailed, setImgFailed] = useState(false);
	const showImage = !!invite.heroImageUrl && !imgFailed;
	const emoji = invite.heroEmojis?.[0] ?? invite.icon ?? null;
	const initials = useMemo(
		() => initialsOf(invite.projectName),
		[invite.projectName],
	);

	if (showImage) {
		return (
			// biome-ignore lint/performance/noImgElement: dynamic project hero URL, unknown dimensions
			<img
				src={invite.heroImageUrl ?? undefined}
				alt={invite.projectName}
				onError={() => setImgFailed(true)}
				className="size-16 shrink-0 rounded-xl object-cover"
			/>
		);
	}

	return (
		<div
			aria-hidden="true"
			className={cn(
				"flex size-16 shrink-0 items-center justify-center rounded-xl font-medium text-2xl",
				!invite.color && "bg-muted text-muted-foreground",
			)}
			style={invite.color ? { backgroundColor: invite.color } : undefined}
		>
			{emoji ?? initials}
		</div>
	);
}

/**
 * Dashboard "New Project" welcome widget. Shows the most-recent
 * pending project invitation for the current tenant context, with accept-and-open
 * CTA, persistent dismissal, and a multi-invite "View all" link.
 *
 * The feature flag is enforced at the dashboard level (widget when enabled,
 * PendingInvitationsBanner when disabled) so a rollback never hides invitations —
 * this component therefore does not check the flag itself. It still imports
 * `config` for the avatar image-proxy bucket name.
 */
export function ProjectInviteWelcomeWidget({
	organizationId: organizationIdProp,
	organizationSlug: organizationSlugProp,
}: {
	organizationId?: string | null;
	organizationSlug?: string | null;
} = {}) {
	// Call the hooks unconditionally (hook rules), then prefer explicit props.
	// On org dashboards the parent passes the authoritative org id/slug from
	// server props, avoiding the transient null that useOrganizationId() returns
	// before ActiveOrganizationProvider resolves (which would briefly query
	// PERSONAL invitations on an org page).
	const hookOrganizationId = useOrganizationId();
	const hookOrganizationSlug = useOrganizationSlug();
	const organizationId =
		organizationIdProp !== undefined
			? organizationIdProp
			: hookOrganizationId;
	const organizationSlug =
		organizationSlugProp !== undefined
			? organizationSlugProp
			: hookOrganizationSlug;
	const invitationsPath = organizationSlug
		? `/app/${organizationSlug}/invitations`
		: "/app/invitations";
	const router = useRouter();
	const queryClient = useQueryClient();
	const [dismissedKey, setDismissedKey] = useState<string | null>(null);

	const { data, isLoading } = useQuery({
		queryKey: ["inviteWelcomeWidget", organizationId],
		queryFn: async () =>
			await orpcClient.projects.members.invitations.getWelcomeWidget({
				organizationId,
			}),
		refetchOnWindowFocus: true,
	});

	const mostRecent = (data?.mostRecent ?? null) as WelcomeWidgetEntry | null;
	const totalCount = data?.totalCount ?? 0;

	// Per-instance dismissal key. Invite: re-invite bumps expiresAt → new key.
	// Member: a remove+re-add yields a newer acceptedAt → new key.
	const instanceKey = mostRecent
		? mostRecent.kind === "invite"
			? `invite:${mostRecent.invitationId}:${String(mostRecent.expiresAt)}`
			: `member:${mostRecent.projectId}:${String(mostRecent.acceptedAt)}`
		: null;

	// Derived from the ENTRY's org slug (not the dashboard context), so a guest's
	// org-project entry on personal /app routes to the org-scoped URL.
	const projectHref = mostRecent
		? mostRecent.organizationSlug
			? `/app/${mostRecent.organizationSlug}/projects/${mostRecent.projectId}`
			: `/app/projects/${mostRecent.projectId}`
		: "";

	const acceptMutation = useMutation({
		mutationFn: async () => {
			if (!mostRecent || mostRecent.kind !== "invite") {
				return;
			}
			return await orpcClient.projects.members.invitations.accept({
				invitationId: mostRecent.invitationId,
			});
		},
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: ["inviteWelcomeWidget"],
			});
			queryClient.invalidateQueries({
				queryKey: ["pendingProjectInvitations"],
			});
			queryClient.invalidateQueries({ queryKey: ["projects"] });
			if (projectHref) {
				router.push(projectHref);
			}
		},
		onError: (error) => {
			toast.error("Couldn't open the project", {
				description:
					error instanceof Error ? error.message : String(error),
			});
		},
	});

	const openProject = () => {
		if (!mostRecent) {
			return;
		}
		if (mostRecent.kind === "invite") {
			acceptMutation.mutate();
		} else if (projectHref) {
			router.push(projectHref);
		}
	};

	const dismissMutation = useMutation({
		mutationFn: async () => {
			if (!mostRecent) {
				return;
			}
			return await orpcClient.projects.members.invitations.dismissWelcomeWidget(
				{
					projectId: mostRecent.projectId,
					organizationId,
				},
			);
		},
		onMutate: () => {
			setDismissedKey(instanceKey);
		},
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: ["inviteWelcomeWidget"],
			});
		},
		onError: (error) => {
			setDismissedKey(null);
			toast.error("Couldn't dismiss the invitation", {
				description:
					error instanceof Error ? error.message : String(error),
			});
		},
	});

	if (
		isLoading ||
		!mostRecent ||
		(dismissedKey !== null && instanceKey === dismissedKey)
	) {
		return null;
	}

	const inviterActive = !!mostRecent.inviter && !mostRecent.inviter.banned;
	const inviterName = mostRecent.inviter?.name;
	const headline =
		mostRecent.kind === "invite"
			? inviterActive
				? `${inviterName} has invited you to join ${mostRecent.projectName}.`
				: `You have been invited to ${mostRecent.projectName}.`
			: inviterActive
				? `${inviterName} added you to ${mostRecent.projectName}.`
				: `You were added to ${mostRecent.projectName}.`;

	const inviterImageSrc =
		inviterActive && mostRecent.inviter?.image
			? mostRecent.inviter.image.startsWith("http")
				? mostRecent.inviter.image
				: `/image-proxy/${config.storage.bucketNames.avatars}/${mostRecent.inviter.image}`
			: undefined;

	return (
		<section
			aria-labelledby="invite-welcome-heading"
			className="rounded-2xl border bg-card p-5 shadow-sm motion-safe:animate-in motion-safe:fade-in"
		>
			<div className="flex items-start justify-between gap-3">
				<span className="app-editorial-label">New Project</span>
				<Button
					variant="ghost"
					size="icon-sm"
					onClick={() => dismissMutation.mutate()}
					aria-label="Dismiss invitation"
				>
					<XIcon className="size-4" />
				</Button>
			</div>

			<div className="mt-3 flex items-start gap-4">
				<ProjectVisual key={mostRecent.projectId} invite={mostRecent} />
				<div className="min-w-0 flex-1">
					<h2
						id="invite-welcome-heading"
						className="font-serif text-xl leading-snug"
					>
						{headline}
					</h2>
					{mostRecent.projectDescription ? (
						<p className="mt-1 line-clamp-2 text-muted-foreground text-sm">
							{mostRecent.projectDescription}
						</p>
					) : null}
					{inviterActive && mostRecent.inviter ? (
						<div className="mt-3 flex items-center gap-2 text-muted-foreground text-xs">
							<Avatar className="size-5">
								<AvatarImage src={inviterImageSrc} />
								<AvatarFallback className="bg-secondary/10 text-[10px] text-secondary">
									{initialsOf(mostRecent.inviter.name)}
								</AvatarFallback>
							</Avatar>
							<span>Invited by {mostRecent.inviter.name}</span>
						</div>
					) : null}
				</div>
			</div>

			<div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
				<Button
					onClick={openProject}
					loading={
						mostRecent.kind === "invite" && acceptMutation.isPending
					}
					className="w-full sm:w-auto"
				>
					Open project
					<ArrowRightIcon className="ml-2 size-4" />
				</Button>
				{totalCount >= 2 ? (
					<Link
						href={invitationsPath}
						className="text-muted-foreground text-sm underline-offset-4 hover:text-foreground hover:underline"
					>
						{totalCount} New Project Invites. View all
					</Link>
				) : null}
			</div>
		</section>
	);
}
