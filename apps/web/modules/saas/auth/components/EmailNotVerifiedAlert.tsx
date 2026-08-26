"use client";

import { config } from "@repo/config";
import { orpcClient } from "@shared/lib/orpc-client";
import { Alert, AlertTitle } from "@ui/components/alert";
import { Button } from "@ui/components/button";
import { AlertTriangleIcon, MailCheckIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	hasActiveResendCooldown,
	useResendCountdown,
} from "../hooks/use-resend-countdown";
import { TurnstileWidget } from "./TurnstileWidget";

type Status = "initial" | "sending" | "sent" | "rate-limited" | "error";

const RESEND_COOLDOWN_SECONDS = 60;

interface EmailNotVerifiedAlertProps {
	email: string;
	/**
	 * Presentation of the resting (initial) state:
	 * - "error" (default): error alert with the "email not verified" title —
	 *   for sign-in failure surfaces where the unverified email IS the error.
	 * - "inline": compact neutral block (captcha + resend link) for
	 *   "check your email" screens where nothing went wrong yet.
	 * Feedback states (sent / rate-limited / error) render identically in
	 * both variants.
	 */
	variant?: "error" | "inline";
	/**
	 * Start the resend cooldown immediately on mount — for screens where the
	 * first email was JUST sent (post-signup), so an instant resend must not
	 * be possible. A cooldown already persisted for this email (localStorage)
	 * is resumed, never restarted, so re-mounts/refreshes don't reset it.
	 */
	startCooldownOnMount?: boolean;
}

export function EmailNotVerifiedAlert({
	email,
	variant = "error",
	startCooldownOnMount = false,
}: EmailNotVerifiedAlertProps) {
	const t = useTranslations("auth.verification");
	const tErrors = useTranslations("auth.errors");
	const [status, setStatus] = useState<Status>("initial");
	const { secondsLeft, isActive, startCountdown } = useResendCountdown(email);
	const [captchaToken, setCaptchaToken] = useState<string | null>(null);
	const [captchaResetKey, setCaptchaResetKey] = useState(0);
	const isCaptchaRequired =
		config.auth.captcha.enabled && Boolean(config.auth.captcha.siteKey);
	const cooldownInitializedRef = useRef(false);

	// Arm the cooldown at mount when requested (the host screen just sent
	// the first email). Guard with a direct storage read: the hook restores
	// a persisted countdown one commit late, so `isActive` is always false
	// in this first effect — relying on it would RESTART a running cooldown
	// on every re-mount/refresh.
	useEffect(() => {
		if (!startCooldownOnMount || cooldownInitializedRef.current) {
			return;
		}
		cooldownInitializedRef.current = true;
		if (!hasActiveResendCooldown(email)) {
			startCountdown(RESEND_COOLDOWN_SECONDS);
		}
	}, [startCooldownOnMount, email, startCountdown]);

	// If timer is active from localStorage on mount, show "sent" state — but
	// only on the error variant (the user previously triggered a resend from
	// a sign-in surface). The inline variant stays in its compact initial
	// presentation and shows the countdown there instead: its host screen
	// already says "check your email", and the cooldown may have been armed
	// by mount, not by a resend.
	const effectiveStatus =
		status === "initial" && isActive && variant === "error"
			? "sent"
			: status;

	const handleResend = useCallback(async () => {
		if (!email.trim() || (isCaptchaRequired && !captchaToken)) {
			return;
		}

		setStatus("sending");

		try {
			const response = await orpcClient.auth.resendVerificationEmail({
				email,
				// Server-side schema requires a non-empty string. When CAPTCHA
				// is disabled, verifyTurnstileToken short-circuits to success
				// regardless of value, so a placeholder satisfies validation.
				captchaToken: captchaToken ?? "captcha-disabled",
			});

			setCaptchaToken(null);
			setCaptchaResetKey((k) => k + 1);
			const resetSeconds =
				response.resetInSeconds != null
					? response.resetInSeconds
					: RESEND_COOLDOWN_SECONDS;
			startCountdown(resetSeconds);
			setStatus("sent");
		} catch (e: unknown) {
			setCaptchaToken(null);
			setCaptchaResetKey((k) => k + 1);

			const errorCode =
				e && typeof e === "object" && "code" in e
					? (e as { code: string }).code
					: undefined;

			if (
				errorCode === "TOO_MANY_REQUESTS" ||
				errorCode === "RATE_LIMITED"
			) {
				const errorData =
					e && typeof e === "object" && "data" in e
						? (
								e as {
									data?: {
										retryAfter?: number;
										isPerMinuteLimit?: boolean;
									};
								}
							).data
						: undefined;

				// Only show countdown for the per-minute limit (≤60s).
				// Hourly/IP limits have large retryAfter values which are confusing.
				if (
					errorData?.isPerMinuteLimit &&
					typeof errorData.retryAfter === "number"
				) {
					startCountdown(errorData.retryAfter);
				}
				setStatus("rate-limited");
				return;
			}

			setStatus("error");
		}
	}, [email, captchaToken, startCountdown]);

	const isResendDisabled =
		!email.trim() ||
		(isCaptchaRequired && !captchaToken) ||
		effectiveStatus === "sending" ||
		isActive;

	// Sent / timer active state
	if (
		effectiveStatus === "sent" ||
		(variant === "error" && effectiveStatus === "initial" && isActive)
	) {
		return (
			<Alert variant="success">
				<MailCheckIcon />
				<AlertTitle>{t("resendSuccess")}</AlertTitle>
				<div className="mt-1.5 flex flex-col gap-1">
					{isActive && (
						<p
							aria-live="polite"
							className="text-muted-foreground text-xs"
						>
							{t("resendCountdown", { seconds: secondsLeft })}
						</p>
					)}
					<TurnstileWidget
						key={captchaResetKey}
						onSuccess={setCaptchaToken}
						onExpire={() => setCaptchaToken(null)}
						onError={() => setCaptchaToken(null)}
					/>
					<Button
						variant="link"
						className="h-auto w-fit p-0 text-sm"
						disabled={isResendDisabled}
						onClick={handleResend}
					>
						{t("resendLink")}
					</Button>
				</div>
			</Alert>
		);
	}

	// Rate limited state — show countdown only for per-minute limit
	if (effectiveStatus === "rate-limited") {
		return (
			<Alert variant="error">
				<AlertTriangleIcon />
				<AlertTitle>{t("rateLimited")}</AlertTitle>
				{isActive && (
					<p
						aria-live="polite"
						className="mt-1 text-muted-foreground text-xs"
					>
						{t("resendCountdown", { seconds: secondsLeft })}
					</p>
				)}
			</Alert>
		);
	}

	// Error state
	if (effectiveStatus === "error") {
		return (
			<Alert variant="error">
				<AlertTriangleIcon />
				<AlertTitle>{t("genericError")}</AlertTitle>
				<TurnstileWidget
					key={captchaResetKey}
					onSuccess={setCaptchaToken}
					onExpire={() => setCaptchaToken(null)}
					onError={() => setCaptchaToken(null)}
				/>
				<Button
					variant="link"
					className="mt-1 h-auto p-0 text-sm"
					disabled={isResendDisabled}
					onClick={handleResend}
				>
					{t("resendLink")}
				</Button>
			</Alert>
		);
	}

	// Sending state
	if (effectiveStatus === "sending") {
		// Inline variant: stay compact while sending — flashing the
		// "email not verified" error chrome on a success screen is wrong.
		if (variant === "inline") {
			return (
				<div className="flex flex-col gap-1">
					<Button
						variant="link"
						className="h-auto w-fit p-0 text-sm"
						disabled
						loading
					>
						{t("resendSending")}
					</Button>
				</div>
			);
		}

		return (
			<Alert variant="error">
				<AlertTriangleIcon />
				<AlertTitle>{tErrors("emailNotVerified")}</AlertTitle>
				<Button
					variant="link"
					className="mt-1 h-auto p-0 text-sm"
					disabled
					loading
				>
					{t("resendSending")}
				</Button>
			</Alert>
		);
	}

	// Initial state — inline variant: no error alert, just the resend
	// affordance beneath the host screen's own "check your email" copy.
	// While the cooldown runs, the button is disabled and the remaining
	// time is shown — same mechanics as right after a resend.
	if (variant === "inline") {
		return (
			<div className="flex flex-col gap-1">
				{isActive && (
					<p
						aria-live="polite"
						className="text-muted-foreground text-xs"
					>
						{t("resendCountdown", { seconds: secondsLeft })}
					</p>
				)}
				<TurnstileWidget
					key={captchaResetKey}
					onSuccess={setCaptchaToken}
					onExpire={() => setCaptchaToken(null)}
					onError={() => setCaptchaToken(null)}
				/>
				<Button
					variant="link"
					className="h-auto w-fit p-0 text-sm"
					disabled={isResendDisabled}
					onClick={handleResend}
				>
					{t("resendLink")}
				</Button>
			</div>
		);
	}

	// Initial state (default)
	return (
		<Alert variant="error">
			<AlertTriangleIcon />
			<AlertTitle>{tErrors("emailNotVerified")}</AlertTitle>
			<TurnstileWidget
				key={captchaResetKey}
				onSuccess={setCaptchaToken}
				onExpire={() => setCaptchaToken(null)}
				onError={() => setCaptchaToken(null)}
			/>
			<Button
				variant="link"
				className="mt-1 h-auto p-0 text-sm"
				disabled={isResendDisabled}
				onClick={handleResend}
			>
				{t("resendLink")}
			</Button>
		</Alert>
	);
}
