"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@ui/components/card";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { Switch } from "@ui/components/switch";
import { Textarea } from "@ui/components/textarea";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import {
	EyeIcon,
	KeyRoundIcon,
	Loader2Icon,
	PencilIcon,
	PlusIcon,
	SaveIcon,
	ScanSearchIcon,
	ShieldCheckIcon,
	ShieldIcon,
	SlidersHorizontalIcon,
	SparklesIcon,
	Trash2Icon,
} from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import { toast } from "sonner";
import {
	type EditableKnowledgePack,
	KnowledgePacksEditor,
} from "./KnowledgePacksEditor";
import {
	CATEGORY_BADGE_VARIANT,
	CATEGORY_LABEL,
	DEFAULT_SEVERITY_RUBRIC,
	ENFORCEMENT_OPTIONS,
	type EnforcementMode,
	type FeatureDraftingStage,
	MATURATION_GATE_OPTIONS,
	type ResolvedScanConfig,
	RULE_CATEGORY_OPTIONS,
	RULE_SEVERITY_OPTIONS,
	type ScanCategory,
	type ScanSeverity,
	SEVERITY_BADGE_VARIANT,
	SEVERITY_LABEL,
	SEVERITY_ORDER,
	type SeverityRubricEntry,
} from "./lib";
import { InfoHint } from "./ScanInfo";
import { SeverityRubricEditor } from "./SeverityRubricEditor";

/** Editable shape of a custom rule (id optional — server assigns for new). */
type EditableRule = {
	id?: string;
	name: string;
	category: ScanCategory;
	severity: ScanSeverity;
	guidance: string;
	enabled: boolean;
};

/** Local, fully-resolved config draft mirrored from the server config. */
type ConfigDraft = {
	securityEnabled: boolean;
	accessibilityEnabled: boolean;
	semgrepEnabled: boolean;
	gitHistoryEnabled: boolean;
	/** Run the AI false-positive review as the final scan phase (default true). */
	autoReviewFindings: boolean;
	/** Branch the repo scanners clone; empty ⇒ repository default branch. */
	scanBranch: string;
	enforcementMode: EnforcementMode;
	autoScanOnMaturation: boolean;
	maturationGate: FeatureDraftingStage;
	customRules: EditableRule[];
	severityRubric: SeverityRubricEntry[];
	securityKnowledgePacks: EditableKnowledgePack[];
};

type Props = {
	projectId: string;
	organizationId: string | null;
};

const DEFAULT_DRAFT: ConfigDraft = {
	securityEnabled: false,
	accessibilityEnabled: false,
	semgrepEnabled: false,
	gitHistoryEnabled: false,
	autoReviewFindings: true,
	scanBranch: "",
	enforcementMode: "WARN",
	autoScanOnMaturation: false,
	maturationGate: "PUBLISHED",
	customRules: [],
	severityRubric: DEFAULT_SEVERITY_RUBRIC.map((r) => ({ ...r })),
	securityKnowledgePacks: [],
};

/**
 * Normalize the server's `severityRubric` into the four fixed rows in
 * worst-first order, seeding any missing band from the CVSS-aligned defaults.
 * The server seeds the same defaults when the column is null; this keeps the
 * editor fully populated even for an older/sparse stored value.
 */
function resolveRubric(
	stored:
		| ReadonlyArray<{ severity: string; definition: string }>
		| null
		| undefined,
): SeverityRubricEntry[] {
	const bySeverity = new Map<ScanSeverity, string>();
	for (const entry of stored ?? []) {
		const sev = entry.severity as ScanSeverity;
		if (SEVERITY_ORDER.includes(sev) && entry.definition?.trim()) {
			bySeverity.set(sev, entry.definition);
		}
	}
	return SEVERITY_ORDER.map((severity) => ({
		severity,
		definition:
			bySeverity.get(severity) ??
			DEFAULT_SEVERITY_RUBRIC.find((r) => r.severity === severity)
				?.definition ??
			"",
	}));
}

/** Build a fresh draft from the server config (shared by hydrate + reset). */
function draftFromConfig(config: ResolvedScanConfig): ConfigDraft {
	return {
		securityEnabled: config.securityEnabled,
		accessibilityEnabled: config.accessibilityEnabled,
		semgrepEnabled: config.semgrepEnabled,
		gitHistoryEnabled: config.gitHistoryEnabled,
		autoReviewFindings: config.autoReviewFindings,
		scanBranch: config.scanBranch ?? "",
		enforcementMode: config.enforcementMode,
		autoScanOnMaturation: config.autoScanOnMaturation,
		maturationGate: config.maturationGate,
		customRules: config.customRules.map((r) => ({
			id: r.id,
			name: r.name,
			category: r.category,
			severity: r.severity,
			guidance: r.guidance,
			enabled: r.enabled,
		})),
		severityRubric: resolveRubric(config.severityRubric),
		securityKnowledgePacks: (config.securityKnowledgePacks ?? []).map(
			(p) => ({
				id: p.id,
				title: p.title,
				content: p.content,
				...(p.appliesTo ? { appliesTo: p.appliesTo } : {}),
			}),
		),
	};
}

export function ScanConfigCard({ projectId, organizationId }: Props) {
	const queryClient = useQueryClient();
	const headingId = useId();

	const configQuery = useQuery(
		orpc.projects.scan.config.get.queryOptions({
			input: { projectId, organizationId },
		}),
	);

	const [draft, setDraft] = useState<ConfigDraft>(DEFAULT_DRAFT);
	const [hasChanges, setHasChanges] = useState(false);
	const [ruleDialogOpen, setRuleDialogOpen] = useState(false);
	const [editingIndex, setEditingIndex] = useState<number | null>(null);
	const [deleteIndex, setDeleteIndex] = useState<number | null>(null);

	const serverConfig = configQuery.data?.config;

	// Hydrate the local draft from the server config and clear dirty state.
	useEffect(() => {
		if (!serverConfig) {
			return;
		}
		setDraft(draftFromConfig(serverConfig));
		setHasChanges(false);
	}, [serverConfig]);

	const updateMutation = useMutation(
		orpc.projects.scan.config.update.mutationOptions({
			onSuccess: () => {
				toast.success("Scan configuration saved");
				queryClient.invalidateQueries({
					queryKey: orpc.projects.scan.config.get.queryKey({
						input: { projectId, organizationId },
					}),
				});
				setHasChanges(false);
			},
			onError: (error) => {
				toast.error(`Failed to save configuration: ${error.message}`);
			},
		}),
	);

	const patch = <K extends keyof ConfigDraft>(
		key: K,
		value: ConfigDraft[K],
	) => {
		setDraft((prev) => ({ ...prev, [key]: value }));
		setHasChanges(true);
	};

	const handleSave = () => {
		updateMutation.mutate({
			projectId,
			organizationId,
			securityEnabled: draft.securityEnabled,
			accessibilityEnabled: draft.accessibilityEnabled,
			semgrepEnabled: draft.semgrepEnabled,
			gitHistoryEnabled: draft.gitHistoryEnabled,
			autoReviewFindings: draft.autoReviewFindings,
			// Free-text branch; the server trims + normalizes empty to null.
			scanBranch: draft.scanBranch,
			enforcementMode: draft.enforcementMode,
			autoScanOnMaturation: draft.autoScanOnMaturation,
			maturationGate: draft.maturationGate,
			// Send the full edited array; server assigns ids for new rules.
			customRules: draft.customRules.map((r) => ({
				...(r.id ? { id: r.id } : {}),
				name: r.name,
				category: r.category,
				severity: r.severity,
				guidance: r.guidance,
				enabled: r.enabled,
			})),
			// Severity rubric (G5): the four bands with their definitions.
			severityRubric: draft.severityRubric.map((r) => ({
				severity: r.severity,
				definition: r.definition,
			})),
			// Knowledge packs (G6): drop the temporary `new-*` ids so the
			// server assigns stable ones; keep existing ids to update in place.
			// `appliesTo` round-trips as a single category on read but the update
			// contract takes an array, so wrap it.
			securityKnowledgePacks: draft.securityKnowledgePacks.map((p) => ({
				...(p.id && !p.id.startsWith("new-") ? { id: p.id } : {}),
				title: p.title,
				content: p.content,
				...(p.appliesTo ? { appliesTo: [p.appliesTo] } : {}),
			})),
		});
	};

	const handleReset = () => {
		if (!serverConfig) {
			return;
		}
		setDraft(draftFromConfig(serverConfig));
		setHasChanges(false);
	};

	const upsertRule = (rule: EditableRule) => {
		setDraft((prev) => {
			const next = [...prev.customRules];
			if (editingIndex !== null) {
				next[editingIndex] = rule;
			} else {
				next.push(rule);
			}
			return { ...prev, customRules: next };
		});
		setHasChanges(true);
		setRuleDialogOpen(false);
		setEditingIndex(null);
	};

	const toggleRuleEnabled = (index: number, enabled: boolean) => {
		setDraft((prev) => {
			const next = [...prev.customRules];
			next[index] = { ...next[index], enabled };
			return { ...prev, customRules: next };
		});
		setHasChanges(true);
	};

	const confirmDeleteRule = () => {
		if (deleteIndex === null) {
			return;
		}
		setDraft((prev) => ({
			...prev,
			customRules: prev.customRules.filter((_, i) => i !== deleteIndex),
		}));
		setHasChanges(true);
		setDeleteIndex(null);
	};

	if (configQuery.isLoading) {
		return (
			<div
				className="h-72 animate-pulse rounded-lg border border-border bg-muted"
				aria-hidden="true"
			/>
		);
	}

	return (
		<section
			aria-labelledby={headingId}
			data-onboarding-target="security-scan-config"
		>
			<Card className="bg-card">
				<CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
					<div className="min-w-0 space-y-1.5">
						<CardTitle
							id={headingId}
							className="flex items-center gap-2 text-lg"
						>
							<SlidersHorizontalIcon
								aria-hidden="true"
								className="size-4 text-primary"
							/>
							Configuration
						</CardTitle>
						<CardDescription>
							Choose which scanners run, how findings are
							enforced, and add your own project-specific rules.
						</CardDescription>
					</div>
					<div className="flex shrink-0 items-center gap-2">
						{hasChanges && (
							<Button
								variant="outline"
								size="sm"
								onClick={handleReset}
								disabled={updateMutation.isPending}
							>
								Reset
							</Button>
						)}
						<Button
							size="sm"
							onClick={handleSave}
							disabled={!hasChanges || updateMutation.isPending}
							className="gap-2"
						>
							{updateMutation.isPending ? (
								<Loader2Icon
									aria-hidden="true"
									className="size-4 motion-safe:animate-spin"
								/>
							) : (
								<SaveIcon
									aria-hidden="true"
									className="size-4"
								/>
							)}
							{updateMutation.isPending
								? "Saving…"
								: "Save changes"}
						</Button>
					</div>
				</CardHeader>

				<CardContent className="space-y-6">
					{hasChanges && (
						<output className="text-highlight text-xs">
							You have unsaved changes.
						</output>
					)}

					{/* Scanner toggles — security, accessibility, and Semgrep in one row */}
					<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
						<ToggleRow
							icon={
								<ShieldIcon
									aria-hidden="true"
									className="size-4 text-primary"
								/>
							}
							title="Security scanning"
							description="Detect vulnerabilities against OWASP Top 10 and your custom rules."
							checked={draft.securityEnabled}
							onCheckedChange={(v) => patch("securityEnabled", v)}
							ariaLabel="Toggle security scanning"
							info={
								<InfoHint label="About security scanning" wide>
									<p className="text-foreground">
										<span className="font-medium">
											Security scanning
										</span>{" "}
										reviews your features and documents for
										security vulnerabilities and exposures,
										using the{" "}
										<span className="font-medium">
											OWASP Top 10 (2021)
										</span>{" "}
										as the rule set — plus any custom rules
										you add. (When the Semgrep toggle is on
										and a repository is connected, it also
										scans real code.)
									</p>
									<p className="app-editorial-label mt-3 mb-1.5">
										OWASP Top 10 (2021)
									</p>
									<ul className="space-y-1.5">
										<li>
											<span className="font-medium text-foreground">
												A01 Broken Access Control
											</span>{" "}
											— users acting outside their
											intended permissions (e.g. viewing
											or editing others’ data).
										</li>
										<li>
											<span className="font-medium text-foreground">
												A02 Cryptographic Failures
											</span>{" "}
											— sensitive data exposed through
											weak or missing encryption, in
											transit or at rest.
										</li>
										<li>
											<span className="font-medium text-foreground">
												A03 Injection
											</span>{" "}
											— untrusted input executed as SQL,
											commands, LDAP, or XSS.
										</li>
										<li>
											<span className="font-medium text-foreground">
												A04 Insecure Design
											</span>{" "}
											— missing security controls baked in
											at the design stage.
										</li>
										<li>
											<span className="font-medium text-foreground">
												A05 Security Misconfiguration
											</span>{" "}
											— insecure defaults, open ports,
											verbose errors, missing hardening.
										</li>
										<li>
											<span className="font-medium text-foreground">
												A06 Vulnerable &amp; Outdated
												Components
											</span>{" "}
											— known-vulnerable libraries or
											dependencies.
										</li>
										<li>
											<span className="font-medium text-foreground">
												A07 Identification &amp;
												Authentication Failures
											</span>{" "}
											— weak auth, credential stuffing,
											broken session handling.
										</li>
										<li>
											<span className="font-medium text-foreground">
												A08 Software &amp; Data
												Integrity Failures
											</span>{" "}
											— unverified updates/CI-CD, insecure
											deserialization.
										</li>
										<li>
											<span className="font-medium text-foreground">
												A09 Security Logging &amp;
												Monitoring Failures
											</span>{" "}
											— breaches that go undetected for
											lack of logging/alerting.
										</li>
										<li>
											<span className="font-medium text-foreground">
												A10 Server-Side Request Forgery
												(SSRF)
											</span>{" "}
											— the server tricked into calling
											attacker-controlled URLs.
										</li>
									</ul>
								</InfoHint>
							}
						/>
						<ToggleRow
							icon={
								<EyeIcon
									aria-hidden="true"
									className="size-4 text-primary"
								/>
							}
							title="Accessibility scanning"
							description="Check features against WCAG 2.1 AA and your custom rules."
							checked={draft.accessibilityEnabled}
							onCheckedChange={(v) =>
								patch("accessibilityEnabled", v)
							}
							ariaLabel="Toggle accessibility scanning"
							info={
								<InfoHint
									label="About accessibility scanning"
									wide
								>
									<p className="text-foreground">
										<span className="font-medium">
											Accessibility scanning
										</span>{" "}
										checks the UI described in your features
										and documents against{" "}
										<span className="font-medium">
											WCAG 2.1 Level AA
										</span>{" "}
										— the Web Content Accessibility
										Guidelines that accessibility laws (ADA,
										US Section 508, EU EN 301 549) reference
										— plus any custom rules.
									</p>
									<p className="app-editorial-label mt-3 mb-1.5">
										The four principles (POUR)
									</p>
									<ul className="space-y-1.5">
										<li>
											<span className="font-medium text-foreground">
												Perceivable
											</span>{" "}
											— content everyone can perceive:
											text alternatives (1.1), adaptable
											structure (1.3), sufficient color
											contrast and not relying on color
											alone (1.4).
										</li>
										<li>
											<span className="font-medium text-foreground">
												Operable
											</span>{" "}
											— usable without a mouse: full
											keyboard access with no traps (2.1),
											visible focus and clear navigation,
											headings &amp; labels (2.4).
										</li>
										<li>
											<span className="font-medium text-foreground">
												Understandable
											</span>{" "}
											— readable and predictable:
											consistent behavior on input (3.2),
											labelled fields, error
											identification and help (3.3).
										</li>
										<li>
											<span className="font-medium text-foreground">
												Robust
											</span>{" "}
											— works with assistive tech: correct
											name, role, value and announced
											status messages (4.1).
										</li>
									</ul>
									<p className="mt-3">
										<span className="font-medium text-foreground">
											Level AA
										</span>{" "}
										is the middle conformance tier (A &lt;
										AA &lt; AAA) and the one most
										organizations and regulations require.
									</p>
								</InfoHint>
							}
						/>
						{/* Semgrep SAST — real code-level scan over the repo */}
						<ToggleRow
							icon={
								<ScanSearchIcon
									aria-hidden="true"
									className="size-4 text-primary"
								/>
							}
							title="Scan repository code with Semgrep (SAST)"
							description="Run Semgrep static analysis over your connected repository for real code-level findings. Only runs when a repository is connected."
							checked={draft.semgrepEnabled}
							onCheckedChange={(v) => patch("semgrepEnabled", v)}
							ariaLabel="Toggle Semgrep repository code scanning"
							info={
								<InfoHint label="About Semgrep code scanning">
									<p>
										Semgrep is an industry static
										application security testing (SAST)
										engine. When enabled, a project scan
										clones your{" "}
										<span className="font-medium text-foreground">
											connected repository
										</span>{" "}
										and runs Semgrep's default + OWASP Top
										10 rule packs over the source for real,
										code-level findings.
									</p>
									<p className="mt-1.5">
										Connect a repository under{" "}
										<span className="font-medium text-foreground">
											Settings → Repository
										</span>
										. Without one, this toggle has no effect
										and only the AI review of your docs and
										features runs.
									</p>
								</InfoHint>
							}
						/>
						{/* Git-history secret scan (gitleaks) — the 4th repo-based
						    scanner, in the top scanner row. */}
						<ToggleRow
							icon={
								<KeyRoundIcon
									aria-hidden="true"
									className="size-4 text-primary"
								/>
							}
							title="Scan git history for secrets (gitleaks)"
							description="Deep-scan your connected repository's entire commit history for credentials that were committed and later removed. Heavier than the code scan — it clones the full history."
							checked={draft.gitHistoryEnabled}
							onCheckedChange={(v) =>
								patch("gitHistoryEnabled", v)
							}
							ariaLabel="Toggle git-history secret scanning"
							info={
								<InfoHint
									label="About git-history secret scanning"
									wide
								>
									<p>
										The Semgrep code scan only sees your{" "}
										<span className="font-medium text-foreground">
											current
										</span>{" "}
										files. This deep scan clones the{" "}
										<span className="font-medium text-foreground">
											full git history
										</span>{" "}
										and runs{" "}
										<span className="font-mono">
											gitleaks
										</span>{" "}
										over every commit to catch secrets that
										were committed and later deleted — which
										the working-tree scan can’t see.
									</p>
									<p className="mt-1.5">
										A credential committed even once should
										be treated as compromised. Because it
										clones the whole history it’s slower, so
										leave it off unless you want the deeper
										check. Needs a{" "}
										<span className="font-medium text-foreground">
											connected repository
										</span>
										.
									</p>
									<p className="mt-1.5">
										<span className="font-medium text-foreground">
											Safe:
										</span>{" "}
										gitleaks runs with redaction and every
										finding is scrubbed again before it’s
										saved — the finding records the rule and
										location, never the secret. The clone is
										deleted after the scan.
									</p>
								</InfoHint>
							}
						/>
					</div>

					{/* AI false-positive review — the final scan phase. Not a
					    scanner engine; it triages the findings the scanners
					    produce, so it sits below the engine row on its own. */}
					<ToggleRow
						icon={
							<SparklesIcon
								aria-hidden="true"
								className="size-4 text-primary"
							/>
						}
						title="Auto-review findings (AI false-positive triage)"
						description="After each scan, an adversarial AI reviewer auto-dismisses likely false positives (reversibly) and keeps confirmed findings visible. Best-effort — never blocks or fails a scan."
						checked={draft.autoReviewFindings}
						onCheckedChange={(v) => patch("autoReviewFindings", v)}
						ariaLabel="Toggle automatic AI false-positive review of findings"
						info={
							<InfoHint
								label="About auto-review of findings"
								wide
							>
								<p className="text-foreground">
									<span className="font-medium">
										Auto-review
									</span>{" "}
									runs an{" "}
									<span className="font-medium">
										adversarial AI reviewer
									</span>{" "}
									as the final phase of every scan. It
									re-examines the findings the scanners
									produced — grounded in the real code or
									quoted evidence that triggered each rule —
									and{" "}
									<span className="font-medium">
										auto-dismisses
									</span>{" "}
									the ones it judges to be false positives,
									while leaving confirmed findings visible.
								</p>
								<p className="mt-1.5">
									To stay cheap it uses a cost-aware, smaller
									model tier and only reviews the{" "}
									<span className="font-medium text-foreground">
										ambiguous confidence band
									</span>{" "}
									— not every finding.
								</p>
								<p className="mt-1.5">
									Every auto-dismissal is{" "}
									<span className="font-medium text-foreground">
										reversible
									</span>{" "}
									— it's an ordinary Dismissed status you can
									Reopen, and each one is recorded in History.
									It's{" "}
									<span className="font-medium text-foreground">
										best-effort
									</span>
									: it never blocks or fails a scan, and the
									default findings view already collapses
									low-confidence noise on its own even with
									this off.
								</p>
							</InfoHint>
						}
					/>

					{/* Scan branch: which branch the repo-based scanners clone. */}
					<div className="grid gap-2">
						<div className="flex items-center gap-1.5">
							<Label htmlFor={`${headingId}-branch`}>
								Scan branch
							</Label>
							<InfoHint label="About the scan branch">
								<p>
									Choose the branch that the{" "}
									<span className="font-medium text-foreground">
										Semgrep code scan
									</span>{" "}
									and{" "}
									<span className="font-medium text-foreground">
										Git history secret scan
									</span>{" "}
									will analyze.
								</p>
								<p className="mt-1.5">
									Leave blank to use the repository&apos;s
									default branch. Switching it scopes the
									results below to that branch&apos;s latest
									scan.
								</p>
							</InfoHint>
						</div>
						<Input
							id={`${headingId}-branch`}
							value={draft.scanBranch}
							onChange={(e) =>
								patch("scanBranch", e.target.value)
							}
							maxLength={255}
							placeholder="Repository default branch"
							className="w-full sm:max-w-sm"
							aria-describedby={`${headingId}-branch-help`}
						/>
						<p
							id={`${headingId}-branch-help`}
							className="text-muted-foreground text-xs"
						>
							Which branch the code + git-history scanners clone.
							Leave blank to use the repository&apos;s default
							branch.
						</p>
					</div>

					{/* Privacy: secrets are never stored */}
					<div className="flex items-start gap-2.5 rounded-lg border border-secondary/30 bg-secondary/5 px-4 py-3">
						<ShieldCheckIcon
							aria-hidden="true"
							className="mt-0.5 size-4 shrink-0 text-secondary"
						/>
						<p className="text-muted-foreground text-xs leading-relaxed">
							<span className="font-medium text-foreground">
								Your secrets aren’t stored in findings.
							</span>{" "}
							Findings describe the issue, never the secret — any
							credential, API key, or token found in your
							documents or code is automatically redacted before a
							finding is saved. The saved finding keeps only the
							issue text, severity, remediation, and the rule. The
							Semgrep and git-history scans clone your repository
							to a temporary folder and delete it after scanning,
							so the scan keeps no source. This is about the
							scan’s own findings — it doesn’t change what other
							Fabric features (code indexing, documents, meeting
							transcripts) already store.
						</p>
					</div>

					{/* Enforcement mode */}
					<div className="grid gap-2">
						<div className="flex items-center gap-1.5">
							<Label htmlFor={`${headingId}-enforcement`}>
								Enforcement mode
							</Label>
							<InfoHint label="About enforcement mode">
								<p>
									<span className="font-medium text-foreground">
										Warn (non-blocking)
									</span>{" "}
									surfaces findings without stopping a feature
									from progressing — the recommended default.
								</p>
								<p className="mt-1.5">
									<span className="font-medium text-foreground">
										Block
									</span>{" "}
									is{" "}
									<span className="font-medium text-foreground">
										automatic
									</span>
									: every scan{" "}
									<span className="font-medium text-foreground">
										blocks each work item a finding is tied
										to
									</span>
									, using the finding as the reason. The block{" "}
									<span className="font-medium text-foreground">
										stays until you remove it manually
									</span>{" "}
									— a re-scan won’t overwrite a reason you’ve
									set, and switching back to Warn stops new
									auto-blocks (existing ones remain).
								</p>
								<p className="mt-1.5">
									You can also block a work item{" "}
									<span className="font-medium text-foreground">
										manually
									</span>
									in either mode: open a finding and use{" "}
									<span className="font-medium text-foreground">
										Block F-XXX
									</span>
									, or block it from the work-item page. The
									finding becomes the reason (shown on hover),
									and every block / unblock is recorded in the
									work item’s{" "}
									<span className="font-medium text-foreground">
										version history
									</span>
									.
								</p>
							</InfoHint>
						</div>
						<Select
							value={draft.enforcementMode}
							onValueChange={(v) =>
								patch("enforcementMode", v as EnforcementMode)
							}
						>
							<SelectTrigger
								id={`${headingId}-enforcement`}
								className="w-full sm:max-w-sm"
							>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{ENFORCEMENT_OPTIONS.map((opt) => (
									<SelectItem
										key={opt.value}
										value={opt.value}
									>
										{opt.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						<p className="text-muted-foreground text-xs">
							{
								ENFORCEMENT_OPTIONS.find(
									(o) => o.value === draft.enforcementMode,
								)?.description
							}
						</p>
					</div>

					{/* Auto-scan on maturation */}
					<div className="space-y-3 rounded-lg border border-border bg-muted/40 p-4">
						<ToggleRow
							title="Auto-scan at maturation gate"
							description="Automatically run a scan when a feature reaches the selected drafting stage."
							checked={draft.autoScanOnMaturation}
							onCheckedChange={(v) =>
								patch("autoScanOnMaturation", v)
							}
							ariaLabel="Toggle auto-scan when a feature reaches its maturation gate"
							bare
						/>
						<div className="grid gap-2">
							<div className="flex items-center gap-1.5">
								<Label htmlFor={`${headingId}-gate`}>
									Maturation gate
								</Label>
								<InfoHint label="About the maturation gate">
									<p>
										When auto-scan is on, a feature reaching
										this drafting stage triggers a focused
										scan of just that feature.
									</p>
									<p className="mt-1.5">
										Stages run from early (Placeholder) to
										final (Published). Pick the point at
										which a feature is mature enough to be
										worth scanning.
									</p>
								</InfoHint>
							</div>
							<Select
								value={draft.maturationGate}
								onValueChange={(v) =>
									patch(
										"maturationGate",
										v as FeatureDraftingStage,
									)
								}
								disabled={!draft.autoScanOnMaturation}
							>
								<SelectTrigger
									id={`${headingId}-gate`}
									className="w-full sm:max-w-sm"
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{MATURATION_GATE_OPTIONS.map((opt) => (
										<SelectItem
											key={opt.value}
											value={opt.value}
										>
											{opt.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
					</div>

					{/* Custom rules manager */}
					<div className="space-y-3">
						<div className="flex items-center justify-between gap-3">
							<div className="min-w-0">
								<div className="flex items-center gap-1.5">
									<p className="font-medium text-sm">
										Custom rules
									</p>
									<InfoHint label="About custom rules">
										<p>
											Project-specific checks applied
											alongside the OWASP Top 10 and WCAG
											2.1 AA rule sets.
										</p>
										<p className="mt-1.5">
											A finding from one of your rules is
											tagged with a{" "}
											<span className="font-medium text-foreground">
												Custom rule
											</span>{" "}
											badge and attributed as{" "}
											<span className="font-medium text-foreground">
												Custom: &lt;name&gt;
											</span>
											, so you always know which rule
											produced it.
										</p>
										<p className="mt-1.5 text-foreground">
											Applies on the next scan; existing
											findings remain unchanged.
										</p>
									</InfoHint>
								</div>
								<p className="text-muted-foreground text-xs">
									Project-specific checks the scanner enforces
									alongside the standard rule sets.
								</p>
							</div>
							<Button
								variant="outline"
								size="sm"
								className="gap-1.5"
								onClick={() => {
									setEditingIndex(null);
									setRuleDialogOpen(true);
								}}
							>
								<PlusIcon
									aria-hidden="true"
									className="size-4"
								/>
								Add rule
							</Button>
						</div>

						{draft.customRules.length === 0 ? (
							<p className="rounded-lg border border-dashed border-border bg-muted/30 px-4 py-6 text-center text-muted-foreground text-sm">
								No custom rules yet. Add one to enforce a check
								unique to this project.
							</p>
						) : (
							<ul className="space-y-2">
								{draft.customRules.map((rule, index) => (
									<li
										key={rule.id ?? `new-${index}`}
										className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-border bg-background p-3"
									>
										<div className="min-w-0 space-y-1.5">
											<div className="flex flex-wrap items-center gap-2">
												<span className="font-medium text-sm">
													{rule.name}
												</span>
												<Badge
													variant={
														CATEGORY_BADGE_VARIANT[
															rule.category
														]
													}
												>
													{
														CATEGORY_LABEL[
															rule.category
														]
													}
												</Badge>
												<Badge
													variant={
														SEVERITY_BADGE_VARIANT[
															rule.severity
														]
													}
												>
													{
														SEVERITY_LABEL[
															rule.severity
														]
													}
												</Badge>
											</div>
											<p className="max-w-prose break-words text-muted-foreground text-xs">
												{rule.guidance}
											</p>
										</div>
										<div className="flex shrink-0 items-center gap-1">
											<Tooltip>
												<TooltipTrigger asChild>
													<span className="inline-flex">
														<Switch
															checked={
																rule.enabled
															}
															onCheckedChange={(
																v,
															) =>
																toggleRuleEnabled(
																	index,
																	v,
																)
															}
															aria-label={`Toggle rule ${rule.name}`}
														/>
													</span>
												</TooltipTrigger>
												<TooltipContent>
													{rule.enabled
														? "Enabled"
														: "Disabled"}
												</TooltipContent>
											</Tooltip>
											<Tooltip>
												<TooltipTrigger asChild>
													<Button
														variant="ghost"
														size="icon"
														aria-label={`Edit rule ${rule.name}`}
														onClick={() => {
															setEditingIndex(
																index,
															);
															setRuleDialogOpen(
																true,
															);
														}}
													>
														<PencilIcon
															aria-hidden="true"
															className="size-4"
														/>
													</Button>
												</TooltipTrigger>
												<TooltipContent>
													Edit
												</TooltipContent>
											</Tooltip>
											<Tooltip>
												<TooltipTrigger asChild>
													<Button
														variant="ghost"
														size="icon"
														aria-label={`Delete rule ${rule.name}`}
														onClick={() =>
															setDeleteIndex(
																index,
															)
														}
													>
														<Trash2Icon
															aria-hidden="true"
															className="size-4 text-destructive"
														/>
													</Button>
												</TooltipTrigger>
												<TooltipContent>
													Delete
												</TooltipContent>
											</Tooltip>
										</div>
									</li>
								))}
							</ul>
						)}
					</div>

					{/* Severity rubric (G5) — define what each band means. */}
					<div className="border-border/60 border-t pt-6">
						<SeverityRubricEditor
							rubric={draft.severityRubric}
							disabled={updateMutation.isPending}
							onChange={(next) => patch("severityRubric", next)}
						/>
					</div>

					{/* Knowledge packs (G6) — optional extra scanner context. */}
					<div className="border-border/60 border-t pt-6">
						<KnowledgePacksEditor
							packs={draft.securityKnowledgePacks}
							disabled={updateMutation.isPending}
							onChange={(next) =>
								patch("securityKnowledgePacks", next)
							}
						/>
					</div>
				</CardContent>
			</Card>

			<RuleEditorDialog
				open={ruleDialogOpen}
				onOpenChange={(open) => {
					setRuleDialogOpen(open);
					if (!open) {
						setEditingIndex(null);
					}
				}}
				initialRule={
					editingIndex !== null
						? draft.customRules[editingIndex]
						: null
				}
				onSubmit={upsertRule}
			/>

			<AlertDialog
				open={deleteIndex !== null}
				onOpenChange={(open) => {
					if (!open) {
						setDeleteIndex(null);
					}
				}}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Delete custom rule?</AlertDialogTitle>
						<AlertDialogDescription>
							This removes the rule from the draft. It is deleted
							permanently when you save your configuration.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction onClick={confirmDeleteRule}>
							Delete
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</section>
	);
}

function ToggleRow({
	icon,
	title,
	description,
	checked,
	onCheckedChange,
	ariaLabel,
	info,
	bare = false,
}: {
	icon?: React.ReactNode;
	title: string;
	description: string;
	checked: boolean;
	onCheckedChange: (value: boolean) => void;
	ariaLabel: string;
	/** Optional inline (i) popover rendered next to the title. */
	info?: React.ReactNode;
	bare?: boolean;
}) {
	return (
		<div
			className={cn(
				"flex items-start justify-between gap-3",
				!bare && "rounded-lg border border-border bg-background p-4",
			)}
		>
			<div className="flex min-w-0 items-start gap-3">
				{icon && <div className="mt-0.5 shrink-0">{icon}</div>}
				<div className="min-w-0">
					<div className="flex items-center gap-1.5">
						<p className="font-medium text-sm">{title}</p>
						{info}
					</div>
					<p className="break-words text-muted-foreground text-xs">
						{description}
					</p>
				</div>
			</div>
			<Switch
				checked={checked}
				onCheckedChange={onCheckedChange}
				aria-label={ariaLabel}
			/>
		</div>
	);
}

function RuleEditorDialog({
	open,
	onOpenChange,
	initialRule,
	onSubmit,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	initialRule: EditableRule | null;
	onSubmit: (rule: EditableRule) => void;
}) {
	const fieldId = useId();
	const [name, setName] = useState("");
	const [category, setCategory] = useState<ScanCategory>("SECURITY");
	const [severity, setSeverity] = useState<ScanSeverity>("MEDIUM");
	const [guidance, setGuidance] = useState("");

	// Reset fields whenever the dialog opens (new vs editing).
	useEffect(() => {
		if (!open) {
			return;
		}
		setName(initialRule?.name ?? "");
		setCategory(initialRule?.category ?? "SECURITY");
		setSeverity(initialRule?.severity ?? "MEDIUM");
		setGuidance(initialRule?.guidance ?? "");
	}, [open, initialRule]);

	const trimmedName = name.trim();
	const trimmedGuidance = guidance.trim();
	const isValid = useMemo(
		() => trimmedName.length > 0 && trimmedGuidance.length > 0,
		[trimmedName, trimmedGuidance],
	);

	const handleSubmit = () => {
		if (!isValid) {
			return;
		}
		onSubmit({
			...(initialRule?.id ? { id: initialRule.id } : {}),
			name: trimmedName,
			category,
			severity,
			guidance: trimmedGuidance,
			enabled: initialRule?.enabled ?? true,
		});
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>
						{initialRule ? "Edit custom rule" : "Add custom rule"}
					</DialogTitle>
					<DialogDescription>
						Describe the check and the guidance the scanner should
						apply.
					</DialogDescription>
				</DialogHeader>

				<div className="space-y-4 py-2">
					<div className="grid gap-2">
						<Label htmlFor={`${fieldId}-name`}>Rule name</Label>
						<Input
							id={`${fieldId}-name`}
							value={name}
							onChange={(e) => setName(e.target.value)}
							maxLength={120}
							placeholder="e.g. No secrets in client-side config"
						/>
					</div>
					<div className="grid gap-4 sm:grid-cols-2">
						<div className="grid gap-2">
							<Label htmlFor={`${fieldId}-category`}>
								Category
							</Label>
							<Select
								value={category}
								onValueChange={(v) =>
									setCategory(v as ScanCategory)
								}
							>
								<SelectTrigger id={`${fieldId}-category`}>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{RULE_CATEGORY_OPTIONS.map((opt) => (
										<SelectItem
											key={opt.value}
											value={opt.value}
										>
											{opt.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
						<div className="grid gap-2">
							<Label htmlFor={`${fieldId}-severity`}>
								Severity
							</Label>
							<Select
								value={severity}
								onValueChange={(v) =>
									setSeverity(v as ScanSeverity)
								}
							>
								<SelectTrigger id={`${fieldId}-severity`}>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{RULE_SEVERITY_OPTIONS.map((opt) => (
										<SelectItem
											key={opt.value}
											value={opt.value}
										>
											{opt.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
					</div>
					<div className="grid gap-2">
						<Label htmlFor={`${fieldId}-guidance`}>Guidance</Label>
						<Textarea
							id={`${fieldId}-guidance`}
							value={guidance}
							onChange={(e) => setGuidance(e.target.value)}
							maxLength={2000}
							rows={4}
							placeholder="Describe what the scanner should look for and how to remediate it."
						/>
					</div>
				</div>

				<DialogFooter>
					<Button
						variant="outline"
						onClick={() => onOpenChange(false)}
					>
						Cancel
					</Button>
					<Button onClick={handleSubmit} disabled={!isValid}>
						{initialRule ? "Save rule" : "Add rule"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
