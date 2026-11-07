"use client";

import type {
	deliverySourceList,
	deliverySourceWatch,
} from "@repo/api/modules/projects/lib/delivery-source-contracts";
import { isDeliverySourceCaptureWindow } from "@repo/connectors/delivery-source-capture-limits";
import {
	hasPermission,
	Permissions,
	resolveOrgPermissions,
} from "@repo/permissions";
import { useSession } from "@saas/auth/hooks/use-session";
import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { orpcClient } from "@shared/lib/orpc-client";
import {
	useInfiniteQuery,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
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
import { Checkbox } from "@ui/components/checkbox";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@ui/components/sheet";
import { Skeleton } from "@ui/components/skeleton";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { z } from "zod";
import { ProjectSignalReview } from "./ProjectSignalReview";

const api = orpcClient.projects.deliverySources;
// One initial read plus five automatic checks, then require an explicit recheck.
const STATUS_POLL_DELAYS = [2_000, 5_000, 10_000, 20_000, 30_000] as const;
type Watch = z.infer<typeof deliverySourceWatch>;
type SourceList = z.infer<typeof deliverySourceList>;
type Scope = readonly [
	"private-delivery-sources",
	string,
	string | null | undefined,
	string,
];
type Intent =
	| { operation: "state"; input: Parameters<typeof api.state>[0] }
	| { operation: "capture"; input: Parameters<typeof api.capture>[0] }
	| { operation: "cancel"; input: Parameters<typeof api.cancel>[0] };

function denied(error: unknown): boolean {
	if (!error || typeof error !== "object") {
		return false;
	}
	const data =
		"data" in error && error.data && typeof error.data === "object"
			? error.data
			: {};
	return (
		[
			"UNAUTHORIZED",
			"FORBIDDEN",
			"NOT_FOUND",
			"INSUFFICIENT_SCOPE",
			"INSUFFICIENT_PERMISSION",
			"ORGANIZATION_DELETED",
		].some(
			(code) =>
				("code" in error && error.code === code) ||
				("code" in data && data.code === code) ||
				("errorCode" in data && data.errorCode === code),
		) ||
		("status" in error && [401, 403, 404].includes(error.status as number))
	);
}

/** Accept channel identifiers or fixed Slack channel URLs, never navigate to user input. */
function slackChannel(value: string): string | undefined {
	const input = value.trim();
	if (/^[CG][A-Z0-9]{8,199}$/.test(input)) {
		return input;
	}
	try {
		const url = new URL(input);
		if (
			url.protocol !== "https:" ||
			url.username ||
			url.password ||
			url.port ||
			!/^[a-z0-9-]+\.slack\.com$/i.test(url.hostname)
		) {
			return;
		}
		const match =
			url.hostname === "app.slack.com"
				? /^\/client\/T[A-Z0-9]+\/([CG][A-Z0-9]{8,199})\/?$/.exec(
						url.pathname,
					)
				: /^\/archives\/([CG][A-Z0-9]{8,199})\/?$/.exec(url.pathname);
		return match?.[1];
	} catch {
		return;
	}
}

function PrivateSourceError({
	retry,
	uncertain = false,
}: {
	retry?: () => void;
	uncertain?: boolean;
}) {
	const t = useTranslations("deliveryPrivateSources");
	return (
		<div role="alert" className="space-y-2 text-sm">
			<p>{t(uncertain ? "uncertain" : "error")}</p>
			{retry && (
				<Button variant="outline" size="sm" onClick={retry}>
					{t(uncertain ? "retryAction" : "retry")}
				</Button>
			)}
		</div>
	);
}

function PrivateSourceForm({
	projectId,
	connections,
	onSaved,
	onDenied,
}: {
	projectId: string;
	connections: SourceList["connections"];
	onSaved: () => void;
	onDenied: () => void;
}) {
	const t = useTranslations("deliveryPrivateSources");
	const id = useId();
	const [integrationId, setIntegration] = useState("");
	const [channel, setChannel] = useState("");
	const [retentionDays, setRetention] = useState<7 | 30>(7);
	const [consent, setConsent] = useState(false);
	const [proof, setProof] = useState<{
		integrationId: string;
		channelId: string;
		label: string;
	}>();
	const [attempt, setAttempt] =
		useState<Parameters<typeof api.configure>[0]>();
	const channelId = slackChannel(channel);
	const inspection = useMutation({
		mutationFn: (input: Parameters<typeof api.inspect>[0]) =>
			api.inspect(input),
		retry: false,
		onSuccess: (result, input) => {
			setProof({ ...input, label: result.label });
			setConsent(false);
		},
		onError: (error) => {
			if (denied(error)) {
				onDenied();
			}
		},
	});
	const configure = useMutation({
		mutationFn: (input: Parameters<typeof api.configure>[0]) =>
			api.configure(input),
		retry: false,
		onSuccess: () => {
			setAttempt(undefined);
			setProof(undefined);
			setConsent(false);
			setChannel("");
			onSaved();
		},
		onError: (error) => {
			if (denied(error)) {
				onDenied();
			}
		},
	});
	const currentProof =
		proof &&
		proof.integrationId === integrationId &&
		proof.channelId === channelId
			? proof
			: undefined;
	const clearProof = () => {
		setProof(undefined);
		setConsent(false);
		setAttempt(undefined);
		inspection.reset();
		configure.reset();
	};
	const busy = inspection.isPending || configure.isPending;
	return (
		<form
			className="space-y-4"
			onSubmit={(event) => {
				event.preventDefault();
				if (channelId && integrationId) {
					inspection.mutate({ projectId, integrationId, channelId });
				}
			}}
		>
			<div className="grid gap-4 sm:grid-cols-2">
				<div className="space-y-2">
					<Label htmlFor={`${id}-connection`}>
						{t("connection")}
					</Label>
					<Select
						value={integrationId}
						onValueChange={(value) => {
							setIntegration(value);
							clearProof();
						}}
						disabled={busy}
					>
						<SelectTrigger id={`${id}-connection`}>
							<SelectValue placeholder={t("chooseConnection")} />
						</SelectTrigger>
						<SelectContent>
							{connections
								.filter((c) => c.supportsPrivateCapture)
								.map((c) => (
									<SelectItem key={c.id} value={c.id}>
										{c.name}
									</SelectItem>
								))}
						</SelectContent>
					</Select>
				</div>
				<div className="space-y-2">
					<Label htmlFor={`${id}-channel`}>{t("channel")}</Label>
					<Input
						id={`${id}-channel`}
						value={channel}
						maxLength={2048}
						disabled={busy}
						aria-describedby={`${id}-channel-help`}
						onChange={(event) => {
							setChannel(event.target.value);
							clearProof();
						}}
					/>
					<p
						id={`${id}-channel-help`}
						className="text-xs text-muted-foreground"
					>
						{t("channelHelp")}
					</p>
				</div>
			</div>
			<Button
				type="submit"
				variant="outline"
				disabled={!integrationId || !channelId || busy}
			>
				{t(inspection.isPending ? "checking" : "inspect")}
			</Button>
			{channel.trim() && !channelId && (
				<p className="text-sm text-muted-foreground">
					{t("invalidChannel")}
				</p>
			)}
			{inspection.isError && (
				<PrivateSourceError
					retry={() => {
						if (channelId) {
							inspection.mutate({
								projectId,
								integrationId,
								channelId,
							});
						}
					}}
				/>
			)}
			{currentProof && (
				<div className="space-y-4 border-t border-border pt-4">
					<h4 className="font-medium text-sm">
						{t("verified", { source: currentProof.label })}
					</h4>
					<p className="max-w-prose text-sm text-muted-foreground">
						{t("consentScope")}
					</p>
					<div className="max-w-xs space-y-2">
						<Label htmlFor={`${id}-retention`}>
							{t("retention")}
						</Label>
						<Select
							value={String(retentionDays)}
							onValueChange={(value) => {
								setRetention(value === "30" ? 30 : 7);
								setAttempt(undefined);
								configure.reset();
							}}
							disabled={configure.isPending}
						>
							<SelectTrigger id={`${id}-retention`}>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="7">
									{t("days", { days: 7 })}
								</SelectItem>
								<SelectItem value="30">
									{t("days", { days: 30 })}
								</SelectItem>
							</SelectContent>
						</Select>
					</div>
					<div className="flex items-start gap-3">
						<Checkbox
							id={`${id}-consent`}
							checked={consent}
							disabled={configure.isPending}
							onCheckedChange={(value) =>
								setConsent(value === true)
							}
						/>
						<Label htmlFor={`${id}-consent`} className="leading-5">
							{t("consent")}
						</Label>
					</div>
					<Button
						type="button"
						disabled={!consent || busy || !!attempt}
						onClick={() => {
							const input = {
								projectId,
								integrationId,
								channelId: currentProof.channelId,
								retentionDays,
								requestId: crypto.randomUUID(),
							};
							setAttempt(input);
							configure.mutate(input);
						}}
					>
						{t(configure.isPending ? "connecting" : "connect")}
					</Button>
					{configure.isError && (
						<PrivateSourceError
							uncertain
							retry={() => {
								if (attempt) {
									configure.mutate(attempt);
								}
							}}
						/>
					)}
				</div>
			)}
		</form>
	);
}

function PrivateEvidence({
	projectId,
	watchId,
	observationId,
	scope,
	onClose,
	onDenied,
}: {
	projectId: string;
	watchId: string;
	observationId: string;
	scope: Scope;
	onClose: () => void;
	onDenied: () => void;
}) {
	const t = useTranslations("deliveryPrivateSources");
	const evidence = useQuery({
		queryKey: [...scope, watchId, "evidence", observationId],
		queryFn: ({ signal }) =>
			api.evidence({ projectId, watchId, observationId }, { signal }),
		gcTime: 0,
		staleTime: 0,
		retry: false,
	});
	useEffect(() => {
		if (evidence.isError && denied(evidence.error)) {
			onDenied();
		}
	}, [evidence.isError, evidence.error, onDenied]);
	return (
		<Sheet
			open
			onOpenChange={(open) => {
				if (!open) {
					onClose();
				}
			}}
		>
			<SheetContent className="flex w-full flex-col gap-5 overflow-y-auto sm:max-w-lg">
				<SheetHeader className="pr-6 text-left">
					<SheetTitle>{t("message")}</SheetTitle>
					<SheetDescription>{t("evidenceScope")}</SheetDescription>
				</SheetHeader>
				{evidence.isPending || evidence.isFetching ? (
					<Skeleton
						className="h-32 w-full"
						aria-label={t("loadingEvidence")}
					/>
				) : evidence.isError || !evidence.data ? (
					<PrivateSourceError retry={() => void evidence.refetch()} />
				) : (
					<>
						<p className="whitespace-pre-wrap break-words text-sm">
							{evidence.data.text}
						</p>
						<p className="text-xs text-muted-foreground">
							{t("checked", {
								date: new Date(
									evidence.data.checkedAt,
								).toLocaleString(),
							})}
						</p>
					</>
				)}
			</SheetContent>
		</Sheet>
	);
}

function PrivateWatch({
	watch,
	projectId,
	scope,
	onDenied,
}: {
	watch: Watch;
	projectId: string;
	scope: Scope;
	onDenied: () => void;
}) {
	const t = useTranslations("deliveryPrivateSources");
	const client = useQueryClient();
	const [expanded, setExpanded] = useState(false);
	const [selected, setSelected] = useState<string>();
	const [disconnect, setDisconnect] = useState(false);
	const historyId = useId();
	const [historyStart, setHistoryStart] = useState("");
	const [historyEnd, setHistoryEnd] = useState("");
	const startTime = new Date(historyStart).getTime();
	const endTime = new Date(historyEnd).getTime();
	const historyWindow =
		Number.isFinite(startTime) && Number.isFinite(endTime)
			? {
					start: new Date(startTime).toISOString(),
					end: new Date(endTime).toISOString(),
				}
			: undefined;
	const validHistory =
		historyWindow !== undefined &&
		isDeliverySourceCaptureWindow(historyWindow, Date.now());
	const [intent, setIntent] = useState<Intent>();
	const pollingIdentity = JSON.stringify([
		scope,
		watch.id,
		watch.version,
		watch.lastRequestId,
	]);
	const [statusAttempts, setStatusAttempts] = useState(0);
	const polling = useRef({
		identity: pollingIdentity,
		requestId: watch.lastRequestId,
		attempts: 0,
	});
	const statusKey = [
		...scope,
		watch.id,
		watch.version,
		watch.lastRequestId,
		"status",
	];
	const status = useQuery({
		queryKey: statusKey,
		queryFn: async ({ signal }) => {
			if (polling.current.identity !== pollingIdentity) {
				polling.current = {
					identity: pollingIdentity,
					requestId: watch.lastRequestId,
					attempts: 0,
				};
			}
			polling.current.attempts++;
			setStatusAttempts(polling.current.attempts);
			const result = await api.status(
				{ projectId, watchId: watch.id },
				{ signal },
			);
			if (
				polling.current.identity === pollingIdentity &&
				polling.current.requestId !== result.requestId
			) {
				polling.current.requestId = result.requestId;
				polling.current.attempts = 1;
				setStatusAttempts(1);
			}
			return result;
		},
		enabled: expanded && watch.state !== "DISCONNECTED",
		gcTime: 0,
		staleTime: 0,
		retry: false,
		refetchOnWindowFocus: false,
		refetchOnReconnect: false,
		refetchInterval: (query) => {
			if (
				query.state.error ||
				query.state.data?.canStartNewCapture === true ||
				!["RUNNING", "OUTCOME_UNKNOWN"].includes(
					query.state.data?.state ?? "",
				)
			) {
				return false;
			}
			return STATUS_POLL_DELAYS[polling.current.attempts - 1] ?? false;
		},
	});
	const recheckStatus = () => {
		polling.current.attempts = 0;
		setStatusAttempts(0);
		void status.refetch();
	};

	const refreshedTerminal = useRef<string | undefined>(undefined);
	useEffect(() => {
		const run = status.data;
		if (
			!run?.requestId ||
			!["COMPLETED", "FAILED", "CANCELLED"].includes(run.state)
		)
			return;
		const identity = JSON.stringify([
			scope,
			watch.id,
			run.requestId,
			run.state,
		]);
		if (refreshedTerminal.current === identity) return;
		refreshedTerminal.current = identity;
		void client.invalidateQueries({
			queryKey: [...scope, "list"],
			exact: true,
		});
		void client.invalidateQueries({
			queryKey: [...scope, watch.id, "observations"],
		});
	}, [client, scope, watch.id, status.data?.requestId, status.data?.state]);

	const observations = useInfiniteQuery({
		queryKey: [...scope, watch.id, "observations"],
		initialPageParam: undefined as string | undefined,
		queryFn: ({ pageParam, signal }) =>
			api.observations(
				{ projectId, watchId: watch.id, limit: 20, cursor: pageParam },
				{ signal },
			),
		getNextPageParam: (page) => page.nextCursor ?? undefined,
		enabled: expanded && watch.state !== "DISCONNECTED",
		gcTime: 0,
		staleTime: 0,
		retry: false,
	});
	const mutation = useMutation({
		mutationFn: async (action: Intent) => {
			if (action.operation === "capture") {
				// A prior recovery grant never authorizes another request after this new attempt loses its acknowledgement.
				polling.current.attempts = 0;
				setStatusAttempts(0);
				client.setQueryData<Awaited<ReturnType<typeof api.status>>>(
					statusKey,
					(current) =>
						current
							? {
									...current,
									state: "OUTCOME_UNKNOWN",
									requestId: action.input.requestId,
									canStartNewCapture: false,
								}
							: current,
				);
			}
			if (action.operation === "state") {
				await api.state(action.input);
			} else {
				const run =
					action.operation === "capture"
						? await api.capture(action.input)
						: await api.cancel(action.input);
				polling.current.attempts = 0;
				client.setQueryData(statusKey, run);
				return run;
			}
		},
		retry: false,
		onSuccess: (result, action) => {
			if (
				action.operation !== "cancel" ||
				result?.state !== "OUTCOME_UNKNOWN" ||
				result.canStartNewCapture === true
			) {
				setIntent(undefined);
			}
			if (
				action.operation === "state" &&
				action.input.action === "DISCONNECT"
			) {
				setSelected(undefined);
				client.removeQueries({
					queryKey: [...scope, watch.id, "evidence"],
				});
			}
			void client.invalidateQueries({ queryKey: scope });
		},
		onError: (error) => {
			if (denied(error)) {
				onDenied();
			}
		},
	});
	useEffect(() => {
		if (
			(status.isError && denied(status.error)) ||
			(observations.isError && denied(observations.error))
		) {
			onDenied();
		}
	}, [
		status.isError,
		status.error,
		observations.isError,
		observations.error,
		onDenied,
	]);
	useEffect(() => {
		if (status.isError || observations.isError) {
			setSelected(undefined);
			client.removeQueries({
				queryKey: [...scope, watch.id, "evidence"],
			});
		}
	}, [status.isError, observations.isError, client, scope, watch.id]);
	const send = (action: Intent) => {
		setIntent(action);
		mutation.mutate(action);
	};
	const lastCaptureInput = watch.lastCaptureInput;
	const hasNativeStatus = ["RUNNING", "OUTCOME_UNKNOWN"].includes(
		status.data?.state ?? "",
	);
	const canStartNewCapture =
		status.data?.state === "OUTCOME_UNKNOWN" &&
		status.data.canStartNewCapture === true;
	const inFlight = hasNativeStatus && !canStartNewCapture;
	useEffect(() => {
		if (
			!mutation.isPending &&
			intent &&
			intent.operation !== "state" &&
			(intent.operation === "cancel" ||
				status.data?.requestId === intent.input.requestId) &&
			(canStartNewCapture ||
				["COMPLETED", "FAILED", "CANCELLED"].includes(
					status.data?.state ?? "",
				))
		) {
			setIntent(undefined);
		}
	}, [
		canStartNewCapture,
		status.data?.state,
		status.data?.requestId,
		mutation.isPending,
		intent,
	]);
	const busy = mutation.isPending || !!intent;
	const changeState = (action: "PAUSE" | "RESUME" | "DISCONNECT") =>
		send({
			operation: "state",
			input: {
				projectId,
				watchId: watch.id,
				expectedVersion: watch.version,
				action,
				requestId: crypto.randomUUID(),
			},
		});
	const items = observations.data?.pages.flatMap((page) => page.items) ?? [];
	return (
		<details
			className="border-t border-border py-4"
			open={expanded}
			onToggle={(event) => setExpanded(event.currentTarget.open)}
		>
			<summary className="cursor-pointer text-sm">
				<span className="font-medium">{watch.label}</span>
				<span className="ml-3 text-muted-foreground">
					{t(`watchStates.${watch.state}`)}
				</span>
			</summary>
			<div className="mt-4 space-y-4">
				<p className="text-xs text-muted-foreground">
					{t("watchScope", { days: watch.retentionDays })}
				</p>
				{watch.captureWindow && (
					<p className="text-xs text-muted-foreground">
						{t(
							watch.captureWindow.complete
								? "windowComplete"
								: "windowPartial",
							{
								start: new Date(
									watch.captureWindow.start,
								).toLocaleString(),
								end: new Date(
									watch.captureWindow.end,
								).toLocaleString(),
							},
						)}
					</p>
				)}

				{watch.state !== "DISCONNECTED" && (
					<>
						<div className="flex flex-wrap gap-2">
							{watch.state === "ACTIVE" && (
								<>
									<Button
										size="sm"
										disabled={
											busy ||
											inFlight ||
											status.isPending ||
											status.isFetching ||
											status.isError
										}
										onClick={() =>
											send({
												operation: "capture",
												input: {
													projectId,
													watchId: watch.id,
													expectedVersion:
														watch.version,
													requestId:
														crypto.randomUUID(),
													mode: "RECENT",
												},
											})
										}
									>
										{t("capture")}
									</Button>
									{(watch.hasMore ||
										status.data?.hasMore) && (
										<Button
											variant="outline"
											size="sm"
											disabled={
												busy ||
												inFlight ||
												status.isPending ||
												status.isFetching ||
												status.isError
											}
											onClick={() =>
												send({
													operation: "capture",
													input: {
														projectId,
														watchId: watch.id,
														expectedVersion:
															watch.version,
														requestId:
															crypto.randomUUID(),
														mode: "CONTINUE",
													},
												})
											}
										>
											{t("continue")}
										</Button>
									)}
								</>
							)}
							<Button
								variant="outline"
								size="sm"
								disabled={busy}
								onClick={() =>
									changeState(
										watch.state === "ACTIVE"
											? "PAUSE"
											: "RESUME",
									)
								}
							>
								{t(
									watch.state === "ACTIVE"
										? "pause"
										: "resume",
								)}
							</Button>
							<Button
								variant="ghost"
								size="sm"
								disabled={busy}
								onClick={() => setDisconnect(true)}
							>
								{t("disconnect")}
							</Button>
						</div>
						{watch.state === "ACTIVE" && (
							<details className="text-sm">
								<summary className="cursor-pointer">
									{t("historyTitle")}
								</summary>
								<div className="mt-3 space-y-3">
									<p
										className="text-xs text-muted-foreground"
										id={`${historyId}-help`}
									>
										{t("historyHelp")}
									</p>
									<div className="grid gap-3 sm:grid-cols-2">
										<div className="space-y-1">
											<Label
												htmlFor={`${historyId}-start`}
											>
												{t("historyFrom")}
											</Label>
											<Input
												id={`${historyId}-start`}
												type="datetime-local"
												aria-describedby={`${historyId}-help`}
												value={historyStart}
												onChange={(e) =>
													setHistoryStart(
														e.target.value,
													)
												}
											/>
										</div>
										<div className="space-y-1">
											<Label htmlFor={`${historyId}-end`}>
												{t("historyTo")}
											</Label>
											<Input
												id={`${historyId}-end`}
												type="datetime-local"
												aria-describedby={`${historyId}-help`}
												value={historyEnd}
												onChange={(e) =>
													setHistoryEnd(
														e.target.value,
													)
												}
											/>
										</div>
									</div>
									{historyStart &&
										historyEnd &&
										!validHistory && (
											<p
												role="alert"
												className="text-sm text-destructive"
											>
												{t("historyInvalid")}
											</p>
										)}
									<Button
										variant="outline"
										size="sm"
										disabled={
											!validHistory ||
											busy ||
											inFlight ||
											status.isPending ||
											status.isFetching ||
											status.isError
										}
										onClick={() => {
											if (validHistory && historyWindow) {
												send({
													operation: "capture",
													input: {
														projectId,
														watchId: watch.id,
														expectedVersion:
															watch.version,
														requestId:
															crypto.randomUUID(),
														mode: "BACKFILL",
														window: historyWindow,
													},
												});
											}
										}}
									>
										{t("historyCapture")}
									</Button>
								</div>
							</details>
						)}
						{status.isPending ? (
							<p
								aria-live="polite"
								className="text-sm text-muted-foreground"
							>
								{t("loadingStatus")}
							</p>
						) : status.isError ? (
							<PrivateSourceError retry={recheckStatus} />
						) : (
							status.data &&
							status.data.state !== "NOT_STARTED" && (
								<div
									aria-live="polite"
									className="space-y-2 text-sm"
								>
									<p>
										{t(`runStates.${status.data.state}`)}
										{status.data.captured !== null &&
											` · ${t("captured", { count: status.data.captured })}`}
									</p>
									{status.data.coverage === "PARTIAL" && (
										<p className="text-muted-foreground">
											{t("partial")}
										</p>
									)}
									{inFlight && (
										<p className="text-muted-foreground">
											{t(
												status.data.state === "RUNNING"
													? "canLeave"
													: "unknownCanLeave",
											)}
										</p>
									)}
									{status.data.state ===
										"OUTCOME_UNKNOWN" && (
										<p className="max-w-prose text-muted-foreground">
											{t(
												canStartNewCapture
													? "unknownRecoveredGuidance"
													: "unknownGuidance",
											)}
										</p>
									)}
									{inFlight &&
										statusAttempts >
											STATUS_POLL_DELAYS.length && (
											<p className="text-muted-foreground">
												{t("pollingPaused")}
											</p>
										)}
									{hasNativeStatus && (
										<Button
											variant="outline"
											size="sm"
											disabled={status.isFetching}
											onClick={recheckStatus}
										>
											{t("recheckStatus")}
										</Button>
									)}
									{status.data.state === "OUTCOME_UNKNOWN" &&
										!canStartNewCapture &&
										lastCaptureInput &&
										!intent && (
											<Button
												variant="outline"
												size="sm"
												disabled={busy}
												onClick={() =>
													send({
														operation: "capture",
														input: {
															projectId,
															watchId: watch.id,
															...lastCaptureInput,
														},
													})
												}
											>
												{t("retryLast")}
											</Button>
										)}
									{inFlight && (
										<Button
											variant="outline"
											size="sm"
											disabled={busy}
											onClick={() =>
												send({
													operation: "cancel",
													input: {
														projectId,
														watchId: watch.id,
														requestId:
															crypto.randomUUID(),
													},
												})
											}
										>
											{t("cancelCapture")}
										</Button>
									)}
								</div>
							)
						)}
						{(mutation.isError ||
							(intent?.operation === "cancel" &&
								mutation.data?.state ===
									"OUTCOME_UNKNOWN")) && (
							<PrivateSourceError
								uncertain
								retry={() => {
									if (intent) {
										mutation.mutate(intent);
									}
								}}
							/>
						)}
						<div className="space-y-3">
							<div className="flex flex-wrap items-center justify-between gap-3">
								<h4 className="font-medium text-sm">
									{t("observations")}
								</h4>
								<ProjectSignalReview
									projectId={projectId}
									scope={scope}
									choices={items
										.filter(
											(item) =>
												item.change === "UPSERT" &&
												!item.hasConflict,
										)
										.map((item) => ({
											id: item.id,
											capturedAt: item.capturedAt,
										}))}
								/>
							</div>
							{observations.isPending ? (
								<Skeleton
									className="h-16 w-full"
									aria-label={t("loadingMessages")}
								/>
							) : observations.isError ? (
								<PrivateSourceError
									retry={() => void observations.refetch()}
								/>
							) : !items.length ? (
								<p className="text-sm text-muted-foreground">
									{t("noMessages")}
								</p>
							) : (
								<ul className="divide-y divide-border">
									{items.map((item) => (
										<li key={item.id}>
											<button
												type="button"
												onClick={() =>
													setSelected(item.id)
												}
												className="flex w-full flex-wrap items-center justify-between gap-2 rounded-md py-3 text-left text-sm hover:bg-muted/50 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
											>
												<span>
													{t(
														item.change === "DELETE"
															? "removedMessage"
															: "message",
													)}
												</span>
												<span className="text-xs text-muted-foreground">
													{new Date(
														item.capturedAt,
													).toLocaleString()}
												</span>
												{item.hasConflict && (
													<Badge variant="secondary">
														{t("conflict")}
													</Badge>
												)}
											</button>
										</li>
									))}
								</ul>
							)}
							{observations.hasNextPage &&
								!observations.isError && (
									<Button
										variant="outline"
										size="sm"
										disabled={
											observations.isFetchingNextPage
										}
										onClick={() =>
											void observations.fetchNextPage()
										}
									>
										{t("more")}
									</Button>
								)}
						</div>
					</>
				)}
			</div>
			<AlertDialog open={disconnect} onOpenChange={setDisconnect}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							{t("disconnectTitle")}
						</AlertDialogTitle>
						<AlertDialogDescription>
							{t("disconnectBody")}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>{t("keepSource")}</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							onClick={() => changeState("DISCONNECT")}
						>
							{t("disconnect")}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
			{selected &&
				watch.state !== "DISCONNECTED" &&
				status.isSuccess &&
				observations.isSuccess && (
					<PrivateEvidence
						key={selected}
						projectId={projectId}
						watchId={watch.id}
						observationId={selected}
						scope={scope}
						onClose={() => setSelected(undefined)}
						onDenied={onDenied}
					/>
				)}
		</details>
	);
}

function PrivateDeliverySources({
	projectId,
	scope,
	basePath,
	canManageConnections,
}: {
	projectId: string;
	scope: Scope;
	basePath: string;
	canManageConnections: boolean;
}) {
	const t = useTranslations("deliveryPrivateSources");
	const client = useQueryClient();
	const [refused, setRefused] = useState(false);
	const list = useQuery({
		queryKey: [...scope, "list"],
		queryFn: ({ signal }) => api.list({ projectId }, { signal }),
		enabled: !refused,
		gcTime: 0,
		staleTime: 0,
		retry: false,
	});
	useEffect(
		() => () => {
			void client.cancelQueries({ queryKey: scope });
			client.removeQueries({ queryKey: scope });
		},
		[client, scope],
	);
	const onDenied = () => {
		setRefused(true);
		void client.cancelQueries({ queryKey: scope });
		client.removeQueries({ queryKey: scope });
	};
	if (refused || (list.isError && denied(list.error))) {
		return null;
	}
	return (
		<details
			className="rounded-lg border border-border p-4"
			data-onboarding-target="delivery-private-sources"
		>
			<summary className="cursor-pointer font-medium text-sm">
				{t("title")}
			</summary>
			<div className="mt-4 space-y-5">
				<p className="max-w-prose text-sm text-muted-foreground">
					{t("scope")}
				</p>
				{list.isPending ? (
					<Skeleton
						className="h-20 w-full"
						aria-label={t("loading")}
					/>
				) : list.isError || !list.data ? (
					<PrivateSourceError retry={() => void list.refetch()} />
				) : list.data.availability.state === "UNAVAILABLE" ? (
					<div className="space-y-3">
						<p className="max-w-prose text-sm text-muted-foreground">
							{t(
								list.data.availability.reason ===
									"STORAGE_UNAVAILABLE"
									? "storageUnavailable"
									: "notEnabled",
							)}
						</p>
						{canManageConnections && (
							<Button asChild variant="link" className="px-0">
								<Link href={`${basePath}/connections`}>
									{t("connections")}
								</Link>
							</Button>
						)}
					</div>
				) : (
					<>
						{list.data.watches.map((watch) => (
							<PrivateWatch
								key={`${watch.id}:${watch.version}:${watch.verifiedAt}`}
								watch={watch}
								projectId={projectId}
								scope={scope}
								onDenied={onDenied}
							/>
						))}
						{!list.data.connections.some(
							(c) => c.supportsPrivateCapture,
						) ? (
							<div className="space-y-3">
								<p className="text-sm">{t("noConnections")}</p>
								{canManageConnections && (
									<Button asChild variant="outline" size="sm">
										<Link href={`${basePath}/connections`}>
											{t("connections")}
										</Link>
									</Button>
								)}
							</div>
						) : list.data.watches.length < 20 ? (
							<details className="border-t border-border pt-4">
								<summary className="cursor-pointer font-medium text-sm">
									{t("add")}
								</summary>
								<div className="mt-4">
									<PrivateSourceForm
										projectId={projectId}
										connections={list.data.connections}
										onDenied={onDenied}
										onSaved={() =>
											void client.invalidateQueries({
												queryKey: scope,
											})
										}
									/>
								</div>
							</details>
						) : (
							<p className="text-sm text-muted-foreground">
								{t("limit")}
							</p>
						)}
					</>
				)}
			</div>
		</details>
	);
}

export function ProjectPrivateDeliverySources({
	projectId,
}: {
	projectId: string;
}) {
	const { user } = useSession();
	const { organizationId, basePath, userRole } = useOrganizationContext();
	const canManageConnections = hasPermission(
		resolveOrgPermissions(userRole),
		Permissions.INTEGRATION_CONNECT,
	);
	const actorId = user?.id ?? "";
	const scope = useMemo<Scope>(
		() => ["private-delivery-sources", actorId, organizationId, projectId],
		[actorId, organizationId, projectId],
	);
	if (!actorId || !organizationId) {
		return null;
	}
	return (
		<PrivateDeliverySources
			key={JSON.stringify(scope)}
			projectId={projectId}
			scope={scope}
			basePath={basePath}
			canManageConnections={canManageConnections}
		/>
	);
}
