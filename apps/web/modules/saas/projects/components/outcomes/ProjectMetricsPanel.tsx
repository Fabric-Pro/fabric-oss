"use client";

/**
 * Success metrics manager (plan Slice 8): list, add, record an observation,
 * rotate / delete. The webhook secret is shown exactly once, in a dialog,
 * and dropped from state when the dialog closes — it is not retrievable
 * afterwards (the server keeps only a hash).
 */
import type { ProjectSuccessMetricDto } from "@repo/api/modules/projects/procedures/metrics";
import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import { cn } from "@ui/lib";
import {
	CopyIcon,
	Loader2Icon,
	PlusIcon,
	RefreshCwIcon,
	Trash2Icon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { type FormEvent, useId, useState } from "react";
import { toast } from "sonner";
import { InfoTip } from "../stories/InfoTip";

export interface ProjectMetricsPanelProps {
	projectId: string;
	organizationId?: string | null;
	/** PROJECT_UPDATE holders: add, record, delete. */
	canEdit: boolean;
	/** PROJECT_GOVERNANCE_MANAGE holders: rotate webhook secrets. */
	canRotate: boolean;
}

interface ShownSecret {
	metricId: string;
	metricName: string;
	value: string;
}

const selectClass =
	"h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

function formatValue(value: number | null): string {
	if (value === null) {
		return "—";
	}
	return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function errorMessage(error: unknown, fallback: string): string {
	return error instanceof Error && error.message ? error.message : fallback;
}

export function ProjectMetricsPanel({
	projectId,
	organizationId,
	canEdit,
	canRotate,
}: ProjectMetricsPanelProps) {
	const t = useTranslations("projects.outcomes.metrics");
	const tTips = useTranslations("tooltips.outcomes");
	const queryClient = useQueryClient();
	const id = useId();
	const scope = { projectId, organizationId: organizationId ?? null };

	const listOptions = orpc.projects.metrics.list.queryOptions({
		input: scope,
	});
	const { data, isLoading } = useQuery(listOptions);
	const metrics = data?.metrics ?? [];

	const [showAdd, setShowAdd] = useState(false);
	const [name, setName] = useState("");
	const [direction, setDirection] = useState<"UP" | "DOWN">("UP");
	const [target, setTarget] = useState("");
	const [sourceKind, setSourceKind] = useState<"MANUAL" | "WEBHOOK">(
		"MANUAL",
	);
	const [secret, setSecret] = useState<ShownSecret | null>(null);
	const [recordingFor, setRecordingFor] = useState<string | null>(null);
	const [recordValue, setRecordValue] = useState("");

	const invalidate = () =>
		queryClient.invalidateQueries({ queryKey: listOptions.queryKey });

	const createMutation = useMutation({
		mutationFn: () =>
			orpcClient.projects.metrics.create({
				...scope,
				name: name.trim(),
				direction,
				target: target.trim() === "" ? null : Number(target),
				sourceKind,
			}),
		onSuccess: (result) => {
			toast.success(t("created"));
			setName("");
			setTarget("");
			setDirection("UP");
			setSourceKind("MANUAL");
			setShowAdd(false);
			if (result.webhookSecret) {
				setSecret({
					metricId: result.metric.id,
					metricName: result.metric.name,
					value: result.webhookSecret.value,
				});
			}
			void invalidate();
		},
		onError: (error) => toast.error(errorMessage(error, t("error"))),
	});

	const recordMutation = useMutation({
		mutationFn: (input: { metricId: string; value: number }) =>
			orpcClient.projects.metrics.recordObservation({
				...scope,
				...input,
			}),
		onSuccess: () => {
			toast.success(t("recorded"));
			setRecordingFor(null);
			setRecordValue("");
			void invalidate();
		},
		onError: (error) => toast.error(errorMessage(error, t("error"))),
	});

	const rotateMutation = useMutation({
		mutationFn: (metric: ProjectSuccessMetricDto) =>
			orpcClient.projects.metrics.rotateWebhookSecret({
				...scope,
				metricId: metric.id,
			}),
		onSuccess: (result) => {
			toast.success(t("rotated"));
			setSecret({
				metricId: result.metric.id,
				metricName: result.metric.name,
				value: result.webhookSecret.value,
			});
			void invalidate();
		},
		onError: (error) => toast.error(errorMessage(error, t("error"))),
	});

	const deleteMutation = useMutation({
		mutationFn: (metricId: string) =>
			orpcClient.projects.metrics.delete({ ...scope, metricId }),
		onSuccess: () => {
			toast.success(t("deleted"));
			void invalidate();
		},
		onError: (error) => toast.error(errorMessage(error, t("error"))),
	});

	const submitCreate = (event: FormEvent) => {
		event.preventDefault();
		if (name.trim().length === 0) {
			return;
		}
		if (target.trim() !== "" && !Number.isFinite(Number(target))) {
			toast.error(t("invalidNumber"));
			return;
		}
		createMutation.mutate();
	};

	const submitRecord = (event: FormEvent, metricId: string) => {
		event.preventDefault();
		const value = Number(recordValue);
		if (recordValue.trim() === "" || !Number.isFinite(value)) {
			toast.error(t("invalidNumber"));
			return;
		}
		recordMutation.mutate({ metricId, value });
	};

	const webhookUrl = (metricId: string) =>
		`${typeof window !== "undefined" ? window.location.origin : ""}/api/metrics/webhook/${metricId}`;

	const copy = async (value: string, message: string) => {
		try {
			await navigator.clipboard.writeText(value);
			toast.success(message);
		} catch {
			toast.error(t("error"));
		}
	};

	return (
		<section
			aria-labelledby={`${id}-title`}
			className="rounded-2xl border border-border bg-muted/40 p-5 sm:p-6"
			data-onboarding-target="outcomes-metrics"
		>
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div>
					<span className="editorial-label">{t("label")}</span>
					<h3
						id={`${id}-title`}
						className="mt-2 font-serif text-2xl font-normal"
					>
						{t("title")}
					</h3>
					<p className="mt-1 text-sm text-muted-foreground">
						{t("subtitle")}
					</p>
				</div>
				{canEdit ? (
					<Button
						type="button"
						size="sm"
						variant={showAdd ? "outline" : "default"}
						onClick={() => setShowAdd((open) => !open)}
					>
						<PlusIcon className="mr-1.5 size-4" aria-hidden />
						{t("add")}
					</Button>
				) : null}
			</div>

			{showAdd && canEdit ? (
				<form
					onSubmit={submitCreate}
					className="mt-5 grid gap-3 rounded-xl border border-border bg-card p-4 sm:grid-cols-2"
					aria-label={t("addFormLabel")}
				>
					<div className="sm:col-span-2">
						<Label htmlFor={`${id}-name`}>{t("name")}</Label>
						<Input
							id={`${id}-name`}
							value={name}
							onChange={(e) => setName(e.target.value)}
							maxLength={120}
							required
							className="mt-1"
						/>
					</div>
					<div>
						<span className="inline-flex items-center gap-1.5">
							<Label htmlFor={`${id}-direction`}>
								{t("direction")}
							</Label>
							<InfoTip label={tTips("metricDirectionHelp")}>
								{tTips("metricDirection")}
							</InfoTip>
						</span>
						<select
							id={`${id}-direction`}
							value={direction}
							onChange={(e) =>
								setDirection(e.target.value as "UP" | "DOWN")
							}
							className={cn(selectClass, "mt-1")}
						>
							<option value="UP">{t("up")}</option>
							<option value="DOWN">{t("down")}</option>
						</select>
					</div>
					<div>
						<span className="inline-flex items-center gap-1.5">
							<Label htmlFor={`${id}-target`}>
								{t("target")}
							</Label>
							<InfoTip label={tTips("metricTargetHelp")}>
								{tTips("metricTarget")}
							</InfoTip>
						</span>
						<Input
							id={`${id}-target`}
							type="number"
							inputMode="decimal"
							step="any"
							value={target}
							onChange={(e) => setTarget(e.target.value)}
							className="mt-1"
						/>
					</div>
					<div>
						<span className="inline-flex items-center gap-1.5">
							<Label htmlFor={`${id}-source`}>
								{t("source")}
							</Label>
							<InfoTip label={tTips("metricSourceHelp")}>
								{tTips("metricSource")}
							</InfoTip>
						</span>
						<select
							id={`${id}-source`}
							value={sourceKind}
							onChange={(e) =>
								setSourceKind(
									e.target.value as "MANUAL" | "WEBHOOK",
								)
							}
							className={cn(selectClass, "mt-1")}
						>
							<option value="MANUAL">{t("manual")}</option>
							<option value="WEBHOOK">{t("webhook")}</option>
						</select>
						{sourceKind === "WEBHOOK" ? (
							<p className="mt-1 text-xs text-muted-foreground">
								{t("webhookHint")}
							</p>
						) : null}
					</div>
					<div className="flex items-end justify-end gap-2">
						<Button
							type="button"
							variant="ghost"
							size="sm"
							onClick={() => setShowAdd(false)}
						>
							{t("cancel")}
						</Button>
						<Button
							type="submit"
							size="sm"
							disabled={createMutation.isPending}
						>
							{createMutation.isPending ? (
								<Loader2Icon
									className="mr-1.5 size-4 motion-safe:animate-spin"
									aria-hidden
								/>
							) : null}
							{t("save")}
						</Button>
					</div>
				</form>
			) : null}

			{isLoading ? (
				<p className="mt-4 text-sm text-muted-foreground">
					{t("loading")}
				</p>
			) : metrics.length === 0 ? (
				<p className="mt-4 text-sm text-muted-foreground">
					{t("empty")}
				</p>
			) : (
				<ul className="mt-4 divide-y divide-border/60">
					{metrics.map((metric) => (
						<li key={metric.id} className="py-3">
							<div className="flex flex-wrap items-start justify-between gap-3">
								<div className="min-w-0">
									<div className="flex flex-wrap items-baseline gap-2">
										<span className="text-sm font-medium">
											{metric.name}
										</span>
										<span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
											{metric.sourceKind === "WEBHOOK"
												? t("webhook")
												: t("manual")}
										</span>
									</div>
									<div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
										<span>
											{t("lastValue")}:{" "}
											<span className="tabular-nums text-foreground">
												{formatValue(metric.lastValue)}
											</span>
										</span>
										<span>
											{t("previousValue")}:{" "}
											{formatValue(metric.previousValue)}
										</span>
										<span>
											{t("target")}:{" "}
											{formatValue(metric.target)}
										</span>
										<span>
											{metric.direction === "UP"
												? t("up")
												: t("down")}
										</span>
									</div>
									{metric.sourceKind === "WEBHOOK" ? (
										<p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">
											{webhookUrl(metric.id)}
										</p>
									) : null}
								</div>
								{canEdit ? (
									<div className="flex flex-wrap items-center gap-1.5">
										<Button
											type="button"
											size="sm"
											variant="outline"
											onClick={() => {
												setRecordingFor(
													recordingFor === metric.id
														? null
														: metric.id,
												);
												setRecordValue("");
											}}
										>
											{t("recordValue")}
										</Button>
										{metric.sourceKind === "WEBHOOK" &&
										canRotate ? (
											<Button
												type="button"
												size="sm"
												variant="ghost"
												disabled={
													rotateMutation.isPending
												}
												onClick={() =>
													rotateMutation.mutate(
														metric,
													)
												}
												aria-label={`${t("rotateSecret")}: ${metric.name}`}
											>
												<RefreshCwIcon
													className="mr-1.5 size-4"
													aria-hidden
												/>
												{t("rotateSecret")}
											</Button>
										) : null}
										<Button
											type="button"
											size="sm"
											variant="ghost"
											className="text-destructive"
											disabled={deleteMutation.isPending}
											onClick={() =>
												deleteMutation.mutate(metric.id)
											}
											aria-label={`${t("delete")}: ${metric.name}`}
										>
											<Trash2Icon
												className="size-4"
												aria-hidden
											/>
										</Button>
									</div>
								) : null}
							</div>
							{recordingFor === metric.id && canEdit ? (
								<form
									onSubmit={(event) =>
										submitRecord(event, metric.id)
									}
									className="mt-3 flex flex-wrap items-end gap-2"
								>
									<div>
										<Label
											htmlFor={`${id}-value-${metric.id}`}
										>
											{t("newValue")}
										</Label>
										<Input
											id={`${id}-value-${metric.id}`}
											type="number"
											inputMode="decimal"
											step="any"
											value={recordValue}
											onChange={(e) =>
												setRecordValue(e.target.value)
											}
											className="mt-1 w-40"
											required
										/>
									</div>
									<Button
										type="submit"
										size="sm"
										disabled={recordMutation.isPending}
									>
										{t("record")}
									</Button>
								</form>
							) : null}
						</li>
					))}
				</ul>
			)}

			<Dialog
				open={secret !== null}
				onOpenChange={(open) => (!open ? setSecret(null) : null)}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>{t("secretTitle")}</DialogTitle>
						<DialogDescription>
							{t("secretShownOnce")}
						</DialogDescription>
					</DialogHeader>
					{secret ? (
						<div className="grid gap-3 text-sm">
							<p className="text-muted-foreground">
								{secret.metricName}
							</p>
							<div>
								<Label>{t("secretValue")}</Label>
								<div className="mt-1 flex items-center gap-2">
									<code
										className="flex-1 break-all rounded-md border border-border bg-muted px-2 py-1.5 font-mono text-xs"
										data-testid="metric-webhook-secret"
									>
										{secret.value}
									</code>
									<Button
										type="button"
										size="sm"
										variant="outline"
										onClick={() =>
											copy(
												secret.value,
												t("secretCopied"),
											)
										}
										aria-label={t("secretCopy")}
									>
										<CopyIcon
											className="size-4"
											aria-hidden
										/>
									</Button>
								</div>
							</div>
							<div>
								<Label>{t("secretEndpoint")}</Label>
								<code className="mt-1 block break-all rounded-md border border-border bg-muted px-2 py-1.5 font-mono text-xs">
									{webhookUrl(secret.metricId)}
								</code>
								<p className="mt-2 text-xs text-muted-foreground">
									{t("secretUsage")}
								</p>
								<pre className="mt-1 overflow-x-auto rounded-md border border-border bg-muted p-2 font-mono text-[11px] leading-5">
									{`curl -X POST ${webhookUrl(secret.metricId)} \\
  -H "Authorization: Bearer <secret>" \\
  -H "Content-Type: application/json" \\
  -d '{"value": 42, "observedAt": "2026-09-14T00:00:00Z"}'`}
								</pre>
							</div>
						</div>
					) : null}
					<DialogFooter>
						<Button type="button" onClick={() => setSecret(null)}>
							{t("secretDone")}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</section>
	);
}
