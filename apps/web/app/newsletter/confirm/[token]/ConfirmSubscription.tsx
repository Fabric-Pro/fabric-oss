"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { Button } from "@ui/components/button";
import { useTranslations } from "next-intl";
import { useState } from "react";

/**
 * Public double opt-in confirmation. Uses the RAW oRPC client in a click handler
 * (mirrors UnsubscribeConfirm) — confirming on click, not on GET, prevents
 * email-scanner prefetches from silently confirming a subscription.
 */
export function ConfirmSubscription({ token }: { token: string }) {
	const t = useTranslations("newsletter.confirm");
	const [status, setStatus] = useState<
		"idle" | "loading" | "done" | "invalid" | "error"
	>("idle");

	const handleConfirm = async () => {
		setStatus("loading");
		try {
			const res = await orpcClient.newsletter.confirmSubscription({
				token,
			});
			setStatus(res.confirmed ? "done" : "invalid");
		} catch {
			setStatus("error");
		}
	};

	if (status === "done") {
		return (
			<div className="space-y-2">
				<h1 className="font-serif text-2xl font-normal text-foreground">
					{t("success.title")}
				</h1>
				<p className="text-sm text-muted-foreground">
					{t("success.message")}
				</p>
			</div>
		);
	}

	if (status === "invalid") {
		return (
			<div className="space-y-2">
				<h1 className="font-serif text-2xl font-normal text-foreground">
					{t("invalid.title")}
				</h1>
				<p className="text-sm text-muted-foreground">
					{t("invalid.message")}
				</p>
			</div>
		);
	}

	return (
		<div className="space-y-4">
			<h1 className="font-serif text-2xl font-normal text-foreground">
				{t("title")}
			</h1>
			<p className="text-sm text-muted-foreground">{t("prompt")}</p>
			{status === "error" && (
				<p className="text-sm text-destructive">{t("error")}</p>
			)}
			<Button
				onClick={handleConfirm}
				loading={status === "loading"}
				autoLoading={false}
			>
				{t("confirmCta")}
			</Button>
		</div>
	);
}
