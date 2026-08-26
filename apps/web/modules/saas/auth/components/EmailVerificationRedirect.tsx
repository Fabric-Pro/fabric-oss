"use client";

import { useSession } from "@saas/auth/hooks/use-session";
import { safeRelativePath } from "@shared/lib/safe-redirect";
import { useRouter } from "@shared/hooks/router";
import { Loader2Icon } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useRef } from "react";
import { toast } from "sonner";

export function EmailVerificationRedirect() {
	const t = useTranslations();
	const router = useRouter();
	const searchParams = useSearchParams();
	const { loaded, user, reloadSession } = useSession();
	const hasHandledRef = useRef(false);
	const hasReloadedRef = useRef(false);

	// `redirectTo` arrives nested inside the verification callbackURL — an
	// attacker who crafts a confirm-email link can smuggle an external URL
	// here past the outer same-origin check. Validate again at this hop.
	const redirectTo =
		safeRelativePath(searchParams.get("redirectTo")) ?? "/app";
	const error = searchParams.get("error");

	useEffect(() => {
		if (hasReloadedRef.current) {
			return;
		}
		hasReloadedRef.current = true;
		void reloadSession().catch(() => {});
	}, [reloadSession]);

	useEffect(() => {
		if (!loaded || hasHandledRef.current) {
			return;
		}

		hasHandledRef.current = true;

		if (error) {
			if (user?.emailVerified) {
				toast.info(t("auth.verification.alreadyVerified"));
			} else {
				const verificationErrors: Record<string, string> = {
					token_expired: t("auth.errors.verification.tokenExpired"),
					invalid_token: t("auth.errors.verification.invalidToken"),
					user_not_found: t("auth.errors.verification.userNotFound"),
					unauthorized: t("auth.errors.verification.unauthorized"),
				};
				toast.error(
					verificationErrors[error] ??
						t("auth.errors.verification.genericError"),
				);
			}
			router.replace(redirectTo);
			return;
		}

		if (user?.emailVerified) {
			toast.success(t("auth.verification.confirmed"));
			router.replace(redirectTo);
			return;
		}

		toast.error(t("auth.errors.verification.genericError"));
		router.replace(redirectTo);
	}, [error, loaded, redirectTo, router, user?.emailVerified, t]);

	return (
		<div className="flex min-h-[40vh] flex-col items-center justify-center gap-3 text-center">
			<Loader2Icon className="size-5 animate-spin text-muted-foreground" />
			<div className="space-y-1">
				<p className="text-sm font-medium">
					{t("auth.verification.confirming")}
				</p>
				<p className="text-sm text-muted-foreground">
					{t("auth.verification.redirecting")}
				</p>
			</div>
		</div>
	);
}
