"use client";

import { useContextPath } from "@saas/organizations/hooks/use-organization-context";
import { useGatewayModels } from "@shared/hooks/use-gateway-models";
import { Label } from "@ui/components/label";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { Skeleton } from "@ui/components/skeleton";
import { AlertCircleIcon } from "lucide-react";

interface GatewayModelSelectorProps {
	value: string;
	onChange: (value: string) => void;
	label?: string;
	required?: boolean;
	placeholder?: string;
	disabled?: boolean;
	/** Optional class name for the container */
	className?: string;
	/** Hide the label */
	hideLabel?: boolean;
	/** Organization context for org-level configs */
	organizationId?: string;
}

/**
 * Reusable model selector component that fetches models from the configured AI gateway.
 *
 * Models are fetched in real-time from the gateway API and grouped by provider.
 * Only models from enabled providers are shown.
 *
 * Usage:
 * ```tsx
 * <GatewayModelSelector
 *   value={selectedModel}
 *   onChange={setSelectedModel}
 *   label="Model"
 *   required
 * />
 * ```
 */
export function GatewayModelSelector({
	value,
	onChange,
	label = "Model",
	required = false,
	placeholder = "Select a model...",
	disabled = false,
	className,
	hideLabel = false,
	organizationId,
}: GatewayModelSelectorProps) {
	// organizationId is auto-injected from context if not provided as prop
	const aiProvidersPath = useContextPath("settings/ai-providers");
	const {
		modelsByProvider,
		sortedProviders,
		isLoading,
		error,
		hasGatewayConfigured,
		getProviderDisplayName,
	} = useGatewayModels({ organizationId });

	if (isLoading) {
		return (
			<div className={className}>
				{!hideLabel && (
					<Label htmlFor="gateway-model-selector">
						{label}
						{required && (
							<span className="text-destructive ml-1">*</span>
						)}
					</Label>
				)}
				<Skeleton className="h-10 w-full mt-2" />
			</div>
		);
	}

	if (error) {
		return (
			<div className={className}>
				{!hideLabel && (
					<Label htmlFor="gateway-model-selector">
						{label}
						{required && (
							<span className="text-destructive ml-1">*</span>
						)}
					</Label>
				)}
				<div className="flex items-center gap-2 mt-2 text-destructive text-sm">
					<AlertCircleIcon className="size-4" />
					<span>Failed to load models</span>
				</div>
			</div>
		);
	}

	if (!hasGatewayConfigured) {
		return (
			<div className={className}>
				{!hideLabel && (
					<Label htmlFor="gateway-model-selector">
						{label}
						{required && (
							<span className="text-destructive ml-1">*</span>
						)}
					</Label>
				)}
				<div className="mt-2 text-muted-foreground text-sm">
					No AI gateway configured.{" "}
					<a
						href={aiProvidersPath}
						className="underline text-primary hover:text-primary/80"
					>
						Configure
					</a>
				</div>
			</div>
		);
	}

	const hasModels =
		sortedProviders.length > 0 &&
		sortedProviders.some((p) => modelsByProvider[p]?.length > 0);

	if (!hasModels) {
		return (
			<div className={className}>
				{!hideLabel && (
					<Label htmlFor="gateway-model-selector">
						{label}
						{required && (
							<span className="text-destructive ml-1">*</span>
						)}
					</Label>
				)}
				<div className="mt-2 text-muted-foreground text-sm">
					No models available. Check your{" "}
					<a
						href={aiProvidersPath}
						className="underline text-primary hover:text-primary/80"
					>
						enabled providers
					</a>
				</div>
			</div>
		);
	}

	return (
		<div className={className}>
			{!hideLabel && (
				<Label htmlFor="gateway-model-selector">
					{label}
					{required && (
						<span className="text-destructive ml-1">*</span>
					)}
				</Label>
			)}

			<Select value={value} onValueChange={onChange} disabled={disabled}>
				<SelectTrigger
					id="gateway-model-selector"
					className={hideLabel ? "" : "mt-2"}
				>
					<SelectValue placeholder={placeholder} />
				</SelectTrigger>
				<SelectContent className="max-h-[300px] overflow-y-auto">
					{sortedProviders.map((provider) => {
						const models = modelsByProvider[provider];
						if (!models || models.length === 0) {
							return null;
						}

						return (
							<SelectGroup key={provider}>
								<SelectLabel>
									{getProviderDisplayName(provider)}
								</SelectLabel>
								{models.map((model) => (
									<SelectItem key={model.id} value={model.id}>
										{model.name || model.id}
									</SelectItem>
								))}
							</SelectGroup>
						);
					})}
				</SelectContent>
			</Select>
		</div>
	);
}
