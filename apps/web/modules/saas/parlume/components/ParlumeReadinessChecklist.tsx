"use client";

import { useSettingsReturnUrl } from "@saas/settings/hooks/use-settings-return-url";
import { CircleAlertIcon } from "lucide-react";
import Link from "next/link";
import type { ParlumeReadiness } from "../lib/parlume-format";

interface MissingItem {
	id: string;
	text: string;
	fix:
		| { kind: "link"; label: string; href: string }
		| { kind: "note"; text: string };
}

function missingItems(
	readiness: ParlumeReadiness,
	settingsBasePath: string,
): MissingItem[] {
	const byAdmin = (page: string) =>
		readiness.canConfigure
			? null
			: `An organization owner or admin can set it up in Settings → ${page}.`;
	const items: MissingItem[] = [];
	if (!readiness.meetingBot.ready) {
		const note = byAdmin("Meeting assistant");
		items.push({
			id: "meeting-bot",
			text: "No meeting bot is set up for your organization.",
			fix: note
				? { kind: "note", text: note }
				: {
						kind: "link",
						label: "Set up the meeting bot",
						href: `${settingsBasePath}/meeting-assistant`,
					},
		});
	}
	if (!readiness.voice.ready) {
		const note = byAdmin("AI providers");
		items.push({
			id: "voice",
			text: "No AI provider can give Parlume a voice. It needs an Azure AI Foundry, OpenAI or Vercel AI Gateway key.",
			fix: note
				? { kind: "note", text: note }
				: {
						kind: "link",
						label: "Add an AI provider",
						href: `${settingsBasePath}/ai-providers`,
					},
		});
	}
	if (!readiness.platform.ready) {
		items.push({
			id: "platform",
			text: "Parlume's media bridge is not configured in this environment.",
			fix: {
				kind: "note",
				text: "Contact the Fabric operator; it is not an organization setting.",
			},
		});
	}
	return items;
}

/**
 * Names each thing an invitation is missing and where it is fixed, with a
 * link back here once it is. Renders nothing when Parlume is ready.
 */
export function ParlumeReadinessChecklist({
	readiness,
	settingsBasePath,
}: {
	readiness: ParlumeReadiness;
	settingsBasePath: string;
}) {
	const withReturn = useSettingsReturnUrl();
	const items = missingItems(readiness, settingsBasePath);
	if (items.length === 0) {
		return null;
	}
	return (
		<div
			className="space-y-2 rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm"
			role="alert"
		>
			<p className="font-medium text-destructive">
				Parlume is not ready to join meetings yet.
			</p>
			<ul className="space-y-2">
				{items.map((item) => (
					<li
						key={item.id}
						className="flex gap-2"
						data-testid={`parlume-missing-${item.id}`}
					>
						<CircleAlertIcon
							className="mt-0.5 size-4 shrink-0 text-destructive"
							aria-hidden="true"
						/>
						<span className="space-x-1.5">
							<span className="text-foreground">{item.text}</span>
							{item.fix.kind === "link" ? (
								<Link
									href={withReturn(item.fix.href)}
									className="text-primary underline underline-offset-4"
								>
									{item.fix.label}
								</Link>
							) : (
								<span className="text-muted-foreground">
									{item.fix.text}
								</span>
							)}
						</span>
					</li>
				))}
			</ul>
		</div>
	);
}
