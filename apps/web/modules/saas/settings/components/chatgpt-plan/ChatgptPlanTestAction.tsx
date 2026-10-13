"use client";

import type { orpcClient } from "@shared/lib/orpc-client";
import { Button } from "@ui/components/button";
import {
	AlertCircleIcon,
	CheckCircleIcon,
	LoaderIcon,
	PlayIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";

export type ChatgptPlanTestResult = Awaited<
	ReturnType<typeof orpcClient.users.chatgptPlan.test>
>;

function clock(date: Date | string): string {
	return new Intl.DateTimeFormat(undefined, {
		hour: "2-digit",
		minute: "2-digit",
	}).format(new Date(date));
}

function seconds(latencyMs: number): string {
	return new Intl.NumberFormat(undefined, {
		minimumFractionDigits: 1,
		maximumFractionDigits: 1,
	}).format(latencyMs / 1000);
}

type TestCopy = ReturnType<typeof useTranslations>;

interface TestOutcome {
	ok: boolean;
	warning: boolean;
	text: string;
}

function describeOutcome(
	result: ChatgptPlanTestResult | undefined,
	error: unknown,
	t: TestCopy,
): TestOutcome | null {
	switch (result?.outcome) {
		case "ok":
			return {
				ok: true,
				warning: false,
				text: t("works", {
					model: result.modelName,
					seconds: seconds(result.latencyMs),
				}),
			};
		case "needs_reconnect":
			return { ok: false, warning: true, text: t("needsReconnect") };
		case "spent":
			return {
				ok: false,
				warning: true,
				text: result.resetAt
					? t("spentUntil", { time: clock(result.resetAt) })
					: t("spent"),
			};
		case "error":
			return {
				ok: false,
				warning: false,
				text: t("failed", { message: result.message }),
			};
		default:
			if (!error) {
				return null;
			}
			return {
				ok: false,
				warning: false,
				text:
					error instanceof Error && error.message
						? t("failed", { message: error.message })
						: t("failedGeneric"),
			};
	}
}

/**
 * The Test button on a ChatGPT plan (Fizzy #2770) and, beside it, what the
 * last test found: "Works · GPT-6 Luna · 1.2 s", "Needs reconnect", "Usage
 * limit reached until 18:50", or why it failed.
 */
export function ChatgptPlanTestAction({
	accountLabel,
	error,
	isPending,
	onTest,
	result,
}: {
	/** Names a shared account in the button's accessible label. */
	accountLabel?: string;
	error: unknown;
	isPending: boolean;
	onTest: () => void;
	result: ChatgptPlanTestResult | undefined;
}) {
	const t = useTranslations("settings.chatgptPlan.test");

	const outcome = isPending ? null : describeOutcome(result, error, t);

	return (
		<div className="flex flex-wrap items-center gap-2">
			<Button
				aria-label={
					accountLabel
						? t("accountLabel", { account: accountLabel })
						: undefined
				}
				autoLoading={false}
				disabled={isPending}
				onClick={onTest}
				size="sm"
				type="button"
				variant="outline"
			>
				{isPending ? (
					<LoaderIcon
						aria-hidden="true"
						className="mr-1 size-3 motion-safe:animate-spin"
					/>
				) : (
					<PlayIcon aria-hidden="true" className="mr-1 size-3" />
				)}
				{isPending ? t("running") : t("button")}
			</Button>
			<output
				aria-live="polite"
				className="flex max-w-64 items-center gap-1 text-xs"
				data-testid="chatgpt-plan-test-result"
			>
				{outcome ? (
					<>
						{outcome.ok ? (
							<CheckCircleIcon
								aria-hidden="true"
								className="size-3 shrink-0 text-success"
							/>
						) : (
							<AlertCircleIcon
								aria-hidden="true"
								className={`size-3 shrink-0 ${
									outcome.warning
										? "text-highlight"
										: "text-destructive"
								}`}
							/>
						)}
						<span className="break-words">{outcome.text}</span>
					</>
				) : null}
			</output>
		</div>
	);
}
