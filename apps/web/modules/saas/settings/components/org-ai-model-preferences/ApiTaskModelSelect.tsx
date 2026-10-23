"use client";

import {
	extractSubProviderFromModelId,
	GATEWAY_PROVIDERS,
} from "@repo/database/prisma/queries/ai-provider-config";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@ui/components/command";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ui/components/popover";
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
	CheckIcon,
	ChevronDownIcon,
	CloudIcon,
	NetworkIcon,
	PowerOffIcon,
	SparklesIcon,
	ZapIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useRef, useState } from "react";
import { API_DEFAULT_VALUE } from "./api-model-values";
import { ModelFitNote } from "./ModelFitNote";
import {
	type ApiTaskView,
	DECISION_DISABLED_VALUE,
	PROVIDER_DISPLAY_NAMES,
	TEXT_TASK_IDS,
} from "./use-org-api-model-preferences";

export { API_DEFAULT_VALUE } from "./api-model-values";

/** Audio retains the existing gateway → provider → models Select and reset path. */
function AudioTaskModelSelect({
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
	onValueChange: (value: string, invoker?: HTMLElement | null) => void;
	triggerClassName?: string;
	ariaLabel?: string;
	defaultLabel?: string;
	/** Why a listed model cannot be chosen here; it is then shown disabled. */
	modelUnavailableReason?: (canonicalName: string) => string | undefined;
}) {
	const t = useTranslations("settings.aiModelsRouting.models");
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
		<div className="space-y-1">
			<Select
				value={currentValue}
				onValueChange={onValueChange}
				disabled={hasNoProviders || disabled || !hasModels}
			>
				<SelectTrigger
					aria-label={ariaLabel}
					className={cn(
						"h-auto min-h-9 whitespace-normal",
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
							<div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
								<span className="truncate">
									{(view.isDefaultChoice ??
									(!view.hasCustomPref &&
										!view.hasPendingChange))
										? t("systemDefaultModel", {
												model: currentModel.displayName,
											})
										: currentModel.displayName}
								</span>
								{currentGateway && (
									<Badge
										variant="outline"
										className="text-xs shrink-0"
									>
										via{" "}
										{PROVIDER_DISPLAY_NAMES[
											currentGateway
										] || currentGateway}
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
									{view.defaultModel
										? t("systemDefaultModel", {
												model: view.defaultModel
													.displayName,
											})
										: t("noDefaultModel")}
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
																	{
																		unavailable
																	}
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
		</div>
	);
}

type ApiTaskModelSelectProps = Parameters<typeof AudioTaskModelSelect>[0];

const GATEWAYS: ReadonlySet<string> = new Set(GATEWAY_PROVIDERS);
const MAKER_NAMES: Record<string, string> = {
	openai: "OpenAI",
	anthropic: "Anthropic",
	google: "Google",
	meta: "Meta",
	"meta-llama": "Meta",
	mistral: "Mistral AI",
	mistralai: "Mistral AI",
	deepseek: "DeepSeek",
	xai: "xAI",
	"x-ai": "xAI",
	cohere: "Cohere",
	perplexity: "Perplexity",
	amazon: "Amazon",
	nvidia: "NVIDIA",
	"typesafe-ai": "TypeSafe AI",
};
function makerName(prefix: string): string {
	return (
		MAKER_NAMES[prefix.toLowerCase()] ??
		prefix
			.split(/[-_\s]+/)
			.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
			.join(" ")
	);
}

/** The shared API picker; Audio retains its existing Select interaction. */
export function ApiTaskModelSelect(props: ApiTaskModelSelectProps) {
	if (props.view.readOnly) {
		return <ReadOnlyTaskModel {...props} />;
	}
	if (props.view.taskType === "AUDIO") {
		return <AudioTaskModelSelect {...props} />;
	}
	return <SearchableTaskModelSelect {...props} />;
}

function TaskModelLabel({
	view,
	hasNoProviders,
	id,
}: Pick<ApiTaskModelSelectProps, "view" | "hasNoProviders"> & { id?: string }) {
	const t = useTranslations("settings.aiModelsRouting.models");
	return (
		<span
			id={id}
			className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-left"
		>
			<span className="truncate">
				{view.noDefaultProvider && !hasNoProviders
					? t("emptyModelPlaceholder")
					: view.isDisabledChoice
						? t("disabledChoice")
						: view.currentModel
							? (view.isDefaultChoice ??
								(!view.hasCustomPref && !view.hasPendingChange))
								? t("systemDefaultModel", {
										model: view.currentModel.displayName,
									})
								: view.currentModel.displayName
							: hasNoProviders
								? t("configureProvidersFirst")
								: !view.hasModels
									? t(
											view.taskType === "DECISION"
												? "emptyModelPlaceholder"
												: "noModelsAvailable",
										)
									: t("selectModel")}
			</span>
			{view.currentGateway &&
				!TEXT_TASK_IDS.some((task) => task === view.taskType) && (
					<Badge variant="outline" className="shrink-0 text-xs">
						via{" "}
						{PROVIDER_DISPLAY_NAMES[view.currentGateway] ||
							view.currentGateway}
					</Badge>
				)}
		</span>
	);
}
function ReadOnlyTaskModel(props: ApiTaskModelSelectProps) {
	return (
		<div className="space-y-1 text-sm">
			<TaskModelLabel
				view={props.view}
				hasNoProviders={props.hasNoProviders}
			/>
		</div>
	);
}

type PickerModel = {
	capabilities?: string[];
	suitableForTasks?: string[];
	value: string;
	canonicalName: string;
	maker: string;
	displayName: string;
	providerModelId?: string;
	speedTier: string;
	qualityTier: string;
	inputCostPer1M?: number | null;
	outputCostPer1M?: number | null;
};

/** cmdk re-focuses search and scrolls active items itself. Keep both local to
 * this popover so keyboard selection cannot scroll the settings page. */
function containCommandScrolling(root: HTMLDivElement | null) {
	if (!root) {
		return;
	}
	for (const node of [
		root,
		...root.querySelectorAll<HTMLElement>("[cmdk-input]"),
	]) {
		Object.defineProperty(node, "focus", {
			configurable: true,
			value: (options?: FocusOptions) =>
				HTMLElement.prototype.focus.call(node, {
					...options,
					preventScroll: true,
				}),
		});
	}
	for (const node of root.querySelectorAll<HTMLElement>(
		"[cmdk-item], [cmdk-group-heading]",
	)) {
		node.scrollIntoView = () => {
			const scroller = node.closest<HTMLElement>("[data-model-catalog]");
			// Pinned choices are always visible.
			if (!scroller) {
				return;
			}
			const bounds = scroller.getBoundingClientRect();
			const item = node.getBoundingClientRect();
			if (item.top < bounds.top) {
				scroller.scrollTop += item.top - bounds.top;
			} else if (item.bottom > bounds.bottom) {
				scroller.scrollTop += item.bottom - bounds.bottom;
			}
		};
	}
}

function SearchableTaskModelSelect({
	view,
	disabled,
	hasNoProviders,
	onValueChange,
	triggerClassName,
	ariaLabel,
	defaultLabel,
	modelUnavailableReason,
}: ApiTaskModelSelectProps) {
	const t = useTranslations("settings.aiModelsRouting.models");
	const fieldLabelId = useId();
	const valueId = useId();
	const [open, setOpen] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const [query, setQuery] = useState("");
	const [maker, setMaker] = useState<string | null>(null);
	// The catalog list carries no release-date field. Keep its order within each maker.
	const catalog: PickerModel[] = [];
	const seen = new Set<string>();
	for (const gateway of view.hierarchicalModels) {
		for (const provider of gateway.providers) {
			for (const model of provider.models) {
				const value = `${gateway.gateway}:${model.canonicalName}`;
				if (seen.has(value)) {
					continue;
				}
				seen.add(value);
				const prefix = GATEWAYS.has(gateway.gateway)
					? extractSubProviderFromModelId(model.providerModelId)
					: null;
				catalog.push({
					...model,
					value,
					maker: prefix
						? makerName(prefix)
						: provider.providerDisplayName,
				});
			}
		}
	}
	const groups = new Map<string, PickerModel[]>();
	for (const model of catalog) {
		const group = groups.get(model.maker) ?? [];
		group.push(model);
		groups.set(model.maker, group);
	}
	const showMakerFilters =
		view.hierarchicalModels.some((g) => GATEWAYS.has(g.gateway)) &&
		groups.size > 1;
	const showHeadings = groups.size > 1;
	const current =
		catalog.find((model) => model.value === view.currentValue) ??
		(view.currentModel
			? { ...view.currentModel, value: view.currentValue, maker: "" }
			: null);
	const search = query.trim().toLowerCase();
	const matches = (name: string, id = "") =>
		`${name} ${id}`.toLowerCase().includes(search);
	const visibleGroups = [...groups]
		.map(
			([name, models]) =>
				[
					name,
					models.filter(
						(model) =>
							model.value !== current?.value &&
							(maker === null || maker === name) &&
							matches(model.displayName, model.providerModelId),
					),
				] as const,
		)
		.filter(([, models]) => models.length > 0);
	const choose = (value: string) => {
		if (value !== view.currentValue) {
			if (view.taskType === "EMBEDDING") {
				onValueChange(value, triggerRef.current);
			} else {
				onValueChange(value);
			}
		}
		setOpen(false);
		setQuery("");
		setMaker(null);
	};
	const defaultProviderModelId = catalog.find(
		(model) => model.canonicalName === view.defaultModel?.canonicalName,
	)?.providerModelId;
	const resetLabel = view.defaultModel
		? t("systemDefaultModel", { model: view.defaultModel.displayName })
		: t("noDefaultModel");
	const setPopoverOpen = (value: boolean) => {
		setOpen(value);
		if (!value) {
			setQuery("");
			setMaker(null);
		}
	};
	const renderModel = (model: PickerModel, pinned = false) => {
		const unavailable = modelUnavailableReason?.(model.canonicalName);
		return (
			<CommandItem
				key={model.value}
				value={model.value}
				disabled={!!unavailable}
				onSelect={() => choose(model.value)}
			>
				<div className="min-w-0 flex-1 space-y-1">
					<div className="flex items-center gap-2">
						<span>{model.displayName}</span>
						<ModelFitNote
							taskType={view.taskType}
							model={model}
							compact
						/>
						{pinned && (
							<Badge variant="secondary" className="text-xs">
								{view.hasPendingChange
									? t("unsaved")
									: t("currentChoice")}
							</Badge>
						)}
						{model.speedTier === "FAST" && (
							<ZapIcon
								role="img"
								aria-label={t("fastModel")}
								className="text-success"
							>
								<title>{t("fastModel")}</title>
							</ZapIcon>
						)}
						{model.qualityTier === "PREMIUM" && (
							<SparklesIcon
								role="img"
								aria-label={t("premiumModel")}
								className="text-secondary"
							>
								<title>{t("premiumModel")}</title>
							</SparklesIcon>
						)}
					</div>
					{model.providerModelId && (
						<p className="break-all font-mono text-xs text-muted-foreground">
							{model.providerModelId}
						</p>
					)}
					{unavailable && (
						<p className="text-xs text-muted-foreground">
							{unavailable}
						</p>
					)}
				</div>
				{model.value === view.currentValue && (
					<CheckIcon
						role="img"
						aria-label={t("selectedModel")}
						className="ml-auto text-primary"
					/>
				)}
			</CommandItem>
		);
	};
	return (
		<div className="space-y-1">
			<Popover open={open} onOpenChange={setPopoverOpen}>
				<PopoverTrigger asChild>
					<Button
						ref={triggerRef}
						type="button"
						variant="outline"
						aria-labelledby={`${fieldLabelId} ${valueId}`}
						aria-expanded={open}
						aria-haspopup="dialog"
						disabled={
							disabled ||
							hasNoProviders ||
							!view.hasModels ||
							view.noDefaultProvider
						}
						className={cn(
							"h-auto min-h-9 justify-between whitespace-normal font-normal",
							triggerClassName ?? "w-full sm:w-80",
						)}
						onKeyDown={(event) => {
							if (
								event.key === "ArrowDown" ||
								event.key === "ArrowUp"
							) {
								event.preventDefault();
								setOpen(true);
							}
						}}
					>
						<span id={fieldLabelId} className="sr-only">
							{ariaLabel ?? t("selectModel")}
						</span>
						<TaskModelLabel
							id={valueId}
							view={view}
							hasNoProviders={hasNoProviders}
						/>
						<ChevronDownIcon
							aria-hidden="true"
							className="size-4 shrink-0 opacity-50"
						/>
					</Button>
				</PopoverTrigger>
				<PopoverContent
					align="start"
					className="w-96 max-w-full p-0"
					aria-label={ariaLabel ?? t("selectModel")}
					onOpenAutoFocus={(event) => {
						event.preventDefault();
						requestAnimationFrame(() =>
							inputRef.current?.focus({ preventScroll: true }),
						);
					}}
				>
					<Command
						shouldFilter={false}
						label={t("searchModels")}
						ref={(root) => containCommandScrolling(root)}
					>
						<CommandInput
							ref={inputRef}
							aria-label={t("searchModels")}
							placeholder={t("searchModels")}
							value={query}
							onValueChange={setQuery}
						/>
						{showMakerFilters && (
							<fieldset
								aria-label={t("modelMakerFilters")}
								className="order-2 flex min-w-0 flex-wrap gap-1 border-y border-border p-2"
							>
								{[null, ...groups.keys()].map((name) => (
									<Button
										key={name ?? "all"}
										type="button"
										variant={
											maker === name
												? "secondary"
												: "ghost"
										}
										size="sm"
										aria-pressed={maker === name}
										onKeyDown={(event) => {
											if (
												event.key === "Enter" ||
												event.key === " "
											) {
												event.stopPropagation();
											}
										}}
										onClick={() =>
											setMaker(
												maker === name ? null : name,
											)
										}
									>
										{name === null
											? t("allMakers")
											: `${name} (${groups.get(name)?.length ?? 0})`}
									</Button>
								))}
							</fieldset>
						)}
						{/* Keep the filter buttons outside the listbox; visual order puts pinned choices first. */}
						<CommandList className="contents [&_[cmdk-list-sizer]]:contents">
							<CommandEmpty className="order-3 py-6 text-center text-sm">
								{t("noModelsMatch", { query })}
							</CommandEmpty>
							<CommandGroup
								aria-label={t("pinnedChoices")}
								className="order-1"
							>
								{current &&
									matches(
										current.displayName,
										"providerModelId" in current
											? current.providerModelId
											: current.canonicalName,
									) &&
									renderModel(current, true)}
								{(view.defaultModel || defaultLabel) &&
									matches(
										resetLabel,
										defaultProviderModelId ??
											view.defaultModel?.canonicalName,
									) && (
										<CommandItem
											value={API_DEFAULT_VALUE}
											onSelect={() =>
												choose(API_DEFAULT_VALUE)
											}
										>
											{resetLabel}
										</CommandItem>
									)}
								{view.offersDisabledChoice &&
									matches(t("disabledChoice")) && (
										<CommandItem
											value={DECISION_DISABLED_VALUE}
											onSelect={() =>
												choose(DECISION_DISABLED_VALUE)
											}
										>
											<PowerOffIcon aria-hidden="true" />
											<span>
												{t("disabledChoice")}
												<span className="block text-xs text-muted-foreground">
													{t("disabledChoiceHelp")}
												</span>
											</span>
											{view.isDisabledChoice && (
												<>
													<Badge variant="secondary">
														{view.hasPendingChange
															? t("unsaved")
															: t(
																	"currentChoice",
																)}
													</Badge>
													<CheckIcon
														role="img"
														aria-label={t(
															"selectedModel",
														)}
													/>
												</>
											)}
										</CommandItem>
									)}
							</CommandGroup>
							<div
								data-model-catalog
								className="order-3 max-h-72 overflow-y-auto"
							>
								{visibleGroups.map(([name, models]) => (
									<CommandGroup
										key={name}
										heading={
											showHeadings ? name : undefined
										}
										className="overflow-visible [&_[cmdk-group-heading]]:sticky [&_[cmdk-group-heading]]:top-0 [&_[cmdk-group-heading]]:z-10 [&_[cmdk-group-heading]]:bg-popover"
									>
										{models.map((model) =>
											renderModel(model),
										)}
									</CommandGroup>
								))}
							</div>
						</CommandList>
					</Command>
				</PopoverContent>
			</Popover>
		</div>
	);
}
