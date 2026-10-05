"use client";

import { orpcClient } from "@shared/lib/orpc-client";
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
	AlertDialogTrigger,
} from "@ui/components/alert-dialog";
import { Button } from "@ui/components/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@ui/components/card";
import { toast } from "sonner";

export function IntegrationSharingControls({
	organizationId,
	provider,
}: {
	organizationId?: string | null;
	provider: string;
}) {
	const queryClient = useQueryClient();
	const { data, isError } = useQuery({
		queryKey: ["integration-sharing", organizationId, provider],
		enabled: !!organizationId,
		queryFn: () =>
			orpcClient.workflows.integrations.listSharing({
				organizationId,
				provider,
			}),
	});
	const update = useMutation({
		mutationFn: (input: {
			integrationId: string;
			usageScope: "OWNER_ONLY" | "ORGANIZATION_SHARED";
		}) =>
			orpcClient.workflows.integrations.setUsageScope({
				...input,
				organizationId,
			}),
		onSuccess: () => {
			toast.success("Connection sharing updated");
			void queryClient.invalidateQueries({
				queryKey: ["integration-sharing"],
			});
			void queryClient.invalidateQueries({
				queryKey: ["workflow-integrations"],
			});
			void queryClient.invalidateQueries({
				queryKey: ["workflow-integration-status"],
			});
		},
		onError: () =>
			toast.error(
				"Could not update connection sharing. Refresh and try again.",
			),
	});
	if (!organizationId) {
		return null;
	}
	return (
		<Card>
			<CardHeader>
				<CardTitle>Connection access</CardTitle>
				<CardDescription>
					Connections are private by default. Share only an account
					that every member of this organization may use.
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-4">
				{isError ? (
					<p role="alert" className="text-sm text-destructive">
						Could not load connection access.
					</p>
				) : null}
				{data?.connections?.map((connection) => (
					<div
						key={connection.id}
						className="flex flex-wrap items-center justify-between gap-3"
					>
						<div>
							<p className="text-sm font-medium">
								{connection.name}
							</p>
							<p className="text-sm text-muted-foreground">
								{connection.personalOnly
									? "Only you — this connection is personal and cannot be shared"
									: connection.usageScope ===
											"ORGANIZATION_SHARED"
										? "Shared with organization"
										: "Only you"}
							</p>
						</div>
						{connection.usageScope === "ORGANIZATION_SHARED" &&
						connection.canRevoke ? (
							<Button
								variant="outline"
								size="sm"
								disabled={update.isPending}
								aria-label={`Stop sharing ${connection.name}`}
								onClick={() =>
									update.mutate({
										integrationId: connection.id,
										usageScope: "OWNER_ONLY",
									})
								}
							>
								Stop sharing
							</Button>
						) : null}
						{connection.usageScope === "OWNER_ONLY" &&
						connection.canShare ? (
							<AlertDialog>
								<AlertDialogTrigger asChild>
									<Button
										variant="outline"
										size="sm"
										disabled={update.isPending}
										aria-label={`Share ${connection.name} with organization`}
									>
										Share with organization
									</Button>
								</AlertDialogTrigger>
								<AlertDialogContent>
									<AlertDialogHeader>
										<AlertDialogTitle>
											Share {connection.name}?
										</AlertDialogTitle>
										<AlertDialogDescription>
											Current organization members can use
											this account through supported
											workflow steps and integration API
											operations, including the data and
											actions its credentials permit. You
											can stop sharing at any time.
										</AlertDialogDescription>
									</AlertDialogHeader>
									<AlertDialogFooter>
										<AlertDialogCancel>
											Cancel
										</AlertDialogCancel>
										<AlertDialogAction
											onClick={() =>
												update.mutate({
													integrationId:
														connection.id,
													usageScope:
														"ORGANIZATION_SHARED",
												})
											}
										>
											Share connection
										</AlertDialogAction>
									</AlertDialogFooter>
								</AlertDialogContent>
							</AlertDialog>
						) : null}
					</div>
				))}
				{data?.connections?.length === 0 ? (
					<p className="text-sm text-muted-foreground">
						Connect an account to manage access.
					</p>
				) : null}
				{data?.connections?.some(
					(connection) =>
						connection.ownedByCaller &&
						!connection.canShare &&
						!connection.personalOnly &&
						connection.usageScope === "OWNER_ONLY",
				) ? (
					<p className="text-sm text-muted-foreground">
						An organization owner or admin can share a connection
						they own.
					</p>
				) : null}
			</CardContent>
		</Card>
	);
}
