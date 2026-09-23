"use client";

/**
 * The FR15 guidance on an AI-recommended work item (Fizzy #2211): how to
 * remove its whole batch and how to protect this one item from that. An item
 * that is already protected gets the shorter variant without the protect hint.
 *
 * Dismissal is remembered per person and project in localStorage — no DB
 * write. It stays hidden until the stored answer is read, so a dismissed note
 * never flashes on load, and a blocked storage falls back to showing it.
 */

import { useSession } from "@saas/auth/hooks/use-session";
import { Button } from "@ui/components/button";
import { SparklesIcon, XIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

function storageKey(userId: string, projectId: string): string {
	return `fabric:ai-recommended-guidance-dismissed:${userId}:${projectId}`;
}

export function AiRecommendedGuidance({
	projectId,
	isProtected = false,
}: {
	projectId: string;
	isProtected?: boolean;
}) {
	const t = useTranslations("projects.stories.aiRecommended.guidance");
	const { user } = useSession();
	const key = storageKey(user?.id ?? "anonymous", projectId);
	// null until hydrated from storage.
	const [dismissed, setDismissed] = useState<boolean | null>(null);

	useEffect(() => {
		try {
			setDismissed(window.localStorage.getItem(key) === "1");
		} catch {
			setDismissed(false);
		}
	}, [key]);

	if (dismissed !== false) {
		return null;
	}

	const dismiss = () => {
		setDismissed(true);
		try {
			window.localStorage.setItem(key, "1");
		} catch {
			// Storage blocked: dismissed for this page view only.
		}
	};

	return (
		<div
			role="note"
			className="flex items-start gap-3 border-b bg-muted/30 px-6 py-2 text-muted-foreground text-xs"
		>
			<SparklesIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
			<p className="flex-1">
				{t(isProtected ? "bodyProtected" : "body")}
			</p>
			<Button
				variant="ghost"
				size="icon"
				className="size-5 shrink-0"
				aria-label={t("dismiss")}
				onClick={dismiss}
			>
				<XIcon aria-hidden className="size-3.5" />
			</Button>
		</div>
	);
}
