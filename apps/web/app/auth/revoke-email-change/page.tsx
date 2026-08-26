"use client";

import { authClient } from "@repo/auth/client";
import { orpcClient } from "@shared/lib/orpc-client";
import { Button } from "@ui/components/button";
import { CheckCircle2Icon, XCircleIcon } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";

type PageState = "idle" | "loading" | "success" | "error";

export default function RevokeEmailChangePage() {
	const t = useTranslations("auth.revokeEmailChange");
	const searchParams = useSearchParams();
	const token = searchParams.get("token") ?? "";

	const [state, setState] = useState<PageState>("idle");

	async function handleRevoke() {
		if (!token) {
			setState("error");
			return;
		}
		setState("loading");
		try {
			await orpcClient.auth.revokeEmailChange({ token });
			// Server has deleted the user's DB sessions. The browser may still
			// be holding a Better Auth `session_data` cookie cache (5 min TTL),
			// which would let it bounce between /app and /auth/login until the
			// cache expires. signOut() clears the cookie immediately.
			try {
				await authClient.signOut();
			} catch {
				// Ignore — the user may not have an active session in this
				// browser, or signOut may fail because the session is already
				// gone server-side. The success state is still correct.
			}
			setState("success");
		} catch {
			setState("error");
		}
	}

	return (
		<div className="flex min-h-[40vh] flex-col items-center justify-center gap-6 text-center px-4">
			<div className="space-y-2 max-w-sm">
				<h1 className="text-xl font-semibold text-foreground">
					{t("heading")}
				</h1>
				<p className="text-sm text-muted-foreground">{t("body")}</p>
			</div>

			{state === "success" && (
				<div
					aria-live="polite"
					className="flex flex-col items-center gap-3"
				>
					<CheckCircle2Icon className="size-8 text-success" />
					<p className="text-sm font-medium text-foreground">
						{t("success")}
					</p>
					<Link
						href="/auth/login"
						className="text-sm text-primary underline underline-offset-4"
					>
						{t("backToLogin")}
					</Link>
				</div>
			)}

			{state === "error" && (
				<div role="alert" className="flex flex-col items-center gap-3">
					<XCircleIcon className="size-8 text-destructive" />
					<p className="text-sm font-medium text-foreground">
						{t("error")}
					</p>
					<Link
						href="/auth/login"
						className="text-sm text-primary underline underline-offset-4"
					>
						{t("backToLogin")}
					</Link>
				</div>
			)}

			{(state === "idle" || state === "loading") && !token && (
				<div role="alert" className="flex flex-col items-center gap-3">
					<XCircleIcon className="size-8 text-destructive" />
					<p className="text-sm font-medium text-foreground">
						{t("error")}
					</p>
					<Link
						href="/auth/login"
						className="text-sm text-primary underline underline-offset-4"
					>
						{t("backToLogin")}
					</Link>
				</div>
			)}

			{(state === "idle" || state === "loading") && token && (
				<Button
					onClick={handleRevoke}
					loading={state === "loading"}
					disabled={state === "loading"}
					variant="destructive"
				>
					{t("confirmButton")}
				</Button>
			)}
		</div>
	);
}
