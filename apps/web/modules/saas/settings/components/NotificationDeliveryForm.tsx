"use client";

import {
	useNotificationDeliveryPreferences,
	useRotateWebhookSecret,
	useUpdateNotificationDeliveryPreferences,
} from "@saas/notifications/hooks/use-notification-delivery-preferences";
import { Button } from "@ui/components/button";
import { Card } from "@ui/components/card";
import { Input } from "@ui/components/input";
import { Switch } from "@ui/components/switch";
import {
	BellIcon,
	CheckIcon,
	CopyIcon,
	Loader2Icon,
	MailIcon,
	WebhookIcon,
} from "lucide-react";
import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { toast } from "sonner";

type WebhookFormValues = {
	webhookEnabled: boolean;
	webhookUrl: string;
};

const WEBHOOK_URL_ERROR =
	"Enter a valid http:// or https:// URL without embedded credentials.";

/**
 * Client-side mirror of the server's webhook validation (AC-4): http(s) only,
 * no embedded credentials. Returns an error message, or null when valid.
 * Validated manually in `onSubmit` (not via a zod resolver) to stay independent
 * of the zod / @hookform/resolvers version skew in this repo.
 */
function validateWebhookUrl(url: string): string | null {
	const trimmed = url.trim();
	if (!/^https?:\/\//i.test(trimmed)) {
		return WEBHOOK_URL_ERROR;
	}
	try {
		const parsed = new URL(trimmed);
		if (parsed.username || parsed.password) {
			return WEBHOOK_URL_ERROR;
		}
	} catch {
		return WEBHOOK_URL_ERROR;
	}
	return null;
}

export function NotificationDeliveryForm() {
	const { data, isLoading, isError, refetch } =
		useNotificationDeliveryPreferences();
	const update = useUpdateNotificationDeliveryPreferences();

	if (isError) {
		return (
			<Card className="flex flex-col items-center gap-3 rounded-md border p-10 text-center">
				<p className="text-muted-foreground text-sm">
					Couldn't load your delivery preferences.
				</p>
				<Button variant="outline" size="sm" onClick={() => refetch()}>
					Retry
				</Button>
			</Card>
		);
	}

	if (isLoading || !data) {
		return (
			<Card className="flex items-center justify-center rounded-md border p-10">
				<Loader2Icon
					className="size-5 animate-spin text-muted-foreground"
					aria-label="Loading delivery preferences"
				/>
			</Card>
		);
	}

	return (
		<Card className="rounded-md border p-1 md:p-2">
			<ul className="divide-y">
				{/* In-app — always on, cannot be disabled (AC-8). */}
				<li className="flex items-center justify-between gap-4 p-3 md:p-4">
					<span className="flex items-start gap-3">
						<BellIcon
							className="mt-0.5 size-4 shrink-0 text-muted-foreground"
							aria-hidden
						/>
						<span className="flex flex-col gap-0.5">
							<span className="text-sm font-medium leading-tight">
								In-app
							</span>
							<span className="text-muted-foreground text-xs">
								Always on — shown in your notification center.
							</span>
						</span>
					</span>
					<Switch
						checked
						disabled
						aria-label="In-app delivery (always on, cannot be disabled)"
					/>
				</li>

				{/* Email channel — opt-in, instant toggle. */}
				<li className="flex items-center justify-between gap-4 p-3 md:p-4">
					<label
						htmlFor="delivery-email"
						className="flex cursor-pointer items-start gap-3"
					>
						<MailIcon
							className="mt-0.5 size-4 shrink-0 text-muted-foreground"
							aria-hidden
						/>
						<span className="flex flex-col gap-0.5">
							<span className="text-sm font-medium leading-tight">
								Email
							</span>
							<span className="text-muted-foreground text-xs">
								Also send notifications to your account email
								address.
							</span>
						</span>
					</label>
					<Switch
						id="delivery-email"
						checked={data.emailEnabled}
						disabled={update.isPending}
						aria-label="Email delivery"
						onCheckedChange={(value) =>
							update.mutate(
								{ emailEnabled: value },
								{
									onError: () =>
										toast.error(
											"Couldn't update email delivery",
										),
								},
							)
						}
					/>
				</li>
			</ul>

			{/* Webhook channel — mounted with loaded data so its draft (URL +
			    enable toggle) is local, not force-synced to the server state. */}
			<WebhookChannelForm
				initialEnabled={data.webhookEnabled}
				initialUrl={data.webhookUrl ?? ""}
				hasWebhookSecret={data.hasWebhookSecret}
			/>
		</Card>
	);
}

function WebhookChannelForm({
	initialEnabled,
	initialUrl,
	hasWebhookSecret,
}: {
	initialEnabled: boolean;
	initialUrl: string;
	hasWebhookSecret: boolean;
}) {
	const update = useUpdateNotificationDeliveryPreferences();
	const rotate = useRotateWebhookSecret();

	// The signing secret is shown exactly once after it is generated/rotated.
	const [revealedSecret, setRevealedSecret] = useState<string | null>(null);
	const [copied, setCopied] = useState(false);
	// URL validation error, tracked locally for a reliable inline-error render.
	const [urlError, setUrlError] = useState<string | null>(null);

	const form = useForm<WebhookFormValues>({
		defaultValues: {
			webhookEnabled: initialEnabled,
			webhookUrl: initialUrl,
		},
	});

	const copySecret = async () => {
		if (!revealedSecret) {
			return;
		}
		await navigator.clipboard.writeText(revealedSecret);
		setCopied(true);
		toast.success("Signing secret copied to clipboard");
		setTimeout(() => setCopied(false), 2000);
	};

	const onSubmit = form.handleSubmit((values) => {
		// Only the webhook endpoint needs validation, and only when enabling the
		// channel (AC-4). Block the save + surface an inline error if invalid.
		if (values.webhookEnabled) {
			const error = validateWebhookUrl(values.webhookUrl);
			if (error) {
				setUrlError(error);
				return;
			}
		}
		setUrlError(null);
		update.mutate(
			{
				webhookEnabled: values.webhookEnabled,
				webhookUrl: values.webhookUrl,
			},
			{
				onSuccess: (result) => {
					if (result.generatedWebhookSecret) {
						setRevealedSecret(result.generatedWebhookSecret);
					}
					toast.success("Webhook preferences saved");
				},
				onError: () => toast.error("Couldn't save webhook preferences"),
			},
		);
	});

	const onRotate = () => {
		if (
			!window.confirm(
				"Rotate the signing secret? The current secret stops working immediately.",
			)
		) {
			return;
		}
		rotate.mutate(undefined, {
			onSuccess: (result) => {
				setRevealedSecret(result.webhookSecret);
				toast.success("Signing secret rotated");
			},
			onError: () => toast.error("Couldn't rotate signing secret"),
		});
	};

	return (
		<form onSubmit={onSubmit} className="border-t px-3 pt-4 pb-3 md:px-4">
			<div className="flex items-start justify-between gap-4">
				<span className="flex items-start gap-3">
					<WebhookIcon
						className="mt-0.5 size-4 shrink-0 text-muted-foreground"
						aria-hidden
					/>
					<span className="flex flex-col gap-0.5">
						<span className="text-sm font-medium leading-tight">
							Webhook
						</span>
						<span className="text-muted-foreground text-xs">
							POST a signed JSON payload to your endpoint on each
							notification.
						</span>
					</span>
				</span>
				<Controller
					control={form.control}
					name="webhookEnabled"
					render={({ field }) => (
						<Switch
							checked={field.value}
							disabled={update.isPending}
							aria-label="Webhook delivery"
							onCheckedChange={field.onChange}
						/>
					)}
				/>
			</div>

			<div className="mt-3 flex flex-col gap-2">
				<label htmlFor="delivery-webhook-url" className="sr-only">
					Webhook URL
				</label>
				<div className="flex gap-2">
					<Input
						id="delivery-webhook-url"
						// Plain text (not type="url") so submission isn't blocked by
						// native constraint validation — we validate + surface the
						// error ourselves for a consistent, testable inline message.
						type="text"
						inputMode="url"
						placeholder="https://example.com/fabric/webhook"
						autoComplete="off"
						aria-invalid={urlError ? true : undefined}
						aria-describedby={
							urlError ? "delivery-webhook-url-error" : undefined
						}
						disabled={update.isPending}
						{...form.register("webhookUrl")}
					/>
					<Button type="submit" size="sm" loading={update.isPending}>
						Save
					</Button>
				</div>
				{urlError && (
					<p
						id="delivery-webhook-url-error"
						className="text-destructive text-xs"
					>
						{urlError}
					</p>
				)}
			</div>

			{/* Signing secret — shown once on generation/rotation. */}
			{revealedSecret ? (
				<div className="mt-3 rounded-md border border-highlight/40 bg-highlight/5 p-3">
					<p className="text-xs font-medium">
						Signing secret — copy it now, you won't see it again.
					</p>
					<div className="mt-2 flex items-center gap-2">
						<code className="flex-1 break-all rounded bg-muted px-2 py-1 font-mono text-xs">
							{revealedSecret}
						</code>
						<Button
							type="button"
							variant="outline"
							size="sm"
							autoLoading={false}
							onClick={copySecret}
						>
							{copied ? (
								<CheckIcon className="size-4" />
							) : (
								<CopyIcon className="size-4" />
							)}
						</Button>
					</div>
					<p className="mt-2 text-muted-foreground text-xs">
						Verify deliveries with the{" "}
						<code className="font-mono">X-Fabric-Signature</code>{" "}
						header (HMAC-SHA256 of the raw body).
					</p>
				</div>
			) : (
				hasWebhookSecret && (
					<div className="mt-3 flex items-center justify-between gap-3">
						<span className="text-muted-foreground text-xs">
							A signing secret is configured.
						</span>
						<Button
							type="button"
							variant="outline"
							size="sm"
							loading={rotate.isPending}
							onClick={onRotate}
						>
							Rotate secret
						</Button>
					</div>
				)
			)}
		</form>
	);
}
