"use client";

import { useContextPath, useOrganizationId } from "@saas/organizations/hooks";
import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";
import { Alert, AlertDescription, AlertTitle } from "@ui/components/alert";
import { Button } from "@ui/components/button";
import { MailIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

/**
 * Banner that displays when the user has pending project invitations.
 * Shown at the top of the dashboard to prompt users to accept/decline invitations.
 * Detects context (personal vs organization) and links to the appropriate invitations page.
 */
export function PendingInvitationsBanner() {
	const [isDismissed, setIsDismissed] = useState(false);
	const invitationsPath = useContextPath("invitations");
	const organizationId = useOrganizationId();

	// Query pending invitations filtered by tenant context
	const { data, isLoading } = useQuery({
		queryKey: ["pendingProjectInvitations", organizationId],
		queryFn: async () => {
			return await orpcClient.projects.members.invitations.list({
				organizationId,
			});
		},
		refetchInterval: 60000, // Refresh every minute
	});

	const invitationCount = data?.invitations?.length ?? 0;

	// Don't show banner if:
	// - Still loading
	// - User dismissed it (for this session)
	// - No pending invitations
	if (isLoading || isDismissed || invitationCount === 0) {
		return null;
	}

	const title =
		invitationCount === 1
			? "You have a pending project invitation"
			: `You have ${invitationCount} pending project invitations`;

	const description =
		invitationCount === 1
			? `You've been invited to collaborate on "${data?.invitations[0]?.project?.name}". View and respond to the invitation.`
			: "You've been invited to collaborate on multiple projects. View and respond to the invitations.";

	// Generate the correct invitations URL based on context
	const invitationsUrl = invitationsPath;

	return (
		<Alert variant="primary" className="mb-4">
			<MailIcon className="size-4" />
			<AlertTitle className="flex items-center justify-between">
				<span className="font-bold">{title}</span>
				<Button
					variant="ghost"
					size="icon"
					className="size-6 hover:bg-primary/20"
					onClick={() => setIsDismissed(true)}
					aria-label="Dismiss notification"
				>
					<XIcon className="size-4" />
				</Button>
			</AlertTitle>
			<AlertDescription className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
				<span className="text-sm">{description}</span>
				<Button
					asChild
					size="sm"
					variant="outline"
					className="shrink-0"
				>
					<Link href={invitationsUrl}>
						<MailIcon className="mr-2 size-4" />
						View Invitations
					</Link>
				</Button>
			</AlertDescription>
		</Alert>
	);
}
