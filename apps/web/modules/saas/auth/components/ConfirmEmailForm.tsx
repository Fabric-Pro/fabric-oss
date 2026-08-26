"use client";

import { authClient } from "@repo/auth/client";
import { safeRelativePath } from "@shared/lib/safe-redirect";
import { useRouter } from "@shared/hooks/router";
import { Button } from "@ui/components/button";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { withQuery } from "ufo";

interface Props {
	token?: string;
}

export function ConfirmEmailForm({ token }: Props) {
	const t = useTranslations();
	const router = useRouter();
	const searchParams = useSearchParams();
	const [submitting, setSubmitting] = useState(false);

	const callbackURL = safeRelativePath(searchParams.get("callbackURL"));

	if (!token) {
		return (
			<div className="text-center text-sm text-muted-foreground">
				{t("auth.errors.verification.invalidToken")}
			</div>
		);
	}

	async function handleConfirm() {
		if (!token) {
			return;
		}
		setSubmitting(true);
		try {
			const res = await authClient.verifyEmail({
				query: { token },
			});
			if (res.error) {
				toast.error(t("auth.errors.verification.genericError"));
				setSubmitting(false);
				return;
			}
			// A `twoFactorEnabled` user gets no session from this call: the
			// 2FA hook in packages/auth/auth.ts revokes the one Better Auth
			// minted and issues a challenge instead, answering with the same
			// `twoFactorRedirect` payload a password sign-in returns. Hand off
			// to /auth/verify exactly as LoginForm does, carrying the
			// already-sanitized callbackURL as `redirectTo` so an invited
			// user's deep link survives the challenge (OtpForm consumes it,
			// and falls back to the default landing page without it).
			const twoFactorRedirect = (
				res.data as unknown as { twoFactorRedirect?: boolean } | null
			)?.twoFactorRedirect;
			if (twoFactorRedirect) {
				router.replace(
					withQuery(
						"/auth/verify",
						callbackURL ? { redirectTo: callbackURL } : {},
					),
				);
				return;
			}
			// With autoSignInAfterVerification=true, Better Auth has set a
			// session cookie. Redirect to the original callbackURL (which
			// usually points to /auth/email-verified?redirectTo=<final>) so
			// invited users land on /organization-invitation/<id> instead of
			// being bounced through /auth/login.
			router.push(callbackURL ?? "/auth/login?verified=1");
		} catch {
			toast.error(t("auth.errors.verification.genericError"));
			setSubmitting(false);
		}
	}

	return (
		<div className="flex min-h-[40vh] flex-col items-center justify-center gap-6 text-center">
			<div className="space-y-2">
				<h1 className="font-serif text-2xl">
					{t("auth.confirmEmail.heading")}
				</h1>
				<p className="max-w-md text-sm text-muted-foreground">
					{t("auth.confirmEmail.body")}
				</p>
			</div>
			<Button onClick={handleConfirm} disabled={submitting}>
				{submitting
					? t("auth.verification.confirming")
					: t("auth.confirmEmail.confirmButton")}
			</Button>
		</div>
	);
}
