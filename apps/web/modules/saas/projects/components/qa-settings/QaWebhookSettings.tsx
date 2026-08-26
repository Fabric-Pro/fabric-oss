"use client";

import { useConfirmationAlert } from "@saas/shared/components/ConfirmationAlertProvider";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
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
	CheckIcon,
	CopyIcon,
	KeyRoundIcon,
	Loader2Icon,
	RefreshCwIcon,
	Trash2Icon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { toast } from "sonner";

const OVERLAP_OPTIONS = [
	{ value: "15", key: "overlap.minutes15" },
	{ value: "60", key: "overlap.hour1" },
	{ value: "360", key: "overlap.hours6" },
	{ value: "1440", key: "overlap.hours24" },
] as const;

const PROVIDERS = [
	{ value: "github", key: "providers.github" },
	{ value: "gitlab", key: "providers.gitlab" },
	{ value: "azure-devops", key: "providers.azure" },
] as const;

type Provider = (typeof PROVIDERS)[number]["value"];

function toLocalDateTime(value: Date | string | null | undefined): string {
	if (!value) {
		return "";
	}
	const date = new Date(value);
	const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
	return local.toISOString().slice(0, 16);
}

function formatDate(value: Date | string | null | undefined): string {
	if (!value) {
		return "—";
	}
	return new Intl.DateTimeFormat(undefined, {
		dateStyle: "medium",
		timeStyle: "short",
	}).format(new Date(value));
}

export function QaWebhookSettings({
	projectId,
	canEdit,
}: {
	projectId: string;
	canEdit: boolean;
}) {
	const t = useTranslations("projects.testCases.webhook");
	const queryClient = useQueryClient();
	const { confirm } = useConfirmationAlert();
	const [origin, setOrigin] = useState("");
	const [provider, setProvider] = useState<Provider>("github");
	const [overlapMinutes, setOverlapMinutes] = useState("60");
	const [expiry, setExpiry] = useState("");
	const [revealedSecret, setRevealedSecret] = useState<string | null>(null);
	const [copied, setCopied] = useState<"url" | "secret" | null>(null);

	const webhookQuery = useQuery(
		orpc.projects.qaSettings.webhook.get.queryOptions({
			input: { projectId },
		}),
	);
	const invalidate = () =>
		queryClient.invalidateQueries({
			queryKey: orpc.projects.qaSettings.webhook.get.key(),
		});
	const createMutation = useMutation(
		orpc.projects.qaSettings.webhook.create.mutationOptions({
			onSuccess: (data) => {
				setRevealedSecret(data.secret);
				setExpiry(toLocalDateTime(data.expiresAt));
				invalidate();
				toast.success(t("toasts.created"));
			},
			onError: (error) => toast.error(error.message),
		}),
	);
	const rotateMutation = useMutation(
		orpc.projects.qaSettings.webhook.rotate.mutationOptions({
			onSuccess: (data) => {
				setRevealedSecret(data.secret);
				invalidate();
				toast.success(t("toasts.rotated"));
			},
			onError: (error) => toast.error(error.message),
		}),
	);
	const expiryMutation = useMutation(
		orpc.projects.qaSettings.webhook.updateExpiry.mutationOptions({
			onSuccess: () => {
				invalidate();
				toast.success(t("toasts.expiryUpdated"));
			},
			onError: (error) => toast.error(error.message),
		}),
	);
	const revokeMutation = useMutation(
		orpc.projects.qaSettings.webhook.revoke.mutationOptions({
			onSuccess: () => {
				setRevealedSecret(null);
				setExpiry("");
				invalidate();
				toast.success(t("toasts.revoked"));
			},
			onError: (error) => toast.error(error.message),
		}),
	);

	useEffect(() => {
		setOrigin(window.location.origin);
	}, []);

	useEffect(() => {
		if (webhookQuery.data?.configured) {
			setExpiry(toLocalDateTime(webhookQuery.data.expiresAt));
		}
	}, [webhookQuery.data]);

	const webhook = webhookQuery.data;
	const endpointUrl = webhook ? `${origin}${webhook.endpointPath}` : "";
	const instructions =
		provider === "github"
			? {
					title: t("instructions.github.title"),
					steps: [
						t("instructions.github.step1"),
						t("instructions.github.step2"),
						t("instructions.github.step3"),
					],
				}
			: provider === "gitlab"
				? {
						title: t("instructions.gitlab.title"),
						steps: [
							t("instructions.gitlab.step1"),
							t("instructions.gitlab.step2"),
							t("instructions.genericSignature"),
						],
					}
				: {
						title: t("instructions.azure.title"),
						steps: [
							t("instructions.azure.step1"),
							t("instructions.azure.step2"),
							t("instructions.genericSignature"),
						],
					};
	const pending =
		createMutation.isPending ||
		rotateMutation.isPending ||
		expiryMutation.isPending ||
		revokeMutation.isPending;

	async function copy(value: string, kind: "url" | "secret") {
		try {
			await navigator.clipboard.writeText(value);
			setCopied(kind);
			window.setTimeout(() => setCopied(null), 2000);
		} catch {
			toast.error(t("clipboardDenied"));
		}
	}

	if (webhookQuery.isLoading) {
		return (
			<div className="flex items-center gap-2 py-8 text-muted-foreground text-sm">
				<Loader2Icon
					className="size-4 motion-safe:animate-spin"
					aria-hidden="true"
				/>
				{t("loading")}
			</div>
		);
	}
	if (webhookQuery.isError || !webhook) {
		return (
			<div className="space-y-2 rounded-md border border-destructive/30 p-4 text-sm">
				<p>{t("loadFailed")}</p>
				<Button
					type="button"
					variant="outline"
					size="sm"
					onClick={() => webhookQuery.refetch()}
				>
					{t("retry")}
				</Button>
			</div>
		);
	}

	return (
		<section className="space-y-4 border-t pt-8">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div>
					<h4 className="font-medium text-sm">{t("title")}</h4>
					<p className="mt-1 max-w-3xl text-muted-foreground text-xs">
						{t("description")}
					</p>
					{/* The same secret authenticates the per-project
					    pull-request review webhook. Said here because this is
					    where somebody looks for it, and because the alternative
					    — a deployment-wide secret every admin is given — cannot
					    identify which project a delivery is for. */}
					<p className="mt-1 max-w-3xl text-muted-foreground text-xs">
						{t("prReviewNote")}
					</p>
				</div>
				{canEdit && !webhook.configured && (
					<Button
						type="button"
						disabled={pending}
						onClick={() =>
							createMutation.mutate({
								projectId,
								expiresAt: expiry
									? new Date(expiry).toISOString()
									: null,
							})
						}
						className="gap-1.5"
					>
						<KeyRoundIcon className="size-4" aria-hidden="true" />
						{t("create")}
					</Button>
				)}
			</div>

			<div className="space-y-1">
				<Label htmlFor="qa-webhook-url">{t("endpoint")}</Label>
				<div className="flex gap-2">
					<Input
						id="qa-webhook-url"
						readOnly
						value={endpointUrl}
						className="font-mono text-xs"
					/>
					<Button
						type="button"
						variant="outline"
						disabled={!endpointUrl}
						onClick={() => copy(endpointUrl, "url")}
						className="shrink-0 gap-1.5"
					>
						{copied === "url" ? (
							<CheckIcon className="size-4" aria-hidden="true" />
						) : (
							<CopyIcon className="size-4" aria-hidden="true" />
						)}
						{t("copy")}
					</Button>
				</div>
			</div>

			{revealedSecret && (
				<div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
					<p className="font-medium text-sm">{t("secret.title")}</p>
					<p className="mt-1 text-muted-foreground text-xs">
						{t("secret.description")}
					</p>
					<div className="mt-2 flex gap-2">
						<Input
							readOnly
							aria-label={t("secret.aria")}
							value={revealedSecret}
							className="font-mono text-xs"
						/>
						<Button
							type="button"
							variant="outline"
							onClick={() => copy(revealedSecret, "secret")}
							className="shrink-0 gap-1.5"
						>
							{copied === "secret" ? (
								<CheckIcon
									className="size-4"
									aria-hidden="true"
								/>
							) : (
								<CopyIcon
									className="size-4"
									aria-hidden="true"
								/>
							)}
							{t("secret.copy")}
						</Button>
					</div>
				</div>
			)}

			{webhook.configured && (
				<div className="grid gap-3 rounded-md border p-3 sm:grid-cols-2">
					<div>
						<p className="text-muted-foreground text-xs">
							{t("currentSecret")}
						</p>
						<p className="font-mono text-sm">
							••••••••{webhook.secretHint}
						</p>
					</div>
					<div>
						<p className="text-muted-foreground text-xs">
							{t("deliveries")}
						</p>
						<p className="text-sm">
							{t("deliverySummary", {
								count: webhook.deliveryCount,
								date: formatDate(webhook.lastDeliveryAt),
							})}
						</p>
					</div>
					{webhook.previousSecretRetiresAt && (
						<p className="text-amber-700 text-xs sm:col-span-2 dark:text-amber-300">
							{t("previousValidUntil", {
								date: formatDate(
									webhook.previousSecretRetiresAt,
								),
							})}
						</p>
					)}
					{webhook.expired && (
						<p className="text-destructive text-xs sm:col-span-2">
							{t("expired")}
						</p>
					)}
					{webhook.lastError && (
						<output className="rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs sm:col-span-2">
							<p className="font-medium">{t("lastError")}</p>
							<p className="mt-1 text-muted-foreground">
								{webhook.lastError}{" "}
								{webhook.lastErrorAt
									? `· ${formatDate(webhook.lastErrorAt)}`
									: ""}
							</p>
						</output>
					)}
				</div>
			)}

			<fieldset className="space-y-3">
				<legend className="font-medium text-sm">
					{t("providerSetup")}
				</legend>
				<div className="flex flex-wrap gap-1.5">
					{PROVIDERS.map((item) => (
						<Button
							key={item.value}
							type="button"
							size="sm"
							variant={
								provider === item.value
									? "secondary"
									: "outline"
							}
							aria-pressed={provider === item.value}
							onClick={() => setProvider(item.value)}
						>
							{t(item.key)}
						</Button>
					))}
				</div>
				<div className="rounded-md bg-muted/60 p-3">
					<p className="font-medium text-xs">{instructions.title}</p>
					<ol className="mt-1 list-decimal space-y-1 pl-4 text-muted-foreground text-xs">
						{instructions.steps.map((step) => (
							<li key={step}>{step}</li>
						))}
					</ol>
				</div>
			</fieldset>

			{canEdit && (
				<div className="grid gap-4 border-t pt-4 md:grid-cols-2">
					<div className="space-y-2">
						<Label htmlFor="qa-webhook-expiry">{t("expiry")}</Label>
						<div className="flex gap-2">
							<Input
								id="qa-webhook-expiry"
								type="datetime-local"
								value={expiry}
								onChange={(event) =>
									setExpiry(event.target.value)
								}
							/>
							{webhook.configured && (
								<Button
									type="button"
									variant="outline"
									disabled={pending}
									onClick={() =>
										expiryMutation.mutate({
											projectId,
											expiresAt: expiry
												? new Date(expiry).toISOString()
												: null,
										})
									}
								>
									{t("save")}
								</Button>
							)}
						</div>
					</div>

					{webhook.configured && (
						<div className="space-y-2">
							<Label htmlFor="qa-webhook-overlap">
								{t("overlap.label")}
							</Label>
							<div className="flex gap-2">
								<Select
									value={overlapMinutes}
									onValueChange={setOverlapMinutes}
								>
									<SelectTrigger id="qa-webhook-overlap">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{OVERLAP_OPTIONS.map((option) => (
											<SelectItem
												key={option.value}
												value={option.value}
											>
												{t(option.key)}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
								<Button
									type="button"
									variant="outline"
									disabled={
										pending ||
										Boolean(webhook.previousSecretRetiresAt)
									}
									onClick={() =>
										rotateMutation.mutate({
											projectId,
											overlapMinutes:
												Number(overlapMinutes),
										})
									}
									className="shrink-0 gap-1.5"
								>
									<RefreshCwIcon
										className="size-4"
										aria-hidden="true"
									/>
									{t("rotate")}
								</Button>
							</div>
						</div>
					)}
				</div>
			)}

			{canEdit && webhook.configured && (
				<div className="flex justify-end">
					<Button
						type="button"
						variant="error"
						disabled={pending}
						onClick={() =>
							confirm({
								title: t("revokeDialog.title"),
								message: t("revokeDialog.message"),
								confirmLabel: t("revoke"),
								destructive: true,
								onConfirm: async () => {
									await revokeMutation.mutateAsync({
										projectId,
									});
								},
							})
						}
						className="gap-1.5"
					>
						<Trash2Icon className="size-4" aria-hidden="true" />
						{t("revoke")}
					</Button>
				</div>
			)}
		</section>
	);
}
