"use client";

import { Badge } from "@ui/components/badge";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { cn } from "@ui/lib";
import {
	CloudIcon,
	NetworkIcon,
	PowerOffIcon,
	SparklesIcon,
	ZapIcon,
} from "lucide-react";
import {
	type ApiTaskView,
	DECISION_DISABLED_VALUE,
	PROVIDER_DISPLAY_NAMES,
} from "./use-org-api-model-preferences";

/** The value of the optional "Default" item: clear this task's choice. */
export const API_DEFAULT_VALUE = "__api_default__";

/**
 * One task's API model select (gateway → provider → models), shared by the
 * legacy AI Models form and the API column of the plan routing table. With
 * `defaultLabel` it leads with an item that clears the task's choice; the
 * caller handles {@link API_DEFAULT_VALUE}.
 */
export function ApiTaskModelSelect({
	view,
	hasNoProviders,
	disabled,
	onValueChange,
	triggerClassName,
	ariaLabel,
	defaultLabel,
	modelUnavailableReason,
}: {
	view: ApiTaskView;
	hasNoProviders: boolean;
	disabled: boolean;
	onValueChange: (value: string) => void;
	triggerClassName?: string;
	ariaLabel?: string;
	defaultLabel?: string;
	/** Why a listed model cannot be chosen here; it is then shown disabled. */
	modelUnavailableReason?: (canonicalName: string) => string | undefined;
}) {
	const {
		currentValue,
		hasModels,
		isDisabledChoice,
		currentModel,
		currentGateway,
		offersDisabledChoice,
		hierarchicalModels,
	} = view;
	return (
		<Select
			value={currentValue}
			onValueChange={onValueChange}
			disabled={hasNoProviders || disabled || !hasModels}
		>
			<SelectTrigger
				aria-label={ariaLabel}
				className={cn(
					triggerClassName ?? "w-full sm:w-[320px]",
					!hasModels &&
						!hasNoProviders &&
						"border-highlight/30 bg-highlight/5",
				)}
			>
				<SelectValue
					placeholder={
						hasNoProviders
							? "Configure providers first"
							: !hasModels
								? "No models available"
								: "Select a model"
					}
				>
					{isDisabledChoice ? (
						<span className="truncate">Disabled</span>
					) : currentModel ? (
						<div className="flex items-center gap-2">
							<span className="truncate">
								{currentModel.displayName}
							</span>
							{currentGateway && (
								<Badge
									variant="outline"
									className="text-xs shrink-0"
								>
									via{" "}
									{PROVIDER_DISPLAY_NAMES[currentGateway] ||
										currentGateway}
								</Badge>
							)}
						</div>
					) : hasNoProviders ? (
						"Configure providers first"
					) : !hasModels ? (
						<span className="text-highlight">
							No models available
						</span>
					) : (
						"Select a model"
					)}
				</SelectValue>
			</SelectTrigger>
			<SelectContent className="max-h-[500px] w-[calc(100vw-1.5rem)] max-w-[420px]">
				{!hasModels ? (
					<div className="px-2 py-4 text-center text-sm text-muted-foreground">
						No models available for this task type
					</div>
				) : (
					<>
						{defaultLabel && (
							<SelectItem
								value={API_DEFAULT_VALUE}
								className="py-2"
							>
								{defaultLabel}
							</SelectItem>
						)}
						{offersDisabledChoice && (
							<SelectGroup>
								<SelectLabel className="flex items-center gap-2 py-1 pl-6 text-xs uppercase tracking-wide text-muted-foreground">
									<PowerOffIcon className="size-3" />
									Off
								</SelectLabel>
								<SelectItem
									value={DECISION_DISABLED_VALUE}
									className="py-2 pl-8"
								>
									<div className="flex flex-col gap-0.5">
										<span className="font-medium">
											Disabled
										</span>
										<span className="text-xs text-muted-foreground">
											Use the regular AI model instead
										</span>
									</div>
								</SelectItem>
							</SelectGroup>
						)}
						{hierarchicalModels.map((gateway) => (
							<div key={gateway.gateway}>
								{/* Gateway Header */}
								<div className="flex items-center gap-2 px-2 py-2 bg-muted/50 sticky top-0">
									<CloudIcon className="size-4 text-muted-foreground" />
									<span className="font-semibold text-sm">
										{gateway.gatewayDisplayName}
									</span>
									{gateway.isDefault && (
										<Badge
											variant="secondary"
											className="text-xs"
										>
											Default
										</Badge>
									)}
								</div>
								{/* Providers under this gateway */}
								{gateway.providers.map((provider) => (
									<SelectGroup
										key={`${gateway.gateway}-${provider.provider}`}
									>
										<SelectLabel className="flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground py-1 pl-6">
											<NetworkIcon className="size-3" />
											{provider.providerDisplayName}
											<span className="text-muted-foreground/60">
												({provider.models.length})
											</span>
										</SelectLabel>
										{provider.models.map((model) => {
											const unavailable =
												modelUnavailableReason?.(
													model.canonicalName,
												);
											return (
												<SelectItem
													key={`${gateway.gateway}-${provider.provider}-${model.canonicalName}`}
													value={`${gateway.gateway}:${model.canonicalName}`}
													className="py-2 pl-8"
													disabled={Boolean(
														unavailable,
													)}
												>
													<div className="flex flex-col gap-0.5">
														<div className="flex items-center gap-2">
															<span className="font-medium">
																{
																	model.displayName
																}
															</span>
															{model.speedTier ===
																"FAST" && (
																<ZapIcon className="size-3 text-success" />
															)}
															{model.qualityTier ===
																"PREMIUM" && (
																<SparklesIcon className="size-3 text-secondary" />
															)}
														</div>
														<span className="text-xs text-muted-foreground font-mono">
															{
																model.providerModelId
															}
														</span>
														{unavailable && (
															<span className="text-xs text-muted-foreground">
																{unavailable}
															</span>
														)}
													</div>
												</SelectItem>
											);
										})}
									</SelectGroup>
								))}
							</div>
						))}
					</>
				)}
			</SelectContent>
		</Select>
	);
}
