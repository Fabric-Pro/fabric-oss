"use client";

import { useSettingsReturnUrl } from "@saas/settings/hooks/use-settings-return-url";
import { CircleAlertIcon, InfoIcon } from "lucide-react";
import Link from "next/link";
import type { ParlumeReadiness } from "../lib/parlume-format";

type Fix =
	| { kind: "link"; label: string; href: string }
	| { kind: "note"; text: string };

interface MissingItem {
	id: string;
	text: string;
	fix: Fix;
}

function byAdmin(readiness: ParlumeReadiness, page: string): string | null {
	return readiness.canConfigure
		? null
		: `An organization owner or admin can set it up in Settings → ${page}.`;
}

function missingItems(
	readiness: ParlumeReadiness,
	settingsBasePath: string,
): MissingItem[] {
	const items: MissingItem[] = [];
	if (!readiness.meetingBot.ready) {
		const note = byAdmin(readiness, "Meeting assistant");
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
		const note = byAdmin(readiness, "AI providers");
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
 * Advice, not a blocker: without the Attendee project's webhook secret Fabric
 * accepts the bot's events on their session token alone.
 */
function webhookAdvisory(
	readiness: ParlumeReadiness,
	settingsBasePath: string,
): MissingItem | null {
	const { ready, source, webhookSigned } = readiness.meetingBot;
	if (!ready || webhookSigned) {
		return null;
	}
	const text =
		"Fabric does not check the meeting bot's events against an Attendee webhook secret.";
	if (source !== "organization") {
		return {
			id: "webhook-secret",
			text,
			fix: {
				kind: "note",
				text: "The Fabric operator can set the secret.",
			},
		};
	}
	const note = byAdmin(readiness, "Meeting assistant");
	return {
		id: "webhook-secret",
		text,
		fix: note
			? { kind: "note", text: note }
			: {
					kind: "link",
					label: "Add the webhook secret",
					href: `${settingsBasePath}/meeting-assistant`,
				},
	};
}

function FixText({ fix }: { fix: Fix }) {
	const withReturn = useSettingsReturnUrl();
	return fix.kind === "link" ? (
		<Link
			href={withReturn(fix.href)}
			className="text-primary underline underline-offset-4"
		>
			{fix.label}
		</Link>
	) : (
		<span className="text-muted-foreground">{fix.text}</span>
	);
}

/**
 * Names each thing an invitation is missing and where it is fixed, with a
 * link back here once it is, and advises on a meeting bot whose events Fabric
 * cannot check by signature. Renders nothing when there is neither.
 */
export function ParlumeReadinessChecklist({
	readiness,
	settingsBasePath,
}: {
	readiness: ParlumeReadiness;
	settingsBasePath: string;
}) {
	const items = missingItems(readiness, settingsBasePath);
	const advisory = webhookAdvisory(readiness, settingsBasePath);
	if (items.length === 0 && !advisory) {
		return null;
	}
	return (
		<>
			{items.length > 0 && (
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
									<span className="text-foreground">
										{item.text}
									</span>
									<FixText fix={item.fix} />
								</span>
							</li>
						))}
					</ul>
				</div>
			)}
			{advisory && (
				<p
					className="flex gap-2 rounded-md border border-highlight/30 bg-highlight/5 px-4 py-3 text-sm"
					data-testid={`parlume-advisory-${advisory.id}`}
				>
					<InfoIcon
						className="mt-0.5 size-4 shrink-0 text-muted-foreground"
						aria-hidden="true"
					/>
					<span className="space-x-1.5">
						<span className="text-foreground">{advisory.text}</span>
						<FixText fix={advisory.fix} />
					</span>
				</p>
			)}
		</>
	);
}
