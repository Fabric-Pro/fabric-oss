"use client";

import { Button } from "@ui/components/button";
import { SparklesIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import {
	useChatgptPlanStatus,
	useSetChatgptPlanOrganizationUse,
} from "./chatgpt-plan-status";

/**
 * Whether to ask a member with a working ChatGPT plan if they want to use it in
 * the organization on screen. Asked once: either answer is recorded, after
 * which `answered` keeps it away. `ShellNoticeRegion` calls this before
 * rendering, for the same reason it does `useMfaNoticeVisible`.
 */
export function useChatgptPlanPromptVisible(): boolean {
	const { query, currentOrganization } = useChatgptPlanStatus();

	return (
		query.data?.connected === true &&
		query.data.status === "ACTIVE" &&
		currentOrganization !== null &&
		!currentOrganization.answered
	);
}

export function ChatgptPlanPrompt() {
	const t = useTranslations("settings.chatgptPlan.prompt");
	const visible = useChatgptPlanPromptVisible();
	const answer = useSetChatgptPlanOrganizationUse({
		onError: () => toast.error(t("failed")),
	});

	if (!visible) {
		return null;
	}

	return (
		<div
			className="mx-auto flex w-full max-w-5xl flex-col gap-3 rounded-lg border border-border bg-card px-4 py-3 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-300 md:flex-row md:items-center md:justify-between"
			data-testid="chatgpt-plan-prompt"
		>
			<div className="flex min-w-0 items-start gap-3">
				<SparklesIcon
					aria-hidden="true"
					className="mt-0.5 size-4 shrink-0 text-primary"
				/>
				<div className="min-w-0">
					<p className="font-medium text-foreground text-sm">
						{t("title")}
					</p>
					<p className="text-muted-foreground text-sm leading-5">
						{t("description")}
					</p>
				</div>
			</div>
			<div className="flex shrink-0 items-center gap-2">
				<Button
					autoLoading={false}
					disabled={answer.isPending}
					onClick={() => answer.mutate(true)}
					size="sm"
					type="button"
					variant="outline"
				>
					{t("turnOn")}
				</Button>
				<Button
					autoLoading={false}
					disabled={answer.isPending}
					onClick={() => answer.mutate(false)}
					size="sm"
					type="button"
					variant="ghost"
				>
					{t("notNow")}
				</Button>
			</div>
		</div>
	);
}
