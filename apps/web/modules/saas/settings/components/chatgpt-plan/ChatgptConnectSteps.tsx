"use client";

import { cn } from "@ui/lib";
import { CheckIcon } from "lucide-react";
import { useTranslations } from "next-intl";

const STEPS = ["cli", "approve", "chatgpt", "terminal"] as const;

/**
 * The connection in the order the person meets it (Fizzy #3052): the CLI,
 * this approval, a ChatGPT sign-in the CLI opens, and the terminal's word
 * that it is connected. `current` is the step on screen, counted from 1.
 */
export function ChatgptConnectSteps({
	current,
	shared = false,
}: {
	current: 2 | 3;
	shared?: boolean;
}) {
	const t = useTranslations("settings.chatgptPlan.connect.steps");

	return (
		<section aria-labelledby="chatgpt-connect-steps" className="space-y-3">
			<h2 className="app-editorial-label" id="chatgpt-connect-steps">
				{t("label")}
			</h2>
			<ol className="space-y-2">
				{STEPS.map((step, index) => {
					const number = index + 1;
					const done = number < current;
					const active = number === current;
					return (
						<li
							aria-current={active ? "step" : undefined}
							className={cn(
								"flex items-start gap-3 text-sm",
								active
									? "text-foreground"
									: "text-muted-foreground",
							)}
							key={step}
						>
							<span
								aria-hidden
								className={cn(
									"mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border text-xs",
									active &&
										"border-primary bg-primary text-primary-foreground",
									done && "border-border bg-muted",
								)}
							>
								{done ? (
									<CheckIcon className="size-3" />
								) : (
									number
								)}
							</span>
							<span className={cn(active && "font-medium")}>
								{t(
									step === "chatgpt" && shared
										? "chatgptShared"
										: step,
								)}
								{done ? (
									<span className="sr-only">
										{` (${t("done")})`}
									</span>
								) : null}
							</span>
						</li>
					);
				})}
			</ol>
		</section>
	);
}
