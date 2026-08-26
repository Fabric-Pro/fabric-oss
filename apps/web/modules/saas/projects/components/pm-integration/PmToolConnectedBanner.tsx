"use client";

import { Button } from "@ui/components/button";
import { X } from "lucide-react";
import { useEffect, useState } from "react";

type PmProvider = "gitlab" | "atlassian" | "azure-devops" | "fizzy";

interface PmToolConnectedBannerProps {
	projectId: string;
	provider: PmProvider;
	tenantConnected: boolean;
	projectSelected: boolean;
	onUseProvider: () => void;
}

const PROVIDER_LABELS: Record<PmProvider, string> = {
	gitlab: "GitLab",
	atlassian: "Jira",
	"azure-devops": "Azure DevOps",
	fizzy: "Fizzy",
};

export function PmToolConnectedBanner({
	projectId,
	provider,
	tenantConnected,
	projectSelected,
	onUseProvider,
}: PmToolConnectedBannerProps) {
	const storageKey = `dismissedNudge_${provider}_${projectId}`;
	const [mounted, setMounted] = useState(false);
	const [dismissed, setDismissed] = useState(false);

	useEffect(() => {
		if (typeof window === "undefined") {
			return;
		}
		setDismissed(window.localStorage.getItem(storageKey) === "1");
		setMounted(true);
	}, [storageKey]);

	// Don't render anything until we've checked localStorage — prevents FOUC.
	if (!mounted) {
		return null;
	}
	if (!tenantConnected || projectSelected || dismissed) {
		return null;
	}

	const label = PROVIDER_LABELS[provider];

	return (
		<section
			aria-label={`${label} connected`}
			className="relative rounded-md border border-border bg-card p-4"
			style={{
				backgroundImage:
					"radial-gradient(circle, color-mix(in srgb, currentColor 8%, transparent) 1px, transparent 1px)",
				backgroundSize: "16px 16px",
			}}
		>
			<button
				type="button"
				aria-label="Dismiss"
				className="absolute right-2 top-2 text-muted-foreground hover:text-foreground"
				onClick={() => {
					try {
						window.localStorage.setItem(storageKey, "1");
					} catch (err) {
						console.warn(
							"[PmToolConnectedBanner] could not persist dismissal:",
							err,
						);
					}
					setDismissed(true);
				}}
			>
				<X size={14} />
			</button>
			<p className="text-sm">
				<strong>{label} is connected.</strong> Select it below to start
				syncing features and tickets.
			</p>
			<Button
				size="sm"
				variant="outline"
				className="mt-2"
				onClick={onUseProvider}
			>
				Use {label} as PM tool
			</Button>
		</section>
	);
}
