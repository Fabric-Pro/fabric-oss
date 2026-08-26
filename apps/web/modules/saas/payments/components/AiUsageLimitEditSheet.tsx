"use client";

/**
 * `AiUsageLimitEditSheet` — the create/edit drawer for an
 * `AiUsageLimit` row. Mirrors the
 * activity drill-down Sheet pattern in `AiUsageActivityView.tsx:1461`
 * for visual consistency.
 * Fields (table): Name (optional, ≤80 chars), Dimension
 * (Tokens / Spend USD), Window (Hourly / Daily / Monthly tabs), Max
 * value (positive integer with unit suffix), Enforcement (Hard / Soft
 * radio with caption), Provider (Select — "All providers" only in v1
 * because the per-`providerConfigId` listing is owned by a future ticket),
 * Model (free-text v1 — full model picker deferred), Task type (All / one
 * of each `AiTaskType` enum value).
 * Submit: uses `useUpsertAiUsageLimit` from. Mutations
 * invalidate the `aiUsageLimits` cache root so the parent card
 * re-renders without a manual refetch. The hook itself emits the
 * fallback toast — this component owns the form-level error display
 * (server `CONFLICT` on duplicate scope, generic save-error text).
 * Delete (edit mode only): inline AlertDialog confirmation → server
 * soft-delete via `useDeleteAiUsageLimit`.
 * Per [`frontend/components.md`] (single-responsibility client component,
 * named export, `<Label htmlFor>` on every field), [`global/validation.md`]
 * (client-side Zod is defence-in-depth — server is the source of truth),
 * [`ai/ai-copy-tone.md`] (calm/advisory copy), [`frontend/css.md`]
 * (design-token colours, no `transition-all`).
 */

import {
	type AiUsageLimitDto,
	type UpsertAiUsageLimitInput,
	useAiUsageLimitProviderOptions,
	useDeleteAiUsageLimit,
	useUpsertAiUsageLimit,
} from "@saas/payments/hooks/useAiUsageLimits";
import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@ui/components/alert-dialog";
import { Button } from "@ui/components/button";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import { RadioGroup, RadioGroupItem } from "@ui/components/radio-group";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@ui/components/sheet";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import { InfoIcon, Loader2Icon } from "lucide-react";
import { useTranslations } from "next-intl";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { z } from "zod";

interface AiUsageLimitEditSheetProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** Org-context organisation id. Undefined = personal context. */
	organizationId?: string;
	/** Existing limit to edit. `null` / `undefined` → create mode. */
	existing?: AiUsageLimitDto | null;
}

const DIMENSIONS = ["TOKENS", "SPEND_USD"] as const;
const WINDOWS = ["HOURLY", "DAILY", "WEEKLY", "MONTHLY"] as const;
const ENFORCEMENTS = ["HARD", "SOFT"] as const;
const TASK_TYPES = [
	"SIMPLE",
	"COMPLEX",
	"REASONING",
	"CHAT",
	"TOOL_CALLING",
	"EMBEDDING",
	"IMAGE",
	"AUDIO",
	"EVAL",
] as const;

type Dimension = (typeof DIMENSIONS)[number];
type Window = (typeof WINDOWS)[number];
type Enforcement = (typeof ENFORCEMENTS)[number];
type TaskType = (typeof TASK_TYPES)[number];

/**
 * Sentinel value the `<Select>` uses when "All …" is picked. Radix
 * `<SelectItem>` rejects empty-string values, so we serialise the
 * "no filter" choice as `__all__` in the form state and convert back to
 * `null` on submit.
 */
const ALL_SENTINEL = "__all__";

/**
 * Scope picker for the new project-scope feature. WORKSPACE = the limit
 * applies to every AI call in the tenant; PROJECT = the limit applies
 * only to AI calls routed through a specific project (story AI, document
 * AI within the project, project-scoped agents). Both can coexist:
 * the chokepoint evaluates each project-scoped limit AND every workspace
 * limit, blocking on whichever fires first.
 */
type Scope = "WORKSPACE" | "PROJECT";

interface FormState {
	name: string;
	scope: Scope;
	/** Required when `scope === "PROJECT"`. Empty string when WORKSPACE. */
	projectId: string;
	dimension: Dimension;
	window: Window;
	/** Free-text input — validated via the Zod schema before submit. */
	maxValueInput: string;
	enforcement: Enforcement;
	providerConfigId: string;
	modelCanonicalName: string;
	taskType: string;
	/** Free-text input for percent 1-99; default 90 on create. */
	bannerThresholdInput: string;
}

/**
 * Defaults: SPEND_USD / MONTHLY / HARD, all filters null,
 * banner threshold 90%, workspace-global scope. Used on create mode and
 * on every Sheet open in create mode (so reopen after a save resets the
 * form cleanly).
 */
const CREATE_DEFAULTS: FormState = {
	name: "",
	scope: "WORKSPACE",
	projectId: "",
	dimension: "SPEND_USD",
	window: "MONTHLY",
	maxValueInput: "",
	enforcement: "HARD",
	providerConfigId: ALL_SENTINEL,
	modelCanonicalName: "",
	taskType: ALL_SENTINEL,
	bannerThresholdInput: "90",
};

/**
 * Hydrate the form state from an existing DTO. SPEND_USD storage is
 * micro-USD (BigInt as string); we divide by 1_000_000 to get the
 * dollar value the form's number input expects.
 */
function dtoToFormState(dto: AiUsageLimitDto): FormState {
	const maxValueBigInt = BigInt(dto.maxValue);
	const displayMaxValue =
		dto.dimension === "SPEND_USD"
			? // Round to 2 decimals because the input step is 0.01.
				(Number(maxValueBigInt) / 1_000_000).toFixed(2)
			: maxValueBigInt.toString();
	return {
		name: dto.name ?? "",
		scope: dto.projectId ? "PROJECT" : "WORKSPACE",
		projectId: dto.projectId ?? "",
		dimension: dto.dimension,
		window: dto.window,
		maxValueInput: displayMaxValue,
		enforcement: dto.enforcement,
		providerConfigId: dto.providerConfigId ?? ALL_SENTINEL,
		modelCanonicalName: dto.modelCanonicalName ?? "",
		taskType: dto.taskType ?? ALL_SENTINEL,
		bannerThresholdInput: String(dto.bannerThresholdPercent),
	};
}

/**
 * Client-side Zod schema. Defence-in-depth — the server schema in
 * `aiUsageLimits.upsert` is the source of truth. We keep the shape and
 * constraints in sync with `[global/validation.md]` §"Defense in
 * Depth".
 * Note: `maxValue` is coerced from string and validated as a positive
 * integer. SPEND_USD allows decimals (the dollar-input is `step="0.01"`)
 * and we multiply by 1e6 in the submit step before sending to the
 * server.
 */
const formSchema = z
	.object({
		name: z.string().max(80).optional(),
		scope: z.enum(["WORKSPACE", "PROJECT"]),
		projectId: z.string().optional(),
		dimension: z.enum(DIMENSIONS),
		window: z.enum(WINDOWS),
		maxValueInput: z
			.string()
			.min(1, "Max value is required")
			.refine((value) => {
				const parsed = Number.parseFloat(value);
				return Number.isFinite(parsed) && parsed > 0;
			}, "Max value must be a positive number"),
		enforcement: z.enum(ENFORCEMENTS),
		providerConfigId: z.string().optional(),
		modelCanonicalName: z.string().max(200).optional(),
		taskType: z.string().optional(),
		bannerThresholdInput: z
			.string()
			.min(1, "Banner threshold is required")
			.refine((value) => {
				const parsed = Number.parseInt(value, 10);
				return Number.isInteger(parsed) && parsed >= 1 && parsed <= 99;
			}, "Banner threshold must be an integer between 1 and 99"),
	})
	// PROJECT scope requires a non-empty projectId — surface the error on
	// the form-level toast banner instead of silently sending an empty
	// project. The server also enforces tenant ownership of the project.
	.refine(
		(data) => data.scope !== "PROJECT" || (data.projectId ?? "").length > 0,
		{
			message: "Please pick a project for project-scoped limits",
			path: ["projectId"],
		},
	);

/**
 * Convert the validated form state into the wire payload the
 * `aiUsageLimits.upsert` procedure expects. Per the procedure schema:
 * - `maxValue` is a positive integer in the dimension's natural unit
 * (the procedure converts SPEND_USD dollars → micro-USD on the
 * server side via `toStorageMaxValue`).
 * - Sentinel `null` for filter fields signals "no scope filter".
 */
function buildUpsertPayload(
	state: FormState,
	options: {
		organizationId?: string | null;
		existingId?: string;
	},
): UpsertAiUsageLimitInput {
	const parsedMax = Number.parseFloat(state.maxValueInput);
	// SPEND_USD: round dollars to nearest whole-dollar — the wire schema
	// requires an integer. `0.50` would be invalid; this rounds it up to
	// 1. The form's `min="1"` UX hint discourages sub-dollar values.
	// TOKENS: integer truncation is safe (parseFloat returns int for
	// whole-number inputs, and the schema rejects non-integers below).
	const wireMaxValue =
		state.dimension === "SPEND_USD" ? Math.round(parsedMax) : parsedMax;
	return {
		id: options.existingId,
		organizationId: options.organizationId ?? null,
		projectId: state.scope === "PROJECT" ? state.projectId : null,
		name: state.name.trim() ? state.name.trim() : undefined,
		dimension: state.dimension,
		window: state.window,
		maxValue: wireMaxValue,
		enforcement: state.enforcement,
		providerConfigId:
			state.providerConfigId && state.providerConfigId !== ALL_SENTINEL
				? state.providerConfigId
				: null,
		modelCanonicalName: state.modelCanonicalName.trim()
			? state.modelCanonicalName.trim()
			: null,
		taskType:
			state.taskType && state.taskType !== ALL_SENTINEL
				? (state.taskType as TaskType)
				: null,
		bannerThresholdPercent: Number.parseInt(state.bannerThresholdInput, 10),
	};
}

function formatTaskType(value: TaskType): string {
	return value
		.toLowerCase()
		.split("_")
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join(" ");
}

export function AiUsageLimitEditSheet({
	open,
	onOpenChange,
	organizationId,
	existing,
}: AiUsageLimitEditSheetProps) {
	const t = useTranslations("settings.aiUsage.limits.sheet");
	const isEdit = Boolean(existing);

	// Initial form state derived once per sheet-open. We re-hydrate via
	// `useEffect` below whenever `open` flips from false→true so a stale
	// in-memory form never shadows fresh `existing` data on reopen.
	const initialState = useMemo<FormState>(() => {
		if (existing) {
			return dtoToFormState(existing);
		}
		return CREATE_DEFAULTS;
	}, [existing]);

	const [formState, setFormState] = useState<FormState>(initialState);
	const [validationError, setValidationError] = useState<string | null>(null);
	const [serverError, setServerError] = useState<string | null>(null);
	const [isDeleteOpen, setIsDeleteOpen] = useState(false);

	const upsertMutation = useUpsertAiUsageLimit();
	const deleteMutation = useDeleteAiUsageLimit();

	// Prefetch the tenant's configured providers + model catalog when the
	// sheet is open. Wiring the Provider and Model selects with real
	// options (instead of the v1 "All providers"-only placeholder) requires
	// this list — and prefetching while the user is still picking Name /
	// Scope lets the dropdowns render instantly once the user scrolls down.
	const providerOptionsQuery = useAiUsageLimitProviderOptions(
		organizationId ?? null,
		{ enabled: open },
	);
	const providerOptions = providerOptionsQuery.data?.providers ?? [];
	const selectedProvider = providerOptions.find(
		(p) => p.id === formState.providerConfigId,
	);
	const availableModels = selectedProvider?.models ?? [];
	// Detect a stored model that no longer appears in the catalog (provider
	// dropped support, key reconfigured, etc.) so we render it as a
	// disabled fallback option instead of silently swallowing the value.
	const storedModelNotInCatalog =
		formState.modelCanonicalName.length > 0 &&
		!availableModels.some(
			(m) => m.canonicalName === formState.modelCanonicalName,
		);

	// Reset the form whenever the Sheet opens. Avoids the user seeing
	// the previous edit's values in a fresh "create" session, and
	// re-hydrates the form from the latest `existing` snapshot when
	// editing.
	useEffect(() => {
		if (open) {
			setFormState(initialState);
			setValidationError(null);
			setServerError(null);
		}
	}, [open, initialState]);

	// Prefetch projects on sheet open so the "Specific project" radio
	// renders the dropdown without a perceived loading delay. Idempotent —
	// hits the same cache entry as ProjectPicker's own useQuery.
	const queryClient = useQueryClient();
	useEffect(() => {
		if (open) {
			void queryClient.prefetchQuery({
				queryKey: projectPickerQueryKey(organizationId ?? null),
				queryFn: () => projectPickerQueryFn(organizationId ?? null),
				staleTime: 5 * 60_000,
			});
		}
	}, [open, organizationId, queryClient]);

	function handleSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		setValidationError(null);
		setServerError(null);

		const result = formSchema.safeParse(formState);
		if (!result.success) {
			const firstIssue = result.error.issues[0];
			setValidationError(
				firstIssue?.message ?? "Form has invalid values",
			);
			return;
		}

		const payload = buildUpsertPayload(result.data as FormState, {
			organizationId,
			existingId: existing?.id,
		});

		upsertMutation.mutate(payload, {
			onSuccess: () => {
				onOpenChange(false);
			},
			onError: (error) => {
				const message =
					error instanceof Error && error.message
						? error.message
						: t("saveErrorToast");
				setServerError(message);
			},
		});
	}

	function handleDelete() {
		if (!existing) {
			return;
		}
		deleteMutation.mutate(
			{ id: existing.id, organizationId: organizationId ?? null },
			{
				onSuccess: () => {
					setIsDeleteOpen(false);
					onOpenChange(false);
				},
				onError: (error) => {
					const message =
						error instanceof Error && error.message
							? error.message
							: t("deleteErrorToast");
					setServerError(message);
					setIsDeleteOpen(false);
				},
			},
		);
	}

	const isSaving = upsertMutation.isPending;
	const isDeleting = deleteMutation.isPending;

	const dimensionUnitLabel =
		formState.dimension === "SPEND_USD"
			? t("fieldMaxValueUnitSpend")
			: t("fieldMaxValueUnitTokens");

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent
				side="right"
				className="flex w-full flex-col gap-0 overflow-y-auto sm:max-w-lg"
			>
				<SheetHeader>
					<SheetTitle>
						{isEdit ? t("sheetTitleEdit") : t("sheetTitleCreate")}
					</SheetTitle>
					<SheetDescription>
						{t("highConcurrencyDisclaimer")}
					</SheetDescription>
				</SheetHeader>

				<form
					onSubmit={handleSubmit}
					className="mt-6 flex flex-1 flex-col gap-6"
					noValidate
				>
					<div className="space-y-2">
						<Label htmlFor="ai-usage-limit-name">
							{t("fieldName")}
						</Label>
						<Input
							id="ai-usage-limit-name"
							type="text"
							maxLength={80}
							placeholder={t("fieldNamePlaceholder")}
							value={formState.name}
							onChange={(event) =>
								setFormState((prev) => ({
									...prev,
									name: event.target.value,
								}))
							}
						/>
					</div>

					<fieldset className="space-y-2">
						<legend className="text-sm font-medium text-foreground">
							{t("fieldScope")}
						</legend>
						<RadioGroup
							value={formState.scope}
							onValueChange={(value) =>
								setFormState((prev) => ({
									...prev,
									scope: value as Scope,
									// Drop the projectId on switch to WORKSPACE so a
									// previously-picked project doesn't leak into the
									// submit payload via a hidden form-state key.
									projectId:
										value === "WORKSPACE"
											? ""
											: prev.projectId,
								}))
							}
							className="flex flex-col gap-2"
							aria-label={t("fieldScope")}
						>
							<div className="flex items-center gap-2">
								<RadioGroupItem
									id="ai-usage-limit-scope-workspace"
									value="WORKSPACE"
								/>
								<Label
									htmlFor="ai-usage-limit-scope-workspace"
									className="cursor-pointer font-normal"
								>
									{t("fieldScopeWorkspace")}
								</Label>
							</div>
							<div className="flex items-center gap-2">
								<RadioGroupItem
									id="ai-usage-limit-scope-project"
									value="PROJECT"
								/>
								<Label
									htmlFor="ai-usage-limit-scope-project"
									className="cursor-pointer font-normal"
								>
									{t("fieldScopeProject")}
								</Label>
							</div>
						</RadioGroup>
						{formState.scope === "PROJECT" ? (
							<div className="space-y-2 pt-2">
								<Label htmlFor="ai-usage-limit-project">
									{t("fieldProject")}
								</Label>
								<ProjectPicker
									organizationId={organizationId ?? null}
									value={formState.projectId}
									onChange={(value) =>
										setFormState((prev) => ({
											...prev,
											projectId: value,
										}))
									}
								/>
							</div>
						) : null}
					</fieldset>

					<fieldset className="space-y-2">
						<legend className="text-sm font-medium text-foreground">
							{t("fieldDimension")}
						</legend>
						<RadioGroup
							value={formState.dimension}
							onValueChange={(value) =>
								setFormState((prev) => ({
									...prev,
									dimension: value as Dimension,
								}))
							}
							className="flex flex-row gap-4"
							aria-label={t("fieldDimension")}
						>
							<div className="flex items-center gap-2">
								<RadioGroupItem
									id="ai-usage-limit-dimension-tokens"
									value="TOKENS"
								/>
								<Label
									htmlFor="ai-usage-limit-dimension-tokens"
									className="cursor-pointer font-normal"
								>
									{t("fieldDimensionTokens")}
								</Label>
							</div>
							<div className="flex items-center gap-2">
								<RadioGroupItem
									id="ai-usage-limit-dimension-spend"
									value="SPEND_USD"
								/>
								<Label
									htmlFor="ai-usage-limit-dimension-spend"
									className="cursor-pointer font-normal"
								>
									{t("fieldDimensionSpend")}
								</Label>
							</div>
						</RadioGroup>
					</fieldset>

					<div className="space-y-2">
						<div className="flex items-center gap-1.5">
							<Label htmlFor="ai-usage-limit-window">
								{t("fieldWindow")}
							</Label>
							<TooltipProvider delayDuration={200}>
								<Tooltip>
									<TooltipTrigger asChild>
										<button
											type="button"
											aria-label={t(
												"fieldWindowInfoAria",
											)}
											className="inline-flex size-4 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
										>
											<InfoIcon
												className="size-3.5"
												aria-hidden="true"
											/>
										</button>
									</TooltipTrigger>
									<TooltipContent
										side="right"
										className="max-w-xs space-y-1.5 text-xs leading-relaxed"
									>
										<p className="font-medium">
											{t("fieldWindowInfoTitle")}
										</p>
										<p>
											<span className="font-medium">
												{t("fieldWindowHourly")}:
											</span>{" "}
											{t("fieldWindowHourlyTooltip")}
										</p>
										<p>
											<span className="font-medium">
												{t("fieldWindowDaily")}:
											</span>{" "}
											{t("fieldWindowDailyTooltip")}
										</p>
										<p>
											<span className="font-medium">
												{t("fieldWindowWeekly")}:
											</span>{" "}
											{t("fieldWindowWeeklyTooltip")}
										</p>
										<p>
											<span className="font-medium">
												{t("fieldWindowMonthly")}:
											</span>{" "}
											{t("fieldWindowMonthlyTooltip")}
										</p>
									</TooltipContent>
								</Tooltip>
							</TooltipProvider>
						</div>
						<Select
							value={formState.window}
							onValueChange={(value) =>
								setFormState((prev) => ({
									...prev,
									window: value as Window,
								}))
							}
						>
							<SelectTrigger id="ai-usage-limit-window">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="HOURLY">
									{t("fieldWindowHourly")}
								</SelectItem>
								<SelectItem value="DAILY">
									{t("fieldWindowDaily")}
								</SelectItem>
								<SelectItem value="WEEKLY">
									{t("fieldWindowWeekly")}
								</SelectItem>
								<SelectItem value="MONTHLY">
									{t("fieldWindowMonthly")}
								</SelectItem>
							</SelectContent>
						</Select>
					</div>

					<div className="space-y-2">
						<Label htmlFor="ai-usage-limit-max-value">
							{t("fieldMaxValue")}
						</Label>
						<div className="flex items-center gap-2">
							<Input
								id="ai-usage-limit-max-value"
								type="number"
								inputMode={
									formState.dimension === "SPEND_USD"
										? "decimal"
										: "numeric"
								}
								min={1}
								step={
									formState.dimension === "SPEND_USD"
										? "0.01"
										: "1"
								}
								required
								value={formState.maxValueInput}
								onChange={(event) =>
									setFormState((prev) => ({
										...prev,
										maxValueInput: event.target.value,
									}))
								}
								className="flex-1"
								aria-describedby="ai-usage-limit-max-value-unit"
							/>
							<span
								id="ai-usage-limit-max-value-unit"
								className="shrink-0 text-sm text-muted-foreground"
							>
								{dimensionUnitLabel}
							</span>
						</div>
					</div>

					<fieldset className="space-y-2">
						<legend className="text-sm font-medium text-foreground">
							{t("fieldEnforcement")}
						</legend>
						<RadioGroup
							value={formState.enforcement}
							onValueChange={(value) =>
								setFormState((prev) => ({
									...prev,
									enforcement: value as Enforcement,
								}))
							}
							className="grid gap-3"
							aria-label={t("fieldEnforcement")}
						>
							<div className="flex items-start gap-2">
								<RadioGroupItem
									id="ai-usage-limit-enforcement-hard"
									value="HARD"
									className="mt-0.5"
								/>
								<div className="space-y-0.5">
									<Label
										htmlFor="ai-usage-limit-enforcement-hard"
										className="cursor-pointer font-normal"
									>
										{t("fieldEnforcementHard")}
									</Label>
									<p className="text-xs text-muted-foreground">
										{t("fieldEnforcementHardCaption")}
									</p>
								</div>
							</div>
							<div className="flex items-start gap-2">
								<RadioGroupItem
									id="ai-usage-limit-enforcement-soft"
									value="SOFT"
									className="mt-0.5"
								/>
								<div className="space-y-0.5">
									<Label
										htmlFor="ai-usage-limit-enforcement-soft"
										className="cursor-pointer font-normal"
									>
										{t("fieldEnforcementSoft")}
									</Label>
									<p className="text-xs text-muted-foreground">
										{t("fieldEnforcementSoftCaption")}
									</p>
								</div>
							</div>
						</RadioGroup>
					</fieldset>

					<div className="space-y-2">
						<Label htmlFor="ai-usage-limit-banner-threshold">
							{t("fieldBannerThreshold")}
						</Label>
						<Input
							id="ai-usage-limit-banner-threshold"
							type="number"
							min={1}
							max={99}
							step={1}
							value={formState.bannerThresholdInput}
							onChange={(event) =>
								setFormState((prev) => ({
									...prev,
									bannerThresholdInput: event.target.value,
								}))
							}
							aria-describedby="ai-usage-limit-banner-threshold-help"
						/>
						<p
							id="ai-usage-limit-banner-threshold-help"
							className="text-xs text-muted-foreground"
						>
							{t("fieldBannerThresholdHelp")}
						</p>
					</div>

					<div className="space-y-2">
						<Label htmlFor="ai-usage-limit-provider">
							{t("fieldProvider")}
						</Label>
						<Select
							value={formState.providerConfigId}
							onValueChange={(value) =>
								setFormState((prev) => ({
									...prev,
									providerConfigId: value,
									// Clear stale model selection when the
									// provider changes — the model select is
									// dependent and its options just changed.
									modelCanonicalName:
										value === prev.providerConfigId
											? prev.modelCanonicalName
											: "",
								}))
							}
							disabled={providerOptionsQuery.isLoading}
						>
							<SelectTrigger id="ai-usage-limit-provider">
								<SelectValue
									placeholder={
										providerOptionsQuery.isLoading
											? t("fieldProviderLoading")
											: t("fieldProviderAll")
									}
								/>
							</SelectTrigger>
							<SelectContent>
								<SelectItem value={ALL_SENTINEL}>
									{t("fieldProviderAll")}
								</SelectItem>
								{providerOptions.map((provider) => (
									<SelectItem
										key={provider.id}
										value={provider.id}
									>
										{provider.displayName}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						{!providerOptionsQuery.isLoading &&
						providerOptions.length === 0 ? (
							<p className="text-xs text-muted-foreground">
								{t("fieldProviderEmpty")}
							</p>
						) : null}
					</div>

					<div className="space-y-2">
						<Label htmlFor="ai-usage-limit-model">
							{t("fieldModel")}
						</Label>
						<Select
							value={
								formState.modelCanonicalName
									? formState.modelCanonicalName
									: ALL_SENTINEL
							}
							onValueChange={(value) =>
								setFormState((prev) => ({
									...prev,
									modelCanonicalName:
										value === ALL_SENTINEL ? "" : value,
								}))
							}
							disabled={
								formState.providerConfigId === ALL_SENTINEL ||
								providerOptionsQuery.isLoading
							}
						>
							<SelectTrigger id="ai-usage-limit-model">
								<SelectValue
									placeholder={
										formState.providerConfigId ===
										ALL_SENTINEL
											? t("fieldModelPickProviderFirst")
											: t("fieldModelAll")
									}
								/>
							</SelectTrigger>
							<SelectContent>
								<SelectItem value={ALL_SENTINEL}>
									{t("fieldModelAll")}
								</SelectItem>
								{availableModels.map((model) => (
									<SelectItem
										key={model.canonicalName}
										value={model.canonicalName}
									>
										{model.displayName}
									</SelectItem>
								))}
								{storedModelNotInCatalog ? (
									<SelectItem
										value={formState.modelCanonicalName}
										disabled
									>
										{t("fieldModelNotInCatalog", {
											name: formState.modelCanonicalName,
										})}
									</SelectItem>
								) : null}
							</SelectContent>
						</Select>
					</div>

					<div className="space-y-2">
						<Label htmlFor="ai-usage-limit-task-type">
							{t("fieldTaskType")}
						</Label>
						<Select
							value={formState.taskType}
							onValueChange={(value) =>
								setFormState((prev) => ({
									...prev,
									taskType: value,
								}))
							}
						>
							<SelectTrigger id="ai-usage-limit-task-type">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value={ALL_SENTINEL}>
									{t("fieldTaskTypeAll")}
								</SelectItem>
								{TASK_TYPES.map((value) => (
									<SelectItem key={value} value={value}>
										{formatTaskType(value)}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>

					{validationError ? (
						<p
							role="alert"
							className="text-sm text-destructive"
							aria-live="polite"
						>
							{validationError}
						</p>
					) : null}
					{serverError ? (
						<p
							role="alert"
							className="rounded-md border border-destructive/30 bg-destructive/5 p-2 text-sm text-destructive"
							aria-live="polite"
						>
							{serverError}
						</p>
					) : null}

					<div className="sticky bottom-0 -mx-6 mt-auto border-border/60 border-t bg-card/95 px-6 pt-4 pb-2 backdrop-blur supports-[backdrop-filter]:bg-card/80">
						<div
							className={cn(
								"flex flex-col-reverse gap-2",
								"sm:flex-row sm:items-center sm:justify-between",
							)}
						>
							{isEdit ? (
								<Button
									type="button"
									variant="ghost"
									size="sm"
									className="text-destructive hover:bg-destructive/10 hover:text-destructive"
									onClick={() => setIsDeleteOpen(true)}
									disabled={isSaving || isDeleting}
								>
									{t("deleteButton")}
								</Button>
							) : (
								<span aria-hidden="true" />
							)}
							<div className="flex gap-2 sm:justify-end">
								<Button
									type="button"
									variant="ghost"
									onClick={() => onOpenChange(false)}
									disabled={isSaving || isDeleting}
								>
									{t("cancelButton")}
								</Button>
								<Button
									type="submit"
									variant="default"
									disabled={isSaving || isDeleting}
									className="min-w-[7rem] font-medium motion-safe:transition-colors"
								>
									{isSaving ? (
										<span className="inline-flex items-center gap-2">
											<Loader2Icon
												className="size-3.5 animate-spin motion-reduce:animate-none"
												aria-hidden="true"
											/>
											{t("savingButton")}
										</span>
									) : isEdit ? (
										t("saveButton")
									) : (
										t("createButton")
									)}
								</Button>
							</div>
						</div>
					</div>
				</form>
			</SheetContent>

			<AlertDialog open={isDeleteOpen} onOpenChange={setIsDeleteOpen}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							{t("deleteConfirmTitle")}
						</AlertDialogTitle>
						<AlertDialogDescription>
							{t("deleteConfirmBody")}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel disabled={isDeleting}>
							{t("deleteConfirmCancel")}
						</AlertDialogCancel>
						<AlertDialogAction
							onClick={(event) => {
								event.preventDefault();
								handleDelete();
							}}
							disabled={isDeleting}
							variant="destructive"
						>
							{isDeleting ? (
								<span className="inline-flex items-center gap-2">
									<Loader2Icon
										className="size-3.5 animate-spin motion-reduce:animate-none"
										aria-hidden="true"
									/>
									{t("deleteConfirmConfirm")}
								</span>
							) : (
								t("deleteConfirmConfirm")
							)}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</Sheet>
	);
}

/**
 * Project dropdown for the "specific project" scope option.
 * Calls `projects.list` (the existing canonical project list procedure)
 * in the active tenant scope. Caps at the procedure's max page size (100)
 * — tenants with more than 100 projects need search/pagination, which is
 * a v2 concern; v1 ships the top-100 most-recent ordering the procedure
 * already returns.
 * Renders disabled state while the query is loading or returned zero
 * projects (the empty-list case mirrors the chokepoint's empty-tenant
 * fast path — a tenant with no projects can't pick one).
 */
/**
 * Shared query key for the project picker so the parent sheet can prefetch
 * the list on open and the picker's own `useQuery` instantly reads from
 * cache when the user later switches to project scope.
 */
const projectPickerQueryKey = (organizationId: string | null) =>
	["aiUsageLimit", "projectPicker", organizationId] as const;

const projectPickerQueryFn = (organizationId: string | null) =>
	orpcClient.projects.list({
		organizationId,
		limit: 100,
		offset: 0,
	});

function ProjectPicker({
	organizationId,
	value,
	onChange,
}: {
	organizationId: string | null;
	value: string;
	onChange: (value: string) => void;
}) {
	const t = useTranslations("settings.aiUsage.limits.sheet");

	const { data, isLoading } = useQuery({
		queryKey: projectPickerQueryKey(organizationId),
		queryFn: () => projectPickerQueryFn(organizationId),
		refetchOnWindowFocus: false,
		// Long stale time — projects rarely change during a sheet session.
		// Prefetched on sheet open by the parent so first render is instant.
		staleTime: 5 * 60_000,
	});

	const projects = data?.projects ?? [];
	const isEmpty = !isLoading && projects.length === 0;

	return (
		<Select
			value={value || undefined}
			onValueChange={onChange}
			disabled={isLoading || isEmpty}
		>
			<SelectTrigger
				id="ai-usage-limit-project"
				aria-label={t("fieldProject")}
			>
				<SelectValue
					placeholder={
						isLoading
							? t("fieldProjectLoading")
							: isEmpty
								? t("fieldProjectEmpty")
								: t("fieldProjectPlaceholder")
					}
				/>
			</SelectTrigger>
			<SelectContent>
				{projects.map((project) => (
					<SelectItem key={project.id} value={project.id}>
						{project.name}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}
