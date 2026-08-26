import { Badge } from "@ui/components/badge";
import {
	BanIcon,
	CheckCircle2Icon,
	ClockIcon,
	Loader2Icon,
	XCircleIcon,
} from "lucide-react";

/**
 * Status badge for a report execution. Shared between the Execution History
 * table and the readiness rail's "Latest run" glance so both render the same
 * vocabulary and colors.
 */
export function ExecutionStatusBadge({ status }: { status: string }) {
	switch (status) {
		case "COMPLETED":
			return (
				<Badge variant="success" className="gap-1">
					<CheckCircle2Icon className="h-3 w-3" />
					Completed
				</Badge>
			);
		case "RUNNING":
			return (
				<Badge variant="info" className="gap-1">
					<Loader2Icon className="h-3 w-3 animate-spin" />
					Running
				</Badge>
			);
		case "FAILED":
			return (
				<Badge variant="destructive" className="gap-1">
					<XCircleIcon className="h-3 w-3" />
					Failed
				</Badge>
			);
		case "PENDING":
			return (
				<Badge variant="secondary" className="gap-1">
					<ClockIcon className="h-3 w-3" />
					Pending
				</Badge>
			);
		case "CANCELLED":
			return (
				<Badge
					variant="outline"
					className="gap-1 text-muted-foreground"
				>
					<BanIcon className="h-3 w-3" />
					Cancelled
				</Badge>
			);
		default:
			return <Badge variant="outline">{status}</Badge>;
	}
}
