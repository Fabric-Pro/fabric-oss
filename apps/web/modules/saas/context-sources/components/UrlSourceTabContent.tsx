"use client";

import type { KnowledgeBaseSourceCategoryValue } from "@repo/api/modules/projects/procedures/contexts/knowledge-base-category.types";
import { KNOWLEDGE_BASE_CATEGORY_OPTIONS } from "@saas/projects/lib/knowledge-base-categories";
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
import { Textarea } from "@ui/components/textarea";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import {
	AlertCircleIcon,
	CheckCircleIcon,
	CheckIcon,
	LoaderIcon,
	MinusIcon,
	PlusIcon,
	XCircleIcon,
} from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import type { UrlSourceForm } from "../hooks/use-url-source-form";
import {
	detectUrlScopeMatch,
	PROVIDER_DISPLAY_NAMES,
	parseBulkUrlLines,
	summariseBulkParse,
	URL_BULK_INVALID_PREVIEW_LIMIT,
	URL_BULK_MAX_LINES,
	URL_LABEL_MAX_LEN,
	URL_MAX_PAGES_DEFAULT,
	URL_MAX_PAGES_MAX,
	URL_MAX_PAGES_MIN,
	type UrlRefreshMode,
	type UrlScope,
	type UrlSourceFormValues,
} from "../lib/url-source";
import { CONTEXT_SOURCE_TYPE_PRESETS } from "./SourceDetailsDialog";

// ── URL Source tab content (v2) ──────────────────────────────────────────
//
// A sibling component because the form is meaningfully larger than the
// legacy two-input version. State and submit live in `useUrlSourceForm`, so
// the dialog footer (which submits every tab) reads the same values this
// form edits.
//
// Editorial aesthetic (CLAUDE.md): warm-neutral cards (`bg-card border
// border-border`), CSS-variable tokens only (`text-primary`,
// `text-muted-foreground`, `text-destructive`), no gradients, no
// `backdrop-blur`, no animated gradient blobs, no `transition-all`.

type UrlSourceTabContentProps = {
	form: UrlSourceForm;
	isLoading: boolean;
};

export function UrlSourceTabContent({
	form,
	isLoading,
}: UrlSourceTabContentProps) {
	const {
		values,
		setValues: onValuesChange,
		scopeUserOverridden,
		setScopeUserOverridden,
		errors,
		setErrors,
		// True ⇔ a crawl-capable provider (Firecrawl) is enabled.
		hasCrawlCapable,
		// True ⇔ at least one scrape-capable provider (FC / Jina / Tavily /
		// Exa) is enabled.
		hasAnyScrapeCapable,
		// The provider that *would* be picked for SINGLE_PAGE / fallback.
		scrapeProviderName,
		preflightLoading,
		noticeSettingsPath,
		noticeOverride,
		linkStatus,
		bulkMode,
		setBulkMode: onBulkModeChange,
		bulkRaw,
		setBulkRaw: onBulkRawChange,
		bulkProgress,
		bulkResults,
		// Readiness feature on ⇒ the source must be classified before it is
		// saved.
		requireKnowledgeBaseCategory: requireCategory,
		// Off where retrieval never re-fetches the page (company context).
		allowLiveRefresh,
	} = form;
	const t = useTranslations("tooltips.contextSources");
	const scopeLabelId = "url-scope-label";
	const urlErrId = "url-source-url-err";
	const labelErrId = "url-source-label-err";
	const maxPagesErrId = "url-source-maxpages-err";
	const categoryErrId = "url-source-category-err";
	const categoryOtherErrId = "url-source-category-other-err";

	// Show the warm-neutral notice card whenever the pre-flight (or the most
	// recent submit) reports "not configured". The override wins so a
	// post-submit notice persists across re-renders.
	const showNotice =
		noticeOverride !== null || (!preflightLoading && !hasAnyScrapeCapable);

	// Code drives copy. PATH_PREFIX-specific notice only triggered on submit
	// (the radio gate prevents most users from hitting it pre-submit).
	const noticeKind: "no-scrape" | "no-crawl" =
		noticeOverride?.code === "CRAWL_PROVIDER_NOT_CONFIGURED"
			? "no-crawl"
			: "no-scrape";

	// Tracks the matched pattern (e.g. "/docs/", "trailing slash") when the
	// blur auto-detect flips scope from SINGLE_PAGE to PATH_PREFIX. Cleared
	// on user override so the hint disappears the moment they pick a radio
	// manually. Local to the form sub-component because it only matters for
	// as long as the dialog stays open.
	const [scopeAutoDetectedFrom, setScopeAutoDetectedFrom] = useState<
		string | null
	>(null);

	// PATH_PREFIX requires a crawl-capable provider (Firecrawl in v1.1).
	// When none is enabled we disable the radio entirely AND make the blur
	// auto-detect fall back to SINGLE_PAGE — picking PATH_PREFIX silently
	// would produce a submit-time error that's harder to debug than a
	// disabled-from-the-start radio.
	const pathPrefixDisabled = !hasCrawlCapable;

	const handleUrlBlur = () => {
		// Auto-detect scope once on blur, unless the user has already
		// explicitly chosen a scope radio.
		if (scopeUserOverridden) {
			return;
		}
		if (!values.url.trim()) {
			return;
		}
		const { scope: detected, matchedPattern } = detectUrlScopeMatch(
			values.url.trim(),
		);
		// Fall back to SINGLE_PAGE if PATH_PREFIX is not available — the
		// user can still pick PATH_PREFIX manually (the radio explains why
		// it's disabled when they hover).
		const next: UrlScope =
			detected === "PATH_PREFIX" && pathPrefixDisabled
				? "SINGLE_PAGE"
				: detected;
		if (next !== values.scope) {
			onValuesChange({ ...values, scope: next });
			// Surface the matched pattern only when the rule flipped UP to
			// PATH_PREFIX — there's no hint to show for the SINGLE_PAGE
			// default, and we don't want a stale hint after the user clears
			// the URL and re-blurs on a plain article URL.
			setScopeAutoDetectedFrom(
				next === "PATH_PREFIX" ? matchedPattern : null,
			);
		}
	};

	const handleScopeChange = (next: UrlScope) => {
		setScopeUserOverridden(true);
		setScopeAutoDetectedFrom(null);
		onValuesChange({ ...values, scope: next });
	};

	const handleMaxPagesStep = (delta: number) => {
		const current = values.maxPages ?? URL_MAX_PAGES_DEFAULT;
		const next = Math.min(
			URL_MAX_PAGES_MAX,
			Math.max(URL_MAX_PAGES_MIN, current + delta),
		);
		onValuesChange({ ...values, maxPages: next });
	};

	const handleMaxPagesInput = (e: React.ChangeEvent<HTMLInputElement>) => {
		// Allow the field to be temporarily empty while editing; coerce on
		// blur via the validation submit.
		const raw = e.target.value;
		if (raw === "") {
			onValuesChange({ ...values, maxPages: undefined });
			return;
		}
		const n = Number.parseInt(raw, 10);
		if (Number.isNaN(n)) {
			return;
		}
		onValuesChange({ ...values, maxPages: n });
	};

	// Clear an error for a field once the user starts editing it again.
	const clearError = (key: keyof UrlSourceFormValues) => {
		if (errors[key]) {
			const { [key]: _, ...rest } = errors;
			setErrors(rest);
		}
	};

	return (
		<div
			className="space-y-4 motion-safe:animate-stagger"
			role="tabpanel"
			id="context-tabpanel-link"
			aria-labelledby="context-tab-link"
		>
			{/* Pre-flight notice — warm-neutral card. Renders when no scrape-
			    capable provider is enabled, or when the submit hit one of
			    the typed BAD_REQUEST codes (SCRAPE_/CRAWL_PROVIDER_NOT_
			    CONFIGURED, or the legacy FIRECRAWL_NOT_CONFIGURED). */}
			{showNotice && (
				<div
					className="space-y-2 rounded-lg border border-border bg-card p-4"
					role="status"
					aria-live="polite"
				>
					<div className="flex items-center gap-2">
						<span className="inline-flex items-center rounded-md border border-border bg-muted px-2 py-0.5 text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground">
							{noticeKind === "no-crawl"
								? "Crawl provider"
								: "Search provider"}
						</span>
					</div>
					<p className="text-sm text-foreground">
						{noticeKind === "no-crawl"
							? "Path-prefix crawls currently require Firecrawl. "
							: "URL sources need a search provider with scraping (Firecrawl, Jina, Tavily, or Exa). "}
						Configure one in{" "}
						<Link
							href={noticeSettingsPath}
							className="font-medium text-primary underline-offset-4 hover:underline"
						>
							Settings → Search Providers
						</Link>
						{noticeKind === "no-crawl"
							? ", or pick Single page."
							: " to start adding URLs."}
					</p>
				</div>
			)}

			{/* Mode toggle — single URL vs paste many at once (Commit 4).
			    Editorial chip style mirrors the radio cards above:
			    `bg-card border border-border`, `border-primary` when
			    active. No gradient pill, no chips. */}
			<div
				role="tablist"
				aria-label="URL entry mode"
				className="flex gap-2"
			>
				<Tooltip>
					<TooltipTrigger asChild>
						<button
							type="button"
							role="tab"
							aria-selected={bulkMode === "SINGLE"}
							onClick={() => onBulkModeChange("SINGLE")}
							disabled={isLoading}
							className={cn(
								"flex-1 rounded-lg border border-border bg-card px-3 py-2 text-sm transition-colors",
								bulkMode === "SINGLE"
									? "border-primary text-foreground"
									: "text-muted-foreground hover:text-foreground",
								isLoading && "cursor-not-allowed opacity-50",
							)}
						>
							Single URL
						</button>
					</TooltipTrigger>
					<TooltipContent>Add one URL</TooltipContent>
				</Tooltip>
				<Tooltip>
					<TooltipTrigger asChild>
						<button
							type="button"
							role="tab"
							aria-selected={bulkMode === "MULTI"}
							onClick={() => onBulkModeChange("MULTI")}
							disabled={isLoading}
							className={cn(
								"flex-1 rounded-lg border border-border bg-card px-3 py-2 text-sm transition-colors",
								bulkMode === "MULTI"
									? "border-primary text-foreground"
									: "text-muted-foreground hover:text-foreground",
								isLoading && "cursor-not-allowed opacity-50",
							)}
						>
							Multiple URLs (paste list)
						</button>
					</TooltipTrigger>
					<TooltipContent>Paste many URLs at once</TooltipContent>
				</Tooltip>
			</div>

			{/* SINGLE-URL form ─────────────────────────────────────────── */}
			{bulkMode === "SINGLE" && (
				<>
					{/* URL */}
					<div>
						<Label htmlFor="link-url">URL</Label>
						<Input
							id="link-url"
							type="url"
							placeholder="https://example.com/docs"
							value={values.url}
							onChange={(e) => {
								clearError("url");
								onValuesChange({
									...values,
									url: e.target.value,
								});
							}}
							onBlur={handleUrlBlur}
							disabled={isLoading}
							required
							aria-invalid={!!errors.url}
							aria-describedby={errors.url ? urlErrId : undefined}
							className="mt-2"
						/>
						{errors.url ? (
							<p
								id={urlErrId}
								className="mt-1 text-sm text-destructive"
								role="alert"
							>
								{errors.url}
							</p>
						) : (
							<p className="mt-1 text-muted-foreground text-sm">
								Fabric respects robots.txt, ai.txt, and
								llms.txt. Public HTTPS URLs only.
							</p>
						)}
					</div>

					{/* Source details (#1888) — optional type label + AI
					    guidance injected into prompts for this source. */}
					<div>
						<Label htmlFor="link-source-type">
							{t("sourceDetails.typeLabelOptional")}
						</Label>
						<Input
							id="link-source-type"
							placeholder={t("sourceDetails.typeAddPlaceholder")}
							value={values.sourceType ?? ""}
							maxLength={80}
							list="context-source-type-presets"
							autoComplete="off"
							onChange={(e) => {
								onValuesChange({
									...values,
									sourceType: e.target.value,
								});
							}}
							disabled={isLoading}
							className="mt-2"
						/>
						<datalist id="context-source-type-presets">
							{CONTEXT_SOURCE_TYPE_PRESETS.map((preset) => (
								<option key={preset} value={preset} />
							))}
						</datalist>
						<Label htmlFor="link-ai-instructions" className="mt-3">
							{t("sourceDetails.instructionsLabelOptional")}
						</Label>
						<Textarea
							id="link-ai-instructions"
							rows={3}
							maxLength={500}
							placeholder={t(
								"sourceDetails.instructionsAddPlaceholder",
							)}
							value={values.aiInstructions ?? ""}
							onChange={(e) => {
								onValuesChange({
									...values,
									aiInstructions: e.target.value,
								});
							}}
							disabled={isLoading}
							className="mt-2"
						/>
					</div>
					{/* Label */}
					<div>
						<Label htmlFor="link-label">Label (Optional)</Label>
						<Input
							id="link-label"
							placeholder="e.g. Zendesk Help Center"
							value={values.label ?? ""}
							maxLength={URL_LABEL_MAX_LEN}
							onChange={(e) => {
								clearError("label");
								onValuesChange({
									...values,
									label: e.target.value,
								});
							}}
							disabled={isLoading}
							aria-invalid={!!errors.label}
							aria-describedby={
								errors.label ? labelErrId : undefined
							}
							className="mt-2"
						/>
						{errors.label && (
							<p
								id={labelErrId}
								className="mt-1 text-sm text-destructive"
								role="alert"
							>
								{errors.label}
							</p>
						)}
					</div>
				</>
			)}

			{/* MULTI-URL form ────────────────────────────────────────────
			    Replaces the URL input with a textarea (one URL per line),
			    hides the optional Label field (each URL gets its scraped
			    title as label server-side), and parses lines live for a
			    live preview + per-line error listing. The scope / maxPages /
			    refresh fields below stay shared with the single-URL form
			    so the bulk submit applies them uniformly. */}
			{bulkMode === "MULTI" && (
				<BulkUrlsForm
					bulkRaw={bulkRaw}
					onBulkRawChange={onBulkRawChange}
					isLoading={isLoading}
				/>
			)}

			{/* Scope radio */}
			<div>
				<p
					id={scopeLabelId}
					className="text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground"
				>
					Crawl scope
				</p>
				<RadioGroup
					value={values.scope}
					onValueChange={(v) => handleScopeChange(v as UrlScope)}
					aria-labelledby={scopeLabelId}
					className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2"
				>
					<Tooltip delayDuration={150}>
						<TooltipTrigger asChild>
							<label
								htmlFor="url-scope-single"
								className={cn(
									"flex cursor-pointer items-start gap-2 rounded-lg border border-border bg-card p-3 text-sm",
									values.scope === "SINGLE_PAGE" &&
										"border-primary",
									isLoading &&
										"cursor-not-allowed opacity-50",
								)}
							>
								<RadioGroupItem
									value="SINGLE_PAGE"
									id="url-scope-single"
									disabled={isLoading}
									className="mt-0.5"
								/>
								<span className="block">
									<span className="block font-medium">
										Single page
									</span>
									<span className="block text-muted-foreground text-xs">
										Index only the URL you entered.
									</span>
								</span>
							</label>
						</TooltipTrigger>
						<TooltipContent>
							{t("urlSource.scopeSinglePage")}
						</TooltipContent>
					</Tooltip>
					{/* PATH_PREFIX. Disabled when no crawl-capable provider is
					    enabled (commit 3 of 3, multi-provider PR). The label is
					    wrapped in a Tooltip in that case so the reason for the
					    disable is reachable on hover / focus — matches the
					    submit-button pattern used in the dialog footer. */}
					{pathPrefixDisabled ? (
						<Tooltip>
							<TooltipTrigger asChild>
								{/* The outer span keeps the tooltip reachable
								    while the radio item itself is disabled —
								    Radix Tooltip skips pointer events on
								    disabled children. */}
								<span
									className={cn(
										"inline-flex items-start gap-2 rounded-lg border border-border bg-card p-3 text-sm opacity-60",
										"cursor-not-allowed",
									)}
									aria-label="Path-prefix scope (disabled — no crawl-capable provider configured)"
								>
									<RadioGroupItem
										value="PATH_PREFIX"
										id="url-scope-prefix"
										disabled
										aria-disabled="true"
										className="mt-0.5"
									/>
									<span className="block">
										<span className="block font-medium">
											Path-prefix
										</span>
										<span className="block text-muted-foreground text-xs">
											Crawl pages under the URL's path
											(e.g. an entire help center).
										</span>
									</span>
								</span>
							</TooltipTrigger>
							<TooltipContent>
								Path-prefix crawls require Firecrawl. Configure
								Firecrawl in Settings → Search Providers.
							</TooltipContent>
						</Tooltip>
					) : (
						<Tooltip delayDuration={150}>
							<TooltipTrigger asChild>
								<label
									htmlFor="url-scope-prefix"
									className={cn(
										"flex cursor-pointer items-start gap-2 rounded-lg border border-border bg-card p-3 text-sm",
										values.scope === "PATH_PREFIX" &&
											"border-primary",
										isLoading &&
											"cursor-not-allowed opacity-50",
									)}
								>
									<RadioGroupItem
										value="PATH_PREFIX"
										id="url-scope-prefix"
										disabled={isLoading}
										className="mt-0.5"
									/>
									<span className="block">
										<span className="block font-medium">
											Path-prefix
										</span>
										<span className="block text-muted-foreground text-xs">
											Crawl pages under the URL's path
											(e.g. an entire help center).
										</span>
									</span>
								</label>
							</TooltipTrigger>
							<TooltipContent>
								{t("urlSource.scopePathPrefix")}
							</TooltipContent>
						</Tooltip>
					)}
				</RadioGroup>
				{/* Inline auto-detect hint — names the matched pattern when
				    the blur rule flipped scope to PATH_PREFIX, so the flip
				    doesn't feel silent. Hidden once the user manually picks
				    a scope radio (urlScopeUserOverridden flag). */}
				{!scopeUserOverridden &&
					scopeAutoDetectedFrom &&
					values.scope === "PATH_PREFIX" && (
						<output
							className="mt-2 block text-xs text-muted-foreground"
							aria-live="polite"
						>
							Detected path-prefix from your URL (
							<span className="font-mono">
								{scopeAutoDetectedFrom}
							</span>
							).
						</output>
					)}
			</div>

			{/* Max pages stepper — only when scope = PATH_PREFIX */}
			{values.scope === "PATH_PREFIX" && (
				<div>
					<Label htmlFor="url-max-pages">Max pages to crawl</Label>
					<div className="mt-2 flex items-center gap-2">
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									type="button"
									variant="outline"
									size="icon"
									aria-label="Decrease max pages"
									onClick={() => handleMaxPagesStep(-10)}
									disabled={
										isLoading ||
										(values.maxPages ??
											URL_MAX_PAGES_DEFAULT) <=
											URL_MAX_PAGES_MIN
									}
								>
									<MinusIcon className="size-4" />
								</Button>
							</TooltipTrigger>
							<TooltipContent>
								Decrease by 10 (min {URL_MAX_PAGES_MIN})
							</TooltipContent>
						</Tooltip>
						<Input
							id="url-max-pages"
							type="number"
							inputMode="numeric"
							min={URL_MAX_PAGES_MIN}
							max={URL_MAX_PAGES_MAX}
							value={values.maxPages ?? ""}
							onChange={(e) => {
								clearError("maxPages");
								handleMaxPagesInput(e);
							}}
							disabled={isLoading}
							aria-invalid={!!errors.maxPages}
							aria-describedby={
								errors.maxPages ? maxPagesErrId : undefined
							}
							className="w-24 text-center"
						/>
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									type="button"
									variant="outline"
									size="icon"
									aria-label="Increase max pages"
									onClick={() => handleMaxPagesStep(10)}
									disabled={
										isLoading ||
										(values.maxPages ??
											URL_MAX_PAGES_DEFAULT) >=
											URL_MAX_PAGES_MAX
									}
								>
									<PlusIcon className="size-4" />
								</Button>
							</TooltipTrigger>
							<TooltipContent>
								Increase by 10 (max {URL_MAX_PAGES_MAX})
							</TooltipContent>
						</Tooltip>
						<span className="text-muted-foreground text-sm">
							pages
						</span>
					</div>
					{errors.maxPages ? (
						<p
							id={maxPagesErrId}
							className="mt-1 text-sm text-destructive"
							role="alert"
						>
							{errors.maxPages}
						</p>
					) : (
						<p className="mt-1 text-muted-foreground text-sm">
							Default {URL_MAX_PAGES_DEFAULT}. Range{" "}
							{URL_MAX_PAGES_MIN}–{URL_MAX_PAGES_MAX}. Raise for
							large help centers.
						</p>
					)}
				</div>
			)}

			{/* Refresh mode */}
			<div>
				<Label htmlFor="url-refresh-mode">Refresh</Label>
				<Select
					value={values.refreshMode}
					onValueChange={(v) =>
						onValuesChange({
							...values,
							refreshMode: v as UrlRefreshMode,
						})
					}
					disabled={isLoading}
				>
					<SelectTrigger
						id="url-refresh-mode"
						className="mt-2"
						aria-label="Refresh cadence"
					>
						<SelectValue placeholder="Refresh cadence" />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="ONCE">
							Once (no auto-refresh)
						</SelectItem>
						<SelectItem value="DAILY">Daily</SelectItem>
						<SelectItem value="WEEKLY">Weekly</SelectItem>
						<SelectItem value="MONTHLY">Monthly</SelectItem>
						{allowLiveRefresh && (
							<SelectItem value="LIVE">
								Live (re-fetch on each AI run)
							</SelectItem>
						)}
					</SelectContent>
				</Select>
				<p className="mt-1 text-muted-foreground text-sm">
					{allowLiveRefresh
						? "Scheduled refreshes use Temporal. Live re-fetches at retrieval time and is not cached."
						: "Scheduled refreshes use Temporal."}
				</p>
			</div>

			{/* Source category — what this link actually is. Shared by both
			    modes, like scope and refresh: a bulk paste is one kind of
			    source pasted many times.

			    Nothing is pre-selected. A default would put a guess on record
			    as the user's answer, and the project readiness checklist reads
			    this to tell a wiki from a marketing page. */}
			{requireCategory && (
				<div>
					<Label htmlFor="url-source-category">
						What kind of source is this?
					</Label>
					<Select
						value={values.knowledgeBaseSourceCategory ?? ""}
						onValueChange={(v) => {
							// Clear only this field's errors. Wiping the whole
							// map would hide a URL error the user still has to
							// fix.
							setErrors({
								...errors,
								knowledgeBaseSourceCategory: undefined,
								knowledgeBaseSourceCategoryOther: undefined,
							});
							onValuesChange({
								...values,
								knowledgeBaseSourceCategory:
									v as KnowledgeBaseSourceCategoryValue,
							});
						}}
						disabled={isLoading}
					>
						<SelectTrigger
							id="url-source-category"
							className="mt-2"
							aria-label="Knowledge base source category"
							aria-invalid={
								errors.knowledgeBaseSourceCategory
									? true
									: undefined
							}
							aria-describedby={
								errors.knowledgeBaseSourceCategory
									? categoryErrId
									: undefined
							}
						>
							<SelectValue placeholder="Select a category" />
						</SelectTrigger>
						<SelectContent>
							{KNOWLEDGE_BASE_CATEGORY_OPTIONS.map((option) => (
								<SelectItem
									key={option.value}
									value={option.value}
								>
									{option.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					{errors.knowledgeBaseSourceCategory && (
						<p
							id={categoryErrId}
							className="mt-1 text-destructive text-sm"
						>
							{errors.knowledgeBaseSourceCategory}
						</p>
					)}

					{/* "Other" on its own says nothing, so it has to be
					    described before it can be saved. */}
					{values.knowledgeBaseSourceCategory === "OTHER" && (
						<div className="mt-3">
							<Label htmlFor="url-source-category-other">
								Describe the source
							</Label>
							<Input
								id="url-source-category-other"
								className="mt-2"
								maxLength={200}
								placeholder="e.g. internal runbook"
								value={
									values.knowledgeBaseSourceCategoryOther ??
									""
								}
								onChange={(e) =>
									onValuesChange({
										...values,
										knowledgeBaseSourceCategoryOther:
											e.target.value,
									})
								}
								disabled={isLoading}
								aria-invalid={
									errors.knowledgeBaseSourceCategoryOther
										? true
										: undefined
								}
								aria-describedby={
									errors.knowledgeBaseSourceCategoryOther
										? categoryOtherErrId
										: undefined
								}
							/>
							{errors.knowledgeBaseSourceCategoryOther && (
								<p
									id={categoryOtherErrId}
									className="mt-1 text-destructive text-sm"
								>
									{errors.knowledgeBaseSourceCategoryOther}
								</p>
							)}
						</div>
					)}
				</div>
			)}

			{/* Provider indicator — names the provider that would be picked
			    server-side. PATH_PREFIX always shows Firecrawl (crawl-only
			    capability in v1.1); SINGLE_PAGE shows whatever the picker
			    would prefer. Hidden when no provider qualifies (the notice
			    card already explains that case). */}
			{(() => {
				const effectiveProvider =
					values.scope === "PATH_PREFIX"
						? "firecrawl"
						: scrapeProviderName;
				if (!effectiveProvider) {
					return null;
				}
				return (
					<p
						className="text-xs text-muted-foreground"
						data-testid="url-source-indexing-with"
					>
						Indexing with{" "}
						<span className="font-medium text-foreground">
							{PROVIDER_DISPLAY_NAMES[effectiveProvider]}
						</span>
						.
					</p>
				);
			})()}

			{/* Bulk-mode progress card — visible while N parallel processLink
			    calls are in-flight. Ticks "Adding N URLs… (M / N done)". */}
			{bulkMode === "MULTI" &&
				linkStatus === "processing" &&
				bulkProgress !== null && (
					<output className="block space-y-2 rounded-lg border border-border bg-card p-3 text-primary">
						<div className="flex items-center gap-2">
							<LoaderIcon className="size-5 motion-safe:animate-spin" />
							<span className="text-sm text-foreground">
								Adding {bulkProgress.total} URL
								{bulkProgress.total === 1 ? "" : "s"}…{" "}
								<span className="text-muted-foreground">
									({bulkProgress.submitted} /{" "}
									{bulkProgress.total} done)
								</span>
							</span>
						</div>
						<div
							className="h-2 w-full overflow-hidden rounded-full bg-border"
							role="progressbar"
							aria-valuenow={bulkProgress.submitted}
							aria-valuemin={0}
							aria-valuemax={bulkProgress.total}
						>
							<div
								className="h-full rounded-full bg-primary motion-safe:transition-[width] motion-safe:duration-300"
								style={{
									width: `${
										bulkProgress.total === 0
											? 0
											: Math.round(
													(bulkProgress.submitted /
														bulkProgress.total) *
														100,
												)
									}%`,
								}}
							/>
						</div>
					</output>
				)}

			{/* Bulk-mode post-settle summary — per-URL outcomes. Stays
			    visible after the dialog's 2s auto-close window for the
			    all-success case; failures keep it pinned indefinitely until
			    the user closes the dialog. */}
			{bulkMode === "MULTI" &&
				bulkResults !== null &&
				linkStatus !== "processing" &&
				(() => {
					const successCount = bulkResults.filter((r) => r.ok).length;
					const failureCount = bulkResults.length - successCount;
					const failures = bulkResults.filter((r) => !r.ok);
					const allOk = failureCount === 0;
					return (
						<output
							className={cn(
								"block space-y-2 rounded-lg border bg-card p-3",
								allOk
									? "border-border text-secondary"
									: "border-destructive/30 text-destructive",
							)}
						>
							<div className="flex items-center gap-2">
								{allOk ? (
									<CheckCircleIcon className="size-5" />
								) : (
									<AlertCircleIcon className="size-5" />
								)}
								<span className="text-sm text-foreground">
									<span className="font-medium">
										{successCount}
									</span>{" "}
									added.
									{failureCount > 0 && (
										<>
											{" "}
											<span className="font-medium">
												{failureCount}
											</span>{" "}
											failed.
										</>
									)}
								</span>
							</div>
							{failures.length > 0 && (
								<ul className="space-y-1 pl-7 text-xs text-muted-foreground">
									{failures
										.slice(
											0,
											URL_BULK_INVALID_PREVIEW_LIMIT,
										)
										.map((f) => (
											<li
												key={f.url}
												className="break-all"
											>
												<span className="font-mono">
													{f.url}
												</span>
												{f.error ? `: ${f.error}` : ""}
											</li>
										))}
									{failures.length >
										URL_BULK_INVALID_PREVIEW_LIMIT && (
										<li className="italic">
											…and{" "}
											{failures.length -
												URL_BULK_INVALID_PREVIEW_LIMIT}{" "}
											more.
										</li>
									)}
								</ul>
							)}
						</output>
					);
				})()}

			{/* Status indicators — match the legacy tab's UX. Single-URL
			    only; the bulk branch has its own progress + summary
			    cards above so we don't double-up. */}
			{bulkMode === "SINGLE" && linkStatus === "processing" && (
				<output className="flex items-center gap-2 rounded-lg border border-border bg-card p-3 text-primary">
					<LoaderIcon className="size-5 motion-safe:animate-spin" />
					<span>Processing started…</span>
				</output>
			)}

			{bulkMode === "SINGLE" && linkStatus === "success" && (
				<output className="flex items-center gap-2 rounded-lg border border-border bg-card p-3 text-secondary">
					<CheckCircleIcon className="size-5" />
					<span>URL source added.</span>
				</output>
			)}

			{bulkMode === "SINGLE" &&
				linkStatus === "error" &&
				!noticeOverride && (
					<div
						className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-card p-3 text-destructive"
						role="alert"
					>
						<XCircleIcon className="size-5" />
						<span>Failed to add URL source. Please try again.</span>
					</div>
				)}
		</div>
	);
}

// ── Multi-URL paste form (Commit 4) ──────────────────────────────────────
//
// Renders the textarea + live-parsed preview only. The parent
// `UrlSourceTabContent` owns the shared scope / maxPages / refresh fields
// (they apply to both modes), the submit button (which lives in the dialog
// footer), and the progress / summary cards. Keeping the textarea-specific
// markup here keeps the parent diff small.

type BulkUrlsFormProps = {
	bulkRaw: string;
	onBulkRawChange: (next: string) => void;
	isLoading: boolean;
};

function BulkUrlsForm({
	bulkRaw,
	onBulkRawChange,
	isLoading,
}: BulkUrlsFormProps) {
	// Parse on every render — the textarea is the source of truth. The
	// preview, the submit-disabled state in the footer, and the count on the
	// Add button all derive from this same `parseBulkUrlLines` call.
	const parsed = useMemo(() => parseBulkUrlLines(bulkRaw), [bulkRaw]);
	const validLines = parsed.filter((l) => l.url !== null);
	const invalidLines = parsed.filter((l) => l.url === null);
	const overLimit = validLines.length > URL_BULK_MAX_LINES;
	// Dedupe count — `parseBulkUrlLines` already collapsed
	// case/trailing-slash variants. We compare against the non-blank raw
	// line count to surface "M duplicates skipped" so users understand why
	// the preview count is lower than the lines they pasted.
	const summary = useMemo(() => summariseBulkParse(bulkRaw), [bulkRaw]);
	const duplicateCount = summary.duplicates;

	return (
		<div className="space-y-3">
			<div>
				<Label htmlFor="link-url-bulk">URLs (one per line)</Label>
				<Textarea
					id="link-url-bulk"
					placeholder={
						"https://example.com/docs/intro\nhttps://example.com/docs/api\nhttps://example.com/blog/post"
					}
					value={bulkRaw}
					onChange={(e) => onBulkRawChange(e.target.value)}
					disabled={isLoading}
					rows={6}
					className="mt-2 resize-y font-mono text-sm bg-card border border-border focus:ring-1 focus:ring-primary"
				/>
				<p className="mt-1 text-muted-foreground text-sm">
					Paste one URL per line. Same scope / refresh settings will
					apply to all of them.
				</p>
			</div>

			{/* Live-parsed preview — count + invalid-line listing. Only
			    rendered when the user has typed something; an empty
			    textarea has no preview. */}
			{parsed.length > 0 && (
				<output className="block space-y-1.5" aria-live="polite">
					{validLines.length > 0 && (
						<p className="flex items-center gap-1.5 text-xs text-muted-foreground">
							<CheckIcon className="size-3.5 text-secondary" />
							<span>
								<span className="font-medium text-foreground">
									{validLines.length}
								</span>{" "}
								URL{validLines.length === 1 ? "" : "s"} ready to
								add
							</span>
						</p>
					)}
					{duplicateCount > 0 && (
						<p className="flex items-center gap-1.5 text-xs text-muted-foreground">
							<AlertCircleIcon className="size-3.5 text-highlight" />
							<span>
								<span className="font-medium text-foreground">
									{duplicateCount}
								</span>{" "}
								duplicate
								{duplicateCount === 1 ? "" : "s"} skipped
							</span>
						</p>
					)}
					{overLimit && (
						<p className="flex items-start gap-1.5 text-xs text-destructive">
							<AlertCircleIcon className="size-3.5 mt-0.5 shrink-0" />
							<span>
								Batches are limited to {URL_BULK_MAX_LINES} URLs
								at a time. Trim the list or run this twice.
							</span>
						</p>
					)}
					{invalidLines.length > 0 && (
						<>
							<p className="flex items-center gap-1.5 text-xs text-destructive">
								<AlertCircleIcon className="size-3.5" />
								<span>
									<span className="font-medium">
										{invalidLines.length}
									</span>{" "}
									line
									{invalidLines.length === 1 ? "" : "s"}{" "}
									couldn&apos;t be parsed (see below)
								</span>
							</p>
							<ul className="space-y-0.5 pl-5 text-xs text-muted-foreground">
								{invalidLines
									.slice(0, URL_BULK_INVALID_PREVIEW_LIMIT)
									.map((line) => (
										<li
											key={`${line.lineNumber}-${line.raw}`}
											className="break-all"
										>
											line {line.lineNumber}:{" "}
											<span className="font-mono">
												&ldquo;{line.raw}&rdquo;
											</span>
											{line.error
												? ` (${line.error})`
												: ""}
										</li>
									))}
								{invalidLines.length >
									URL_BULK_INVALID_PREVIEW_LIMIT && (
									<li className="italic">
										…and{" "}
										{invalidLines.length -
											URL_BULK_INVALID_PREVIEW_LIMIT}{" "}
										more.
									</li>
								)}
							</ul>
						</>
					)}
				</output>
			)}
		</div>
	);
}
