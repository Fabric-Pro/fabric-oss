"use client";

/**
 * AuthorityApprovalCard
 *
 * Human-in-the-loop approval card for runtime authority requests.
 * Displays the requested providers, access levels, and TTL.
 * Provides approve/deny actions with optional instructions.
 *
 * This is the primary UI surface for Pipes-style authorization.
 * It ensures that approval is a distinct human action, not an
 * auto-approved agent operation.
 */

import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import {
	Card,
	CardContent,
	CardFooter,
	CardHeader,
	CardTitle,
} from "@ui/components/card";
import { Textarea } from "@ui/components/textarea";
import {
	CheckCircle2,
	Clock,
	Loader2,
	Lock,
	ShieldAlert,
	ShieldCheck,
	XCircle,
} from "lucide-react";
import { useState } from "react";

interface AuthorityGrant {
	id: string;
	providerKey: string;
	providerDisplayName?: string | null;
	accessLevel: "READ" | "WRITE";
	status: string;
	kind: string;
	toolScope?: string[];
}

interface AuthoritySession {
	id: string;
	runType: string;
	status: string;
	expiresAt: string;
	requestedAt?: string;
	approvalInstructions?: string | null;
	grants: AuthorityGrant[];
}

interface AuthorityApprovalCardProps {
	session: AuthoritySession;
	onApprove: (sessionId: string, instructions?: string) => Promise<void>;
	onDeny: (sessionId: string, reason?: string) => Promise<void>;
	onRevoke?: (sessionId: string) => Promise<void>;
}

const ACCESS_LEVEL_COLORS = {
	READ: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
	WRITE: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400",
};

const STATUS_CONFIG = {
	PENDING: {
		icon: Clock,
		color: "text-yellow-500",
		label: "Pending Approval",
	},
	ACTIVE: { icon: ShieldCheck, color: "text-green-500", label: "Active" },
	EXPIRED: { icon: Clock, color: "text-gray-400", label: "Expired" },
	REVOKED: { icon: XCircle, color: "text-red-500", label: "Revoked" },
	COMPLETED: {
		icon: CheckCircle2,
		color: "text-gray-500",
		label: "Completed",
	},
};

function formatTimeRemaining(expiresAt: string): string {
	const diff = new Date(expiresAt).getTime() - Date.now();
	if (diff <= 0) {
		return "Expired";
	}
	const minutes = Math.floor(diff / 60000);
	if (minutes < 60) {
		return `${minutes}m remaining`;
	}
	const hours = Math.floor(minutes / 60);
	return `${hours}h ${minutes % 60}m remaining`;
}

export function AuthorityApprovalCard({
	session,
	onApprove,
	onDeny,
	onRevoke,
}: AuthorityApprovalCardProps) {
	const [instructions, setInstructions] = useState("");
	const [isSubmitting, setIsSubmitting] = useState(false);
	const [action, setAction] = useState<"approve" | "deny" | "revoke" | null>(
		null,
	);

	const statusInfo =
		STATUS_CONFIG[session.status as keyof typeof STATUS_CONFIG] ??
		STATUS_CONFIG.PENDING;
	const StatusIcon = statusInfo.icon;
	const isPending = session.status === "PENDING";
	const isActive = session.status === "ACTIVE";

	const handleApprove = async () => {
		setIsSubmitting(true);
		setAction("approve");
		try {
			await onApprove(session.id, instructions || undefined);
		} finally {
			setIsSubmitting(false);
			setAction(null);
		}
	};

	const handleDeny = async () => {
		setIsSubmitting(true);
		setAction("deny");
		try {
			await onDeny(session.id, instructions || undefined);
		} finally {
			setIsSubmitting(false);
			setAction(null);
		}
	};

	const handleRevoke = async () => {
		if (!onRevoke) {
			return;
		}
		setIsSubmitting(true);
		setAction("revoke");
		try {
			await onRevoke(session.id);
		} finally {
			setIsSubmitting(false);
			setAction(null);
		}
	};

	return (
		<Card className="border-l-4 border-l-yellow-500 dark:border-l-yellow-600">
			<CardHeader className="pb-3">
				<div className="flex items-center justify-between">
					<div className="flex items-center gap-2">
						<ShieldAlert className="h-5 w-5 text-yellow-500" />
						<CardTitle className="text-base">
							Runtime Authority Request
						</CardTitle>
					</div>
					<div className="flex items-center gap-2">
						<StatusIcon className={`h-4 w-4 ${statusInfo.color}`} />
						<span className={`text-sm ${statusInfo.color}`}>
							{statusInfo.label}
						</span>
					</div>
				</div>
			</CardHeader>

			<CardContent className="space-y-4">
				{/* Provider grants */}
				<div className="space-y-2">
					<p className="text-sm text-muted-foreground">
						An agent is requesting temporary access to the following
						systems:
					</p>
					<div className="space-y-1.5">
						{session.grants.map((grant) => (
							<div
								key={grant.id}
								className="flex items-center justify-between rounded-md bg-muted/50 px-3 py-2"
							>
								<div className="flex items-center gap-2">
									<Lock className="h-3.5 w-3.5 text-muted-foreground" />
									<span className="text-sm font-medium">
										{grant.providerDisplayName ||
											grant.providerKey}
									</span>
									{grant.kind === "REQUEST" && (
										<Badge
											variant="outline"
											className="text-xs"
										>
											One-shot
										</Badge>
									)}
								</div>
								<Badge
									className={`text-xs ${ACCESS_LEVEL_COLORS[grant.accessLevel as keyof typeof ACCESS_LEVEL_COLORS] || ""}`}
								>
									{grant.accessLevel}
								</Badge>
							</div>
						))}
					</div>
				</div>

				{/* TTL info */}
				<div className="flex items-center gap-2 text-sm text-muted-foreground">
					<Clock className="h-3.5 w-3.5" />
					<span>{formatTimeRemaining(session.expiresAt)}</span>
					<span>·</span>
					<span className="capitalize">
						{session.runType.toLowerCase().replace("_", " ")}
					</span>
				</div>

				{/* Instructions input (for pending sessions) */}
				{isPending && (
					<Textarea
						placeholder="Optional instructions for the agent..."
						value={instructions}
						onChange={(e) => setInstructions(e.target.value)}
						rows={2}
						className="text-sm"
					/>
				)}

				{/* Existing instructions (for active sessions) */}
				{session.approvalInstructions && (
					<div className="rounded-md bg-green-50 p-2 text-sm text-green-800 dark:bg-green-900/20 dark:text-green-400">
						<span className="font-medium">Instructions: </span>
						{session.approvalInstructions}
					</div>
				)}
			</CardContent>

			<CardFooter className="gap-2">
				{isPending && (
					<>
						<Button
							onClick={handleApprove}
							disabled={isSubmitting}
							size="sm"
							className="gap-1.5"
						>
							{isSubmitting && action === "approve" ? (
								<Loader2 className="h-3.5 w-3.5 animate-spin" />
							) : (
								<CheckCircle2 className="h-3.5 w-3.5" />
							)}
							Approve
						</Button>
						<Button
							onClick={handleDeny}
							disabled={isSubmitting}
							variant="destructive"
							size="sm"
							className="gap-1.5"
						>
							{isSubmitting && action === "deny" ? (
								<Loader2 className="h-3.5 w-3.5 animate-spin" />
							) : (
								<XCircle className="h-3.5 w-3.5" />
							)}
							Deny
						</Button>
					</>
				)}
				{isActive && onRevoke && (
					<Button
						onClick={handleRevoke}
						disabled={isSubmitting}
						variant="destructive"
						size="sm"
						className="gap-1.5"
					>
						{isSubmitting && action === "revoke" ? (
							<Loader2 className="h-3.5 w-3.5 animate-spin" />
						) : (
							<XCircle className="h-3.5 w-3.5" />
						)}
						Revoke Access
					</Button>
				)}
			</CardFooter>
		</Card>
	);
}
