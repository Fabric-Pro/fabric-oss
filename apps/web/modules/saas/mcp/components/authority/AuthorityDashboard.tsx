"use client";

/**
 * AuthorityDashboard
 *
 * Admin/user dashboard showing active authority sessions, recent grants,
 * and pending approval requests. Provides a central view of all runtime
 * authority state for debugging and management.
 */

import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Card, CardContent } from "@ui/components/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@ui/components/tabs";
import {
	CheckCircle2,
	Clock,
	RefreshCw,
	Shield,
	ShieldAlert,
	ShieldCheck,
	ShieldOff,
	XCircle,
} from "lucide-react";
import { AuthorityApprovalCard } from "./AuthorityApprovalCard";

interface AuthorityDashboardProps {
	organizationId?: string | null;
}

export function AuthorityDashboard({
	organizationId,
}: AuthorityDashboardProps) {
	const queryClient = useQueryClient();

	// Fetch active sessions
	const { data: activeSessions, isLoading: loadingActive } = useQuery({
		queryKey: ["authority-sessions", "ACTIVE", organizationId],
		queryFn: () =>
			orpcClient.mcp.authority.list({
				organizationId: organizationId ?? null,
				status: "ACTIVE",
				limit: 20,
			}),
		refetchInterval: 10_000, // Refresh every 10s for real-time state
	});

	// Fetch pending sessions
	const { data: pendingSessions, isLoading: loadingPending } = useQuery({
		queryKey: ["authority-sessions", "PENDING", organizationId],
		queryFn: () =>
			orpcClient.mcp.authority.list({
				organizationId: organizationId ?? null,
				status: "PENDING",
				limit: 20,
			}),
		refetchInterval: 5_000, // Refresh more often for pending approvals
	});

	// Fetch recent completed/expired/revoked sessions
	const { data: recentSessions } = useQuery({
		queryKey: ["authority-sessions", "recent", organizationId],
		queryFn: async () => {
			const [expired, revoked, completed] = await Promise.all([
				orpcClient.mcp.authority.list({
					organizationId: organizationId ?? null,
					status: "EXPIRED",
					limit: 5,
				}),
				orpcClient.mcp.authority.list({
					organizationId: organizationId ?? null,
					status: "REVOKED",
					limit: 5,
				}),
				orpcClient.mcp.authority.list({
					organizationId: organizationId ?? null,
					status: "COMPLETED",
					limit: 5,
				}),
			]);
			return [
				...expired.sessions,
				...revoked.sessions,
				...completed.sessions,
			].sort(
				(a, b) =>
					new Date(b.requestedAt).getTime() -
					new Date(a.requestedAt).getTime(),
			);
		},
	});

	const invalidateAll = () => {
		queryClient.invalidateQueries({ queryKey: ["authority-sessions"] });
	};

	const approveMutation = useMutation({
		mutationFn: async ({
			sessionId,
			instructions,
		}: {
			sessionId: string;
			instructions?: string;
		}) => {
			return orpcClient.mcp.authority.approve({
				sessionId,
				organizationId: organizationId ?? null,
				instructions,
			});
		},
		onSuccess: invalidateAll,
	});

	const denyMutation = useMutation({
		mutationFn: async ({
			sessionId,
			reason,
		}: {
			sessionId: string;
			reason?: string;
		}) => {
			return orpcClient.mcp.authority.deny({
				sessionId,
				organizationId: organizationId ?? null,
				reason,
			});
		},
		onSuccess: invalidateAll,
	});

	const revokeMutation = useMutation({
		mutationFn: async (sessionId: string) => {
			return orpcClient.mcp.authority.revoke({
				sessionId,
				organizationId: organizationId ?? null,
			});
		},
		onSuccess: invalidateAll,
	});

	const pendingCount = pendingSessions?.total ?? 0;
	const activeCount = activeSessions?.total ?? 0;

	return (
		<div className="space-y-6">
			{/* Header */}
			<div className="flex items-center justify-between">
				<div>
					<h2 className="text-lg font-semibold flex items-center gap-2">
						<Shield className="h-5 w-5" />
						Runtime Authority
					</h2>
					<p className="text-sm text-muted-foreground">
						Manage temporary runtime access for AI agents to
						connected systems
					</p>
				</div>
				<Button
					variant="outline"
					size="sm"
					onClick={invalidateAll}
					className="gap-1.5"
				>
					<RefreshCw className="h-3.5 w-3.5" />
					Refresh
				</Button>
			</div>

			{/* Summary cards */}
			<div className="grid grid-cols-3 gap-4">
				<Card>
					<CardContent className="pt-4">
						<div className="flex items-center justify-between">
							<div>
								<p className="text-sm text-muted-foreground">
									Pending
								</p>
								<p className="text-2xl font-bold">
									{pendingCount}
								</p>
							</div>
							<ShieldAlert className="h-8 w-8 text-yellow-500 opacity-50" />
						</div>
					</CardContent>
				</Card>
				<Card>
					<CardContent className="pt-4">
						<div className="flex items-center justify-between">
							<div>
								<p className="text-sm text-muted-foreground">
									Active
								</p>
								<p className="text-2xl font-bold">
									{activeCount}
								</p>
							</div>
							<ShieldCheck className="h-8 w-8 text-green-500 opacity-50" />
						</div>
					</CardContent>
				</Card>
				<Card>
					<CardContent className="pt-4">
						<div className="flex items-center justify-between">
							<div>
								<p className="text-sm text-muted-foreground">
									Recent
								</p>
								<p className="text-2xl font-bold">
									{recentSessions?.length ?? 0}
								</p>
							</div>
							<ShieldOff className="h-8 w-8 text-gray-400 opacity-50" />
						</div>
					</CardContent>
				</Card>
			</div>

			{/* Tabbed content */}
			<Tabs defaultValue={pendingCount > 0 ? "pending" : "active"}>
				<TabsList>
					<TabsTrigger value="pending" className="gap-1.5">
						<Clock className="h-3.5 w-3.5" />
						Pending
						{pendingCount > 0 && (
							<Badge
								variant="destructive"
								className="ml-1 text-xs"
							>
								{pendingCount}
							</Badge>
						)}
					</TabsTrigger>
					<TabsTrigger value="active" className="gap-1.5">
						<ShieldCheck className="h-3.5 w-3.5" />
						Active
					</TabsTrigger>
					<TabsTrigger value="history" className="gap-1.5">
						<Clock className="h-3.5 w-3.5" />
						History
					</TabsTrigger>
				</TabsList>

				<TabsContent value="pending" className="space-y-3 mt-4">
					{loadingPending && (
						<p className="text-sm text-muted-foreground">
							Loading...
						</p>
					)}
					{pendingSessions?.sessions.length === 0 && (
						<Card>
							<CardContent className="py-8 text-center text-muted-foreground">
								<ShieldCheck className="h-8 w-8 mx-auto mb-2 opacity-50" />
								<p>No pending authority requests</p>
							</CardContent>
						</Card>
					)}
					{pendingSessions?.sessions.map((session) => (
						<AuthorityApprovalCard
							key={session.id}
							session={{
								id: session.id,
								runType: session.runType,
								status: session.status,
								expiresAt: String(session.expiresAt),
								grants: session.grants.map((g) => ({
									id: g.id,
									providerKey: g.providerKey,
									providerDisplayName: g.providerDisplayName,
									accessLevel: g.accessLevel as
										| "READ"
										| "WRITE",
									status: String(g.status),
									kind: String(g.kind),
								})),
							}}
							onApprove={async (id, instructions) => {
								await approveMutation.mutateAsync({
									sessionId: id,
									instructions,
								});
							}}
							onDeny={async (id, reason) => {
								await denyMutation.mutateAsync({
									sessionId: id,
									reason,
								});
							}}
						/>
					))}
				</TabsContent>

				<TabsContent value="active" className="space-y-3 mt-4">
					{loadingActive && (
						<p className="text-sm text-muted-foreground">
							Loading...
						</p>
					)}
					{activeSessions?.sessions.length === 0 && (
						<Card>
							<CardContent className="py-8 text-center text-muted-foreground">
								<Shield className="h-8 w-8 mx-auto mb-2 opacity-50" />
								<p>No active authority sessions</p>
							</CardContent>
						</Card>
					)}
					{activeSessions?.sessions.map((session) => (
						<AuthorityApprovalCard
							key={session.id}
							session={{
								id: session.id,
								runType: session.runType,
								status: session.status,
								expiresAt: String(session.expiresAt),
								grants: session.grants.map((g) => ({
									id: g.id,
									providerKey: g.providerKey,
									providerDisplayName: g.providerDisplayName,
									accessLevel: g.accessLevel as
										| "READ"
										| "WRITE",
									status: String(g.status),
									kind: String(g.kind),
								})),
							}}
							onApprove={async () => {}}
							onDeny={async () => {}}
							onRevoke={async (id) => {
								await revokeMutation.mutateAsync(id);
							}}
						/>
					))}
				</TabsContent>

				<TabsContent value="history" className="mt-4">
					{recentSessions?.length === 0 && (
						<Card>
							<CardContent className="py-8 text-center text-muted-foreground">
								<Clock className="h-8 w-8 mx-auto mb-2 opacity-50" />
								<p>No recent authority sessions</p>
							</CardContent>
						</Card>
					)}
					<div className="space-y-2">
						{recentSessions?.map((session) => (
							<div
								key={session.id}
								className="flex items-center justify-between rounded-md border px-4 py-3"
							>
								<div className="flex items-center gap-3">
									{session.status === "EXPIRED" && (
										<Clock className="h-4 w-4 text-gray-400" />
									)}
									{session.status === "REVOKED" && (
										<XCircle className="h-4 w-4 text-red-400" />
									)}
									{session.status === "COMPLETED" && (
										<CheckCircle2 className="h-4 w-4 text-green-400" />
									)}
									<div>
										<p className="text-sm font-medium">
											{session.grants
												.map(
													(g) =>
														g.providerDisplayName ||
														g.providerKey,
												)
												.join(", ")}
										</p>
										<p className="text-xs text-muted-foreground">
											{session.runType} ·{" "}
											{new Date(
												session.requestedAt,
											).toLocaleString()}
										</p>
									</div>
								</div>
								<Badge
									variant="outline"
									className="text-xs capitalize"
								>
									{session.status.toLowerCase()}
								</Badge>
							</div>
						))}
					</div>
				</TabsContent>
			</Tabs>
		</div>
	);
}
