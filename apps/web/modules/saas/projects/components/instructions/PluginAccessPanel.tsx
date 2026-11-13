"use client";

/**
 * "Plugin access" (spec 2026-11-04 §4.4, on request): members need read
 * access to the project's private instructions repository on GitHub to
 * install the instructions plugin, and Fabric grants it with one click.
 *
 * Hidden when the project has no instructions repository, or it is not on
 * GitHub (the list answers `available: false`). A member's GitHub login comes
 * from their own GitHub credential; only a member with no GitHub credential
 * at all is asked to connect GitHub. The repository's owner, and a member
 * GitHub already gives access, get no grant button. On a personal-account repository GitHub gives collaborators write
 * access, so the first grant there asks for confirmation.
 */

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@ui/components/alert-dialog";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Card } from "@ui/components/card";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ui/components/popover";
import {
	Loader2Icon,
	MoreHorizontalIcon,
	TriangleAlertIcon,
} from "lucide-react";
import Link from "next/link";
import { useId, useState } from "react";
import { toast } from "sonner";

type GrantStatus = "INVITED" | "ACTIVE" | "FAILED" | "REVOKED";

type MemberGitHubAccess =
	| "OWNER"
	| "HAS_ACCESS"
	| "NO_ACCESS"
	| "ACCOUNT_UNKNOWN"
	| "NOT_CONNECTED";

type BadgeStatus = "success" | "warning" | "error" | "info";

/** What a member row's badge says. */
function memberAccessBadge(member: {
	access: MemberGitHubAccess;
	grant: { status: GrantStatus } | null;
}): { label: string; status: BadgeStatus } {
	if (member.access === "OWNER") {
		return { label: "Owner — has access", status: "success" };
	}
	const status = member.grant?.status;
	if (status === "ACTIVE") {
		return { label: "Has access", status: "success" };
	}
	if (status === "INVITED") {
		return { label: "Invited", status: "warning" };
	}
	if (status === "FAILED") {
		return { label: "Failed", status: "error" };
	}
	if (member.access === "HAS_ACCESS") {
		return { label: "Has access", status: "success" };
	}
	if (member.access === "ACCOUNT_UNKNOWN") {
		return { label: "GitHub account unknown", status: "warning" };
	}
	if (member.access === "NOT_CONNECTED") {
		return { label: "Not connected", status: "info" };
	}
	return { label: "No access from Fabric", status: "info" };
}

/** Whether Fabric can grant the member access now. */
function canBeGranted(member: {
	access: MemberGitHubAccess;
	grant: { status: GrantStatus } | null;
}): boolean {
	return (
		member.access === "NO_ACCESS" &&
		member.grant?.status !== "ACTIVE" &&
		member.grant?.status !== "INVITED"
	);
}

function errorMessage(error: unknown): string {
	return error instanceof Error && error.message
		? error.message
		: "Something went wrong. Try again.";
}

type GrantRequest = { userIds: string[] } | { all: true };

export function PluginAccessPanel({
	projectId,
	readOnlyMode = false,
}: {
	projectId: string;
	readOnlyMode?: boolean;
}) {
	const headingId = useId();
	const queryClient = useQueryClient();
	const { organizationSlug, isGuest } = useOrganizationContext();
	const listOptions =
		orpc.projects.instructions.memberAccess.list.queryOptions({
			input: { projectId },
		});
	const list = useQuery({ ...listOptions, staleTime: 30_000 });
	const grant = useMutation(
		orpc.projects.instructions.memberAccess.grant.mutationOptions(),
	);
	const revoke = useMutation(
		orpc.projects.instructions.memberAccess.revoke.mutationOptions(),
	);
	const [pendingConfirm, setPendingConfirm] = useState<GrantRequest | null>(
		null,
	);
	const [busyUserId, setBusyUserId] = useState<string | "all" | null>(null);

	const data = list.data;
	if (!data || !data.available) {
		return null;
	}
	const personal = data.ownerType === "personal";
	const canAct = data.canGrant && !readOnlyMode;
	const anyFabricGrant = data.members.some(
		(m) => m.grant && m.grant.status !== "FAILED",
	);
	const connectHref =
		organizationSlug && !isGuest
			? `/app/${organizationSlug}/connections?tab=credentials`
			: null;
	const grantable = data.members.filter(canBeGranted);

	async function refresh() {
		await queryClient.invalidateQueries({ queryKey: listOptions.queryKey });
	}

	async function runGrant(request: GrantRequest, confirmed: boolean) {
		setBusyUserId("all" in request ? "all" : (request.userIds[0] ?? null));
		try {
			const { results } = await grant.mutateAsync({
				projectId,
				...request,
				confirmPersonalWriteAccess: confirmed,
			});
			const failed = results.filter((r) => r.outcome === "FAILED");
			const done = results.filter(
				(r) => r.outcome === "GRANTED" || r.outcome === "INVITED",
			);
			const already = results.filter(
				(r) => r.outcome === "ALREADY_HAD_ACCESS",
			);
			if (failed.length > 0) {
				toast.error(
					failed[0]?.message ??
						"GitHub refused the grant. See the member's row.",
				);
			} else if (done.length > 0) {
				toast.success(
					done.some((r) => r.outcome === "INVITED")
						? "GitHub sent an invitation. Access starts once it is accepted."
						: "Access granted.",
				);
			} else if (already.length > 0) {
				toast.info(
					"This member already had access on GitHub. Fabric left it as it was.",
				);
			} else {
				toast.info("Nothing to grant.");
			}
		} catch (error) {
			toast.error(errorMessage(error));
		} finally {
			setBusyUserId(null);
			await refresh();
		}
	}

	function requestGrant(request: GrantRequest) {
		if (personal && !anyFabricGrant) {
			setPendingConfirm(request);
			return;
		}
		void runGrant(request, personal);
	}

	async function runRevoke(userId: string) {
		setBusyUserId(userId);
		try {
			await revoke.mutateAsync({ projectId, userId });
			toast.success("Access revoked.");
		} catch (error) {
			toast.error(errorMessage(error));
		} finally {
			setBusyUserId(null);
			await refresh();
		}
	}

	return (
		<Card className="p-4">
			<section
				aria-labelledby={headingId}
				className="flex flex-col gap-3"
			>
				<div className="flex flex-wrap items-start justify-between gap-2">
					<div className="space-y-1">
						<h3 id={headingId} className="font-medium text-sm">
							Plugin access
						</h3>
						<p className="text-muted-foreground text-sm">
							Members need read access to{" "}
							<code className="rounded bg-muted px-1 py-0.5 text-xs">
								{data.repository}
							</code>
							{personal ? (
								<Popover>
									<PopoverTrigger asChild>
										<button
											type="button"
											className="ml-1 inline-flex size-5 items-center justify-center rounded align-middle text-amber-600 hover:bg-amber-50 focus-visible:outline-2 focus-visible:outline-ring dark:text-amber-400 dark:hover:bg-amber-950"
											aria-label="Personal repository: collaborators get write access. Show details"
											title="Personal repository: collaborators get write access"
										>
											<TriangleAlertIcon
												className="size-3.5"
												aria-hidden="true"
											/>
										</button>
									</PopoverTrigger>
									<PopoverContent className="w-80 text-sm">
										<p className="font-medium">
											This repository belongs to a
											personal account
										</p>
										<p className="mt-1 text-muted-foreground">
											GitHub gives collaborators on
											personal repositories write access,
											never read-only. Move it to a GitHub
											organization to give members
											read-only access.
										</p>
									</PopoverContent>
								</Popover>
							) : null}{" "}
							to install the instructions plugin.
						</p>
					</div>
					{canAct && grantable.length > 0 ? (
						<Button
							type="button"
							size="sm"
							variant="outline"
							disabled={busyUserId !== null}
							onClick={() => requestGrant({ all: true })}
						>
							{busyUserId === "all" ? (
								<Loader2Icon
									className="size-4 motion-safe:animate-spin"
									aria-hidden="true"
								/>
							) : null}
							Grant to all
						</Button>
					) : null}
				</div>

				{data.repositoryProblem ? (
					<output className="block text-muted-foreground text-sm">
						{data.repositoryProblem}
					</output>
				) : null}

				<ul className="divide-y rounded-md border" aria-label="Members">
					{data.members.map((member) => {
						const badge = memberAccessBadge(member);
						const live =
							member.grant?.status === "ACTIVE" ||
							member.grant?.status === "INVITED";
						const busy = busyUserId === member.userId;
						const displayName = member.name ?? "Unnamed member";
						return (
							<li
								key={member.userId}
								className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm"
							>
								<div className="min-w-0 flex-1">
									<p className="truncate font-medium">
										{displayName}
										{member.isCaller ? (
											<span className="text-muted-foreground">
												{" "}
												(you)
											</span>
										) : null}
									</p>
									{member.githubLogin ? (
										<p className="text-muted-foreground text-xs">
											GitHub: {member.githubLogin}
										</p>
									) : member.access === "ACCOUNT_UNKNOWN" ? (
										<p className="text-muted-foreground text-xs">
											GitHub has not said which account
											{member.isCaller
												? " your saved token belongs to"
												: " their saved token belongs to"}
											. Check the token in Connections.
										</p>
									) : (
										<p className="text-muted-foreground text-xs">
											{member.isCaller && connectHref ? (
												<Link
													href={connectHref}
													className="underline underline-offset-2"
												>
													Connect GitHub to install
													the plugin
												</Link>
											) : (
												"Connect GitHub to install the plugin"
											)}
										</p>
									)}
									{member.grant?.status === "FAILED" &&
									member.grant.lastError ? (
										<p className="text-destructive text-xs">
											{member.grant.lastError}
										</p>
									) : null}
								</div>
								<Badge status={badge.status}>
									{badge.label}
								</Badge>
								{canAct && canBeGranted(member) ? (
									<Button
										type="button"
										size="sm"
										variant="outline"
										disabled={busyUserId !== null}
										aria-label={`Grant access to ${displayName}`}
										onClick={() =>
											requestGrant({
												userIds: [member.userId],
											})
										}
									>
										{busy ? (
											<Loader2Icon
												className="size-4 motion-safe:animate-spin"
												aria-hidden="true"
											/>
										) : null}
										Grant access
									</Button>
								) : null}
								{canAct && live ? (
									<DropdownMenu>
										<DropdownMenuTrigger asChild>
											<Button
												type="button"
												size="sm"
												variant="ghost"
												disabled={busyUserId !== null}
												aria-label={`Access actions for ${displayName}`}
											>
												{busy ? (
													<Loader2Icon
														className="size-4 motion-safe:animate-spin"
														aria-hidden="true"
													/>
												) : (
													<MoreHorizontalIcon
														strokeWidth={2.5}
														className="size-4"
														aria-hidden="true"
													/>
												)}
											</Button>
										</DropdownMenuTrigger>
										<DropdownMenuContent align="end">
											<DropdownMenuItem
												className="text-destructive"
												onSelect={() =>
													void runRevoke(
														member.userId,
													)
												}
											>
												Revoke
											</DropdownMenuItem>
										</DropdownMenuContent>
									</DropdownMenu>
								) : null}
							</li>
						);
					})}
				</ul>

				<AlertDialog
					open={pendingConfirm !== null}
					onOpenChange={(open) => {
						if (!open) {
							setPendingConfirm(null);
						}
					}}
				>
					<AlertDialogContent>
						<AlertDialogHeader>
							<AlertDialogTitle>
								Members will get write access
							</AlertDialogTitle>
							<AlertDialogDescription>
								{data.repository} belongs to a personal GitHub
								account. GitHub gives collaborators on personal
								repositories write access, not read-only. To
								give read-only access, move the repository to a
								GitHub organization first.
							</AlertDialogDescription>
						</AlertDialogHeader>
						<AlertDialogFooter>
							<AlertDialogCancel>Cancel</AlertDialogCancel>
							<AlertDialogAction
								onClick={() => {
									const request = pendingConfirm;
									setPendingConfirm(null);
									if (request) {
										void runGrant(request, true);
									}
								}}
							>
								Grant write access
							</AlertDialogAction>
						</AlertDialogFooter>
					</AlertDialogContent>
				</AlertDialog>
			</section>
		</Card>
	);
}
