"use client";

/**
 * Admin acknowledge / resolve / comment dialog for both `ErrorRateIncident`
 * and `IntegrationIncident` rows.
 *
 * Behavior:
 *  - "Acknowledge" calls the matching `*acknowledge*` admin procedure. A
 *    `note` is optional. Idempotent in the DB (a second ack is a no-op).
 *  - "Resolve" calls `*resolve*Incident`. Optional `note`. Used when the
 *    auto-resolve path missed and an admin manually closes the incident.
 *  - "Comment" calls `*addComment` — message is required (validated). Always
 *    permitted, including after RESOLVED (post-mortem notes).
 *
 * On success we invalidate the active-incidents + per-stream query keys so
 * the dashboard table refreshes without a full reload. Toasts surface
 * failures.
 */

import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { Label } from "@ui/components/label";
import { Textarea } from "@ui/components/textarea";
import {
	CheckCircle2Icon,
	CircleCheckIcon,
	MessageSquareIcon,
} from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import { toast } from "sonner";

export type IncidentDialogTarget =
	| {
			kind: "errorRate";
			incidentId: string;
			alertName: string;
			status: "FIRING" | "ACKNOWLEDGED" | "RESOLVED";
	  }
	| {
			kind: "integration";
			incidentId: string;
			providerName: string;
			status: "FIRING" | "ACKNOWLEDGED" | "RESOLVED";
	  };

export type IncidentAction = "acknowledge" | "resolve" | "comment";

export const MONITORING_QUERY_KEYS = {
	activeIncidents: ["monitoring", "active-incidents"] as const,
	errorRateList: ["monitoring", "incidents", "error-rate", "list"] as const,
	integrationProviders: [
		"monitoring",
		"integration-health",
		"providers",
	] as const,
};

function invalidateMonitoringQueries(qc: ReturnType<typeof useQueryClient>) {
	qc.invalidateQueries({ queryKey: MONITORING_QUERY_KEYS.activeIncidents });
	qc.invalidateQueries({ queryKey: MONITORING_QUERY_KEYS.errorRateList });
	qc.invalidateQueries({
		queryKey: MONITORING_QUERY_KEYS.integrationProviders,
	});
}

export type IncidentAckResolveDialogProps = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	target: IncidentDialogTarget | null;
	defaultAction?: IncidentAction;
};

export function IncidentAckResolveDialog({
	open,
	onOpenChange,
	target,
	defaultAction = "acknowledge",
}: IncidentAckResolveDialogProps) {
	const qc = useQueryClient();
	const noteId = useId();
	const [action, setAction] = useState<IncidentAction>(defaultAction);
	const [note, setNote] = useState("");

	// Reset state every time the dialog opens for a new incident.
	useEffect(() => {
		if (open) {
			setAction(defaultAction);
			setNote("");
		}
	}, [open, defaultAction, target?.incidentId]);

	const title = useMemo(() => {
		if (!target) {
			return "";
		}
		return target.kind === "errorRate"
			? target.alertName
			: target.providerName;
	}, [target]);

	const acknowledgeMutation = useMutation({
		mutationFn: async (input: { id: string; note?: string }) => {
			if (!target) {
				throw new Error("No incident selected");
			}
			if (target.kind === "errorRate") {
				return orpcClient.incidents.errorRate.acknowledge(input);
			}
			return orpcClient.integrationHealth.acknowledgeIntegrationIncident(
				input,
			);
		},
		onSuccess: () => {
			toast.success("Alert claimed — other admins will see it's ack'd");
			invalidateMonitoringQueries(qc);
			onOpenChange(false);
		},
		onError: (error: unknown) => {
			toast.error("Failed to acknowledge alert", {
				description: errorMessage(error),
			});
		},
	});

	const resolveMutation = useMutation({
		mutationFn: async (input: { id: string; note?: string }) => {
			if (!target) {
				throw new Error("No incident selected");
			}
			if (target.kind === "errorRate") {
				return orpcClient.incidents.errorRate.resolve(input);
			}
			return orpcClient.integrationHealth.resolveIntegrationIncident(
				input,
			);
		},
		onSuccess: () => {
			toast.success("Alert hidden from every admin's open list");
			invalidateMonitoringQueries(qc);
			onOpenChange(false);
		},
		onError: (error: unknown) => {
			toast.error("Failed to hide alert", {
				description: errorMessage(error),
			});
		},
	});

	const commentMutation = useMutation({
		mutationFn: async (input: { id: string; message: string }) => {
			if (!target) {
				throw new Error("No incident selected");
			}
			if (target.kind === "errorRate") {
				return orpcClient.incidents.errorRate.addComment(input);
			}
			return orpcClient.integrationHealth.addComment(input);
		},
		onSuccess: () => {
			toast.success("Comment added");
			invalidateMonitoringQueries(qc);
			onOpenChange(false);
		},
		onError: (error: unknown) => {
			toast.error("Failed to add comment", {
				description: errorMessage(error),
			});
		},
	});

	const isPending =
		acknowledgeMutation.isPending ||
		resolveMutation.isPending ||
		commentMutation.isPending;

	function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!target || isPending) {
			return;
		}
		const trimmed = note.trim();
		if (action === "comment") {
			if (trimmed.length === 0) {
				toast.error("A comment is required");
				return;
			}
			commentMutation.mutate({
				id: target.incidentId,
				message: trimmed,
			});
			return;
		}
		const payload = {
			id: target.incidentId,
			...(trimmed.length > 0 ? { note: trimmed } : {}),
		};
		if (action === "acknowledge") {
			acknowledgeMutation.mutate(payload);
		} else {
			resolveMutation.mutate(payload);
		}
	}

	const canAcknowledge = target?.status === "FIRING";
	const canResolve =
		target?.status === "FIRING" || target?.status === "ACKNOWLEDGED";

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-lg">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2 font-serif text-xl font-normal">
						{target ? (
							<span
								className={`size-2.5 shrink-0 rounded-full ${
									target.status === "FIRING"
										? "bg-destructive motion-safe:animate-pulse"
										: target.status === "ACKNOWLEDGED"
											? "bg-highlight"
											: "bg-secondary"
								}`}
								aria-hidden
								data-testid={`dialog-status-dot-${target.status.toLowerCase()}`}
							/>
						) : null}
						{title || "Incident"}
					</DialogTitle>
					<DialogDescription className="space-y-2">
						<span className="block">
							<span className="font-medium text-foreground/85">
								Acknowledge
							</span>
							{" claims the alert so other admins know you're "}
							investigating. The underlying signal may still be
							firing.
						</span>
						<span className="block">
							<span className="font-medium text-foreground/85">
								Hide
							</span>
							{
								" removes the alert from every admin's open list. "
							}
							Use it once the work is finished — the entry moves
							to the timeline below where comments stay readable.
						</span>
						<span className="block">
							<span className="font-medium text-foreground/85">
								Comment
							</span>
							{
								" adds a note to the audit trail. Always allowed, "
							}
							including after the alert is hidden (post-mortem
							notes).
						</span>
					</DialogDescription>
				</DialogHeader>
				<form
					onSubmit={handleSubmit}
					className="space-y-4"
					aria-label="Incident action form"
				>
					<fieldset className="space-y-2">
						<legend className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
							Action
						</legend>
						<div
							className="flex flex-col gap-2 sm:flex-row"
							role="radiogroup"
							aria-label="Incident action"
						>
							<ActionRadio
								id="action-acknowledge"
								label="Acknowledge"
								checked={action === "acknowledge"}
								disabled={!canAcknowledge}
								icon={<CheckCircle2Icon className="size-4" />}
								onSelect={() => setAction("acknowledge")}
							/>
							<ActionRadio
								id="action-resolve"
								label="Hide"
								checked={action === "resolve"}
								disabled={!canResolve}
								icon={<CircleCheckIcon className="size-4" />}
								onSelect={() => setAction("resolve")}
							/>
							<ActionRadio
								id="action-comment"
								label="Comment"
								checked={action === "comment"}
								icon={<MessageSquareIcon className="size-4" />}
								onSelect={() => setAction("comment")}
							/>
						</div>
					</fieldset>

					<div className="space-y-1.5">
						<Label htmlFor={noteId}>
							{action === "comment"
								? "Comment (required)"
								: "Note (optional)"}
						</Label>
						<Textarea
							id={noteId}
							value={note}
							onChange={(event) => setNote(event.target.value)}
							placeholder={
								action === "comment"
									? "Add context for the audit log"
									: "Add a note to the audit log"
							}
							rows={4}
							maxLength={action === "comment" ? 4000 : 2000}
							required={action === "comment"}
							aria-required={action === "comment"}
						/>
						<p className="text-xs text-muted-foreground">
							{action === "comment"
								? `Up to 4000 characters. ${note.trim().length} / 4000`
								: `Up to 2000 characters. ${note.trim().length} / 2000`}
						</p>
					</div>

					<DialogFooter className="gap-2">
						<Button
							type="button"
							variant="ghost"
							onClick={() => onOpenChange(false)}
							disabled={isPending}
						>
							Cancel
						</Button>
						<Button
							type="submit"
							disabled={
								isPending ||
								(action === "acknowledge" && !canAcknowledge) ||
								(action === "resolve" && !canResolve) ||
								(action === "comment" &&
									note.trim().length === 0)
							}
						>
							{actionLabel(action, isPending)}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

type ActionRadioProps = {
	id: string;
	label: string;
	checked: boolean;
	icon: React.ReactNode;
	disabled?: boolean;
	onSelect: () => void;
};

function ActionRadio({
	id,
	label,
	checked,
	icon,
	disabled,
	onSelect,
}: ActionRadioProps) {
	return (
		<label
			htmlFor={id}
			className={`flex flex-1 cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors ${
				checked
					? "border-primary/60 bg-primary/10 text-foreground"
					: "border-border/60 bg-card text-muted-foreground hover:border-border"
			} ${disabled ? "cursor-not-allowed opacity-50" : ""}`}
		>
			<input
				id={id}
				type="radio"
				className="sr-only"
				checked={checked}
				disabled={disabled}
				onChange={() => {
					if (!disabled) {
						onSelect();
					}
				}}
			/>
			{icon}
			<span>{label}</span>
		</label>
	);
}

function actionLabel(action: IncidentAction, isPending: boolean) {
	if (isPending) {
		return "Submitting...";
	}
	switch (action) {
		case "acknowledge":
			return "Acknowledge";
		case "resolve":
			return "Hide for all admins";
		case "comment":
			return "Add comment";
	}
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}
