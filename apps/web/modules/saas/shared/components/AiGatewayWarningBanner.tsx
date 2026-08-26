"use client";

import {
	useContextPath,
	useOrganizationContext,
} from "@saas/organizations/hooks";
import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";

import { Button } from "@ui/components/button";
import {
	AlertTriangleIcon,
	SettingsIcon,
	SparklesIcon,
	XIcon,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";

/**
 * Warning banner that appears at the top of the app when no AI provider is configured.
 * This is critical because AI features will not work without at least one configured provider.
 *
 * Checks for any configured AI provider including:
 * - Direct providers (OpenAI, Anthropic, Groq, etc.)
 * - AI Gateways (Vercel AI Gateway, OpenRouter, etc.)
 * - Environment variables
 *
 * Detects context (personal vs organization) and links to the appropriate settings page.
 */
export function AiGatewayWarningBanner() {
	const [isDismissed, setIsDismissed] = useState(false);
	const { organizationId } = useOrganizationContext();
	const settingsPath = useContextPath("settings/ai-providers");

	// Query AI configuration status - checks all provider types
	// IMPORTANT: Pass null explicitly for personal context to prevent
	// session fallback which could leak org data to personal pages
	const { data: configStatus, isLoading } = useQuery({
		queryKey: ["aiConfigStatus", organizationId],
		queryFn: async () => {
			return await orpcClient.aiConfig.resolution.getStatus({
				organizationId,
			});
		},
	});

	// Determine warning state
	const isNotConfigured = !configStatus?.isConfigured;
	const shouldShowBanner = isNotConfigured;

	// Don't show banner if:
	// - Still loading
	// - User dismissed it (for this session)
	// - At least one AI provider is configured
	if (isLoading || isDismissed || !shouldShowBanner) {
		return null;
	}

	// Display message
	const title = "AI provider required";
	const description =
		"Add an OpenAI, Anthropic, Vercel AI Gateway, OpenRouter, or compatible provider key before Nexus, agents, document generation, and workflows can run.";

	// Generate the correct settings URL based on context
	const settingsUrl = settingsPath;

	return (
		<section
			aria-label="AI setup reminder"
			className="relative overflow-hidden rounded-2xl border border-highlight/30 bg-highlight/8 p-4 shadow-sm shadow-highlight/10"
		>
			<div
				className="absolute inset-y-0 left-0 w-1 bg-highlight"
				aria-hidden="true"
			/>
			<div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
				<div className="flex min-w-0 items-start gap-3 pl-1">
					<div className="mt-0.5 rounded-full border border-highlight/30 bg-highlight/15 p-2 text-highlight shadow-sm shadow-highlight/10">
						<AlertTriangleIcon className="size-4" />
					</div>
					<div className="min-w-0">
						<div className="flex flex-wrap items-center gap-2">
							<p className="text-sm font-semibold text-foreground">
								{title}
							</p>
							<span className="inline-flex items-center gap-1 rounded-full border border-highlight/25 bg-highlight/10 px-2 py-0.5 text-[11px] font-medium text-highlight">
								<SparklesIcon className="size-3" />
								Setup needed
							</span>
						</div>
						<p className="mt-1 text-sm leading-5 text-muted-foreground">
							{description}
						</p>
					</div>
				</div>
				<div className="flex shrink-0 items-center gap-2">
					<Button
						asChild
						size="sm"
						variant="outline"
						className="gap-2"
					>
						<Link href={settingsUrl}>
							<SettingsIcon className="size-4" />
							Configure provider
						</Link>
					</Button>
					<Button
						variant="ghost"
						size="icon"
						className="size-8 text-muted-foreground hover:text-foreground"
						onClick={() => setIsDismissed(true)}
						aria-label="Dismiss AI setup reminder"
					>
						<XIcon className="size-4" />
					</Button>
				</div>
			</div>
		</section>
	);
}
