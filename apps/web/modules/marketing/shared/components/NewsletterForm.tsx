"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { orpcClient } from "@shared/lib/orpc-client";
import { Alert, AlertDescription, AlertTitle } from "@ui/components/alert";
import { Button } from "@ui/components/button";
import { Input } from "@ui/components/input";
import { cn } from "@ui/lib";
import { CheckCircleIcon, SparklesIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { useForm } from "react-hook-form";
import * as z from "zod";

const formSchema = z.object({ email: z.string().email() });
type FormValues = z.infer<typeof formSchema>;

/**
 * Shared release-notes newsletter signup form. Calls the same-origin SP-4
 * subscribe RPC via the raw oRPC client (no react-query / QueryClientProvider),
 * so it works both in the marketing tree and in the minimal /embed route.
 */
export function NewsletterForm({
	className,
	token,
}: {
	className?: string;
	token?: string;
}) {
	const t = useTranslations("newsletter");
	const [submitted, setSubmitted] = useState(false);
	const errorId = useId();
	const form = useForm<FormValues>({
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		resolver: zodResolver(formSchema as any),
	});

	const onSubmit = form.handleSubmit(async ({ email }) => {
		try {
			// With an embed token, subscribe to that project's newsletter; without
			// one, the default env-locked Fabric-main marketing path is preserved.
			await orpcClient.newsletter.subscribe(
				token ? { email, token } : { email },
			);
			setSubmitted(true);
		} catch {
			form.setError("email", { message: t("hints.error.message") });
		}
	});

	// The privacy note is part of the form contract so it travels to BOTH the
	// marketing widget and the /embed iframe. It renders in every state (form,
	// error, success) below the body.
	return (
		<div className={cn(className)}>
			{submitted ? (
				<Alert variant="success" className="text-left">
					<CheckCircleIcon className="size-4" />
					<AlertTitle>{t("hints.success.title")}</AlertTitle>
					<AlertDescription>
						{t("hints.success.message")}
					</AlertDescription>
				</Alert>
			) : (
				<form onSubmit={onSubmit}>
					<div className="flex flex-col gap-3 sm:flex-row">
						<Input
							type="email"
							required
							placeholder={t("email")}
							aria-label={t("email")}
							aria-invalid={
								form.formState.errors.email ? true : undefined
							}
							aria-describedby={
								form.formState.errors.email
									? errorId
									: undefined
							}
							className="flex-1"
							{...form.register("email")}
						/>
						<Button
							type="submit"
							variant="primary"
							className="gap-2"
							loading={form.formState.isSubmitting}
						>
							<SparklesIcon className="size-4" />
							{t("submit")}
						</Button>
					</div>
					{form.formState.errors.email && (
						<p
							id={errorId}
							className="mt-2 text-left text-destructive text-xs"
						>
							{form.formState.errors.email.message}
						</p>
					)}
				</form>
			)}
			<p className="mt-4 text-foreground/40 text-xs">
				{t("privacyNote")}
			</p>
		</div>
	);
}
