/**
 * ActionOnlyProviderCard
 *
 * An integration that only exposes actions, in the same tile as every
 * other integration (see IntegrationTile in ProviderCard.tsx).
 */

"use client";

import type { IntegrationType } from "@saas/workflows/lib/plugins";
import { cn } from "@ui/lib";
import { Search } from "lucide-react";
import { getActionOnlyProviderPlugin } from "../lib/action-only-providers";
import { IntegrationTile } from "./ProviderCard";

interface ActionOnlyProviderCardProps {
	type: IntegrationType;
	href: string;
	hasConnection: boolean;
}

export function ActionOnlyProviderCard({
	type,
	href,
	hasConnection,
}: ActionOnlyProviderCardProps) {
	const plugin = getActionOnlyProviderPlugin(type);

	if (!plugin) {
		return null;
	}

	// Registry icon is typed as a component, but stay defensive against a
	// mis-registered plugin the same way IntegrationProviderPageContent does.
	const Icon = typeof plugin.icon === "function" ? plugin.icon : Search;

	return (
		<IntegrationTile
			href={href}
			icon={<Icon className={cn("size-7", plugin.color)} />}
			name={plugin.label}
			description={plugin.description}
			connected={hasConnection}
		/>
	);
}
