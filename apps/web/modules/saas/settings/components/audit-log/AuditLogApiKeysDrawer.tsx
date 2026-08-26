"use client";

/**
 * AuditLogApiKeysDrawer
 *
 * Right-side Sheet that holds the audit-log REST API key management UI.
 * Replaces the previous in-page section by docking the lifecycle controls
 * into a drawer accessible from a "Manage API keys" button at the top of
 * the viewer toolbar (item 13/26).
 *
 * Sections:
 *   - Generate new key form (top of drawer)
 *   - Existing keys list with prefix masked behind dots + eye toggle,
 *     copy buttons, kebab menu (Copy ID, Rotate, Revoke, View audit
 *     trail), last-used time
 *   - Lifecycle history at the bottom (audit rows filtered to
 *     `org.api_key.*` / `account.api_key.*`)
 *   - Documentation link (Swagger UI) gated by FABRIC_PUBLIC_API_DOCS_ENABLED
 *
 * Visual style follows the CLAUDE.md design context: warm-neutral card
 * surfaces, editorial uppercase labels with `tracking-[0.2em]`, no
 * glassmorphism, no animated gradients, CSS variable tokens only.
 */

import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
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
import { formatDistanceToNow } from "date-fns";
import {
	AlertTriangleIcon,
	BookOpenIcon,
	CheckIcon,
	CopyIcon,
	EyeIcon,
	EyeOffIcon,
	KeyIcon,
	MoreHorizontalIcon,
	PlusIcon,
	RefreshCwIcon,
	ShieldIcon,
	XCircleIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { toast } from "sonner";

type ScopeName = "audit_log:read" | "audit_log:export";

interface CreateFormState {
	name: string;
	readScope: boolean;
	exportScope: boolean;
	expirationKey: "30" | "90" | "180" | "365" | "never";
}

const EXPIRATION_LABELS: Record<CreateFormState["expirationKey"], string> = {
	"30": "30 days",
	"90": "90 days",
	"180": "180 days",
	"365": "1 year",
	never: "Never (not recommended)",
};

const INITIAL_FORM: CreateFormState = {
	name: "",
	readScope: true,
	exportScope: false,
	expirationKey: "90",
};

function expirationDays(
	value: CreateFormState["expirationKey"],
): number | null {
	if (value === "never") {
		return null;
	}
	return Number.parseInt(value, 10);
}

function formatDate(date: Date | string | null): string {
	if (!date) {
		return "—";
	}
	const d = typeof date === "string" ? new Date(date) : date;
	if (Number.isNaN(d.getTime())) {
		return "—";
	}
	return d.toLocaleDateString(undefined, {
		year: "numeric",
		month: "short",
		day: "numeric",
	});
}

function lastUsedRelative(date: Date | string | null, never: string): string {
	if (!date) {
		return never;
	}
	const d = typeof date === "string" ? new Date(date) : date;
	if (Number.isNaN(d.getTime())) {
		return "—";
	}
	try {
		return formatDistanceToNow(d, { addSuffix: true });
	} catch {
		return "—";
	}
}

interface AuditLogApiKeysDrawerProps {
	mode: "organization" | "personal";
	organizationId: string | null;
	docsEnabled: boolean;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/**
	 * Invoked when the operator clicks "View audit trail" on a key row.
	 * The parent updates filters to scope the main table to that keyId
	 * (and closes the drawer).
	 */
	onViewAuditTrail?: (keyId: string) => void;
}

export function AuditLogApiKeysDrawer({
	mode,
	organizationId,
	docsEnabled,
	open,
	onOpenChange,
	onViewAuditTrail,
}: AuditLogApiKeysDrawerProps) {
	const t = useTranslations();
	const queryClient = useQueryClient();
	const [dialogOpen, setDialogOpen] = useState(false);
	const [dialogMode, setDialogMode] = useState<"form" | "show">("form");
	const [form, setForm] = useState<CreateFormState>(INITIAL_FORM);
	const [revealedKey, setRevealedKey] = useState<{
		rawKey: string;
		name: string;
		context: "created" | "rotated";
	} | null>(null);
	const [copied, setCopied] = useState(false);
	const [revealedPrefixes, setRevealedPrefixes] = useState<Set<string>>(
		() => new Set(),
	);

	const tenantArg = useMemo(
		() => ({
			organizationId: mode === "organization" ? organizationId : null,
		}),
		[mode, organizationId],
	);

	const { data: keys, isLoading } = useQuery({
		queryKey: ["audit-log", "api-keys", mode, organizationId] as const,
		queryFn: () => orpcClient.audit.apiKeys.list(tenantArg),
		staleTime: 30 * 1000,
		enabled: open,
	});

	// Lifecycle events — pull a recent slice of org.api_key.*/account.api_key.*
	// rows so operators have a single drawer view of who created / rotated /
	// revoked a key and when.
	const { data: lifecycleData } = useQuery({
		queryKey: [
			"audit-log",
			"api-keys",
			"lifecycle",
			mode,
			organizationId,
		] as const,
		queryFn: () =>
			orpcClient.audit.list({
				organizationId: organizationId ?? null,
				cursor: undefined,
				limit: 25,
				filter: {
					actions:
						mode === "organization"
							? [
									"org.api_key.created",
									"org.api_key.rotated",
									"org.api_key.revoked",
								]
							: [
									"account.api_key.created",
									"account.api_key.rotated",
									"account.api_key.revoked",
								],
				},
				sort: "newest",
			}),
		staleTime: 30 * 1000,
		enabled: open,
	});

	const createMutation = useMutation({
		mutationFn: async () => {
			const scopes: ScopeName[] = [];
			if (form.readScope) {
				scopes.push("audit_log:read");
			}
			if (form.exportScope) {
				scopes.push("audit_log:export");
			}
			if (scopes.length === 0) {
				throw new Error("At least one scope is required");
			}
			return orpcClient.audit.apiKeys.create({
				...tenantArg,
				name: form.name.trim(),
				scopes,
				expiresInDays: expirationDays(form.expirationKey),
			});
		},
		onSuccess: (data) => {
			setRevealedKey({
				rawKey: data.rawKey,
				name: data.name,
				context: "created",
			});
			setDialogMode("show");
			queryClient.invalidateQueries({
				queryKey: ["audit-log", "api-keys", mode, organizationId],
			});
			queryClient.invalidateQueries({
				queryKey: ["audit-log", "api-keys", "lifecycle"],
			});
		},
		onError: (err: unknown) => {
			const message =
				err instanceof Error ? err.message : "Failed to create API key";
			toast.error(message);
		},
	});

	const rotateMutation = useMutation({
		mutationFn: async (args: { id: string; name: string }) => {
			const result = await orpcClient.audit.apiKeys.rotate({
				...tenantArg,
				id: args.id,
			});
			return { ...result, name: args.name };
		},
		onSuccess: (data) => {
			setRevealedKey({
				rawKey: data.rawKey,
				name: data.name,
				context: "rotated",
			});
			setDialogMode("show");
			setDialogOpen(true);
			queryClient.invalidateQueries({
				queryKey: ["audit-log", "api-keys", mode, organizationId],
			});
			queryClient.invalidateQueries({
				queryKey: ["audit-log", "api-keys", "lifecycle"],
			});
		},
		onError: (err: unknown) => {
			const message =
				err instanceof Error ? err.message : "Failed to rotate API key";
			toast.error(message);
		},
	});

	const revokeMutation = useMutation({
		mutationFn: async (id: string) =>
			orpcClient.audit.apiKeys.revoke({ ...tenantArg, id }),
		onSuccess: () => {
			toast.success("API key revoked");
			queryClient.invalidateQueries({
				queryKey: ["audit-log", "api-keys", mode, organizationId],
			});
			queryClient.invalidateQueries({
				queryKey: ["audit-log", "api-keys", "lifecycle"],
			});
		},
		onError: (err: unknown) => {
			const message =
				err instanceof Error ? err.message : "Failed to revoke API key";
			toast.error(message);
		},
	});

	const handleCopy = async () => {
		if (!revealedKey) {
			return;
		}
		try {
			await navigator.clipboard.writeText(revealedKey.rawKey);
			setCopied(true);
			toast.success("Copied to clipboard");
			setTimeout(() => setCopied(false), 2500);
		} catch {
			toast.error(
				"Copy failed — select the key in the box and copy manually",
			);
		}
	};

	const copyToClipboard = async (text: string, label: string) => {
		try {
			await navigator.clipboard.writeText(text);
			toast.success(`Copied ${label}`);
		} catch {
			toast.error("Copy failed");
		}
	};

	const handleDialogChange = (open: boolean) => {
		setDialogOpen(open);
		if (!open) {
			setDialogMode("form");
			setForm(INITIAL_FORM);
			setRevealedKey(null);
			setCopied(false);
		}
	};

	const handleRevoke = (id: string, name: string) => {
		if (
			!window.confirm(
				`Revoke API key "${name}"?\n\nThis cannot be undone. Any integration using this key will stop working immediately.`,
			)
		) {
			return;
		}
		revokeMutation.mutate(id);
	};

	const handleRotate = (id: string, name: string) => {
		if (
			!window.confirm(
				`Rotate API key "${name}"?\n\nThe current value will stop working immediately. You will see the new value once and must update any integration that uses it.`,
			)
		) {
			return;
		}
		rotateMutation.mutate({ id, name });
	};

	const togglePrefix = (id: string) => {
		setRevealedPrefixes((prev) => {
			const next = new Set(prev);
			if (next.has(id)) {
				next.delete(id);
			} else {
				next.add(id);
			}
			return next;
		});
	};

	const lifecycleItems = lifecycleData?.items ?? [];

	return (
		<TooltipProvider>
			<Sheet open={open} onOpenChange={onOpenChange}>
				<SheetContent
					side="right"
					className="flex w-full max-w-3xl flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl"
					data-testid="audit-api-keys-drawer"
				>
					<SheetHeader className="flex shrink-0 flex-col items-start gap-2 border-b p-6 pb-4">
						<span className="app-editorial-label">
							{t("settings.auditLog.apiKeysDrawer.title")}
						</span>
						<SheetTitle className="font-serif text-2xl">
							{t("settings.auditLog.apiKeysDrawer.title")}
						</SheetTitle>
						<SheetDescription className="max-w-prose">
							{t("settings.auditLog.apiKeysDrawer.description")}
						</SheetDescription>
						{docsEnabled ? (
							<Button
								variant="outline"
								size="sm"
								asChild
								className="mt-1 w-fit"
							>
								<a
									href="/api/v1/docs"
									target="_blank"
									rel="noreferrer"
								>
									<BookOpenIcon className="mr-2 size-3.5" />
									{t(
										"settings.auditLog.apiKeysDrawer.docsLinkEnabled",
									)}
								</a>
							</Button>
						) : (
							<Tooltip>
								<TooltipTrigger asChild>
									<span className="mt-1 w-fit cursor-help text-xs text-muted-foreground">
										<BookOpenIcon className="mr-1 inline size-3.5" />
										Docs
									</span>
								</TooltipTrigger>
								<TooltipContent>
									{t(
										"settings.auditLog.apiKeysDrawer.docsLinkDisabled",
									)}
								</TooltipContent>
							</Tooltip>
						)}
					</SheetHeader>

					<div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-6">
						{/* Generate new key */}
						<section className="flex flex-col gap-3">
							<div className="flex items-center justify-between">
								<span className="app-editorial-label">
									{t(
										"settings.auditLog.apiKeysDrawer.newKeyHeading",
									)}
								</span>
								<Dialog
									open={dialogOpen}
									onOpenChange={handleDialogChange}
								>
									<Button
										size="sm"
										variant="default"
										onClick={() => {
											setDialogMode("form");
											setRevealedKey(null);
											setDialogOpen(true);
										}}
										data-testid="audit-create-key-button"
									>
										<PlusIcon className="mr-2 size-4" />
										Create key
									</Button>
									<DialogContent>
										{dialogMode === "form" ? (
											<>
												<DialogHeader>
													<DialogTitle>
														Create audit-log API key
													</DialogTitle>
													<DialogDescription>
														Mint a new key for the
														{mode === "organization"
															? " organization "
															: " account "}
														audit log. The raw value
														is shown once after
														creation.
													</DialogDescription>
												</DialogHeader>
												<div className="space-y-4 py-2">
													<div className="space-y-2">
														<Label htmlFor="audit-key-name">
															Name
														</Label>
														<Input
															id="audit-key-name"
															value={form.name}
															onChange={(e) =>
																setForm({
																	...form,
																	name: e
																		.target
																		.value,
																})
															}
															placeholder="e.g. SRE laptop, monitoring pipeline"
															maxLength={100}
														/>
													</div>
													<div className="space-y-2">
														<Label>Scopes</Label>
														<div className="space-y-2 rounded-md border p-3">
															<label className="flex items-start gap-3 text-sm">
																<input
																	type="checkbox"
																	className="mt-0.5"
																	checked={
																		form.readScope
																	}
																	onChange={(
																		e,
																	) =>
																		setForm(
																			{
																				...form,
																				readScope:
																					e
																						.target
																						.checked,
																			},
																		)
																	}
																/>
																<span>
																	<span className="font-medium">
																		audit_log:read
																	</span>
																	<span className="block text-xs text-muted-foreground">
																		List
																		paginated
																		events
																		from{" "}
																		<code>
																			GET
																			/api/v1/audit-log
																		</code>
																		.
																	</span>
																</span>
															</label>
															<label className="flex items-start gap-3 text-sm">
																<input
																	type="checkbox"
																	className="mt-0.5"
																	checked={
																		form.exportScope
																	}
																	onChange={(
																		e,
																	) =>
																		setForm(
																			{
																				...form,
																				exportScope:
																					e
																						.target
																						.checked,
																			},
																		)
																	}
																/>
																<span>
																	<span className="font-medium">
																		audit_log:export
																	</span>
																	<span className="block text-xs text-muted-foreground">
																		Bulk-download
																		CSV /
																		NDJSON
																		via{" "}
																		<code>
																			GET
																			/api/v1/audit-log/export
																		</code>
																		.
																		Opt-in.
																	</span>
																</span>
															</label>
														</div>
													</div>
													<div className="space-y-2">
														<Label htmlFor="audit-key-expiry">
															Expiration
														</Label>
														<Select
															value={
																form.expirationKey
															}
															onValueChange={(
																value,
															) =>
																setForm({
																	...form,
																	expirationKey:
																		value as CreateFormState["expirationKey"],
																})
															}
														>
															<SelectTrigger id="audit-key-expiry">
																<SelectValue placeholder="Choose expiration" />
															</SelectTrigger>
															<SelectContent>
																{(
																	Object.keys(
																		EXPIRATION_LABELS,
																	) as CreateFormState["expirationKey"][]
																).map((key) => (
																	<SelectItem
																		key={
																			key
																		}
																		value={
																			key
																		}
																	>
																		{
																			EXPIRATION_LABELS[
																				key
																			]
																		}
																	</SelectItem>
																))}
															</SelectContent>
														</Select>
														{form.expirationKey ===
														"never" ? (
															<div className="flex items-start gap-2 rounded-md border border-highlight/40 bg-highlight/10 p-2 text-xs text-foreground">
																<AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
																<p>
																	A
																	non-expiring
																	key is a
																	long-lived
																	credential.
																	Prefer 90 or
																	365 days and
																	rotate on
																	schedule.
																</p>
															</div>
														) : null}
													</div>
												</div>
												<DialogFooter>
													<Button
														variant="outline"
														onClick={() =>
															handleDialogChange(
																false,
															)
														}
													>
														Cancel
													</Button>
													<Button
														onClick={() =>
															createMutation.mutate()
														}
														disabled={
															createMutation.isPending ||
															form.name.trim()
																.length === 0 ||
															(!form.readScope &&
																!form.exportScope)
														}
													>
														{createMutation.isPending
															? "Creating…"
															: "Create key"}
													</Button>
												</DialogFooter>
											</>
										) : revealedKey ? (
											<>
												<DialogHeader>
													<DialogTitle>
														API key{" "}
														{revealedKey.context ===
														"rotated"
															? "rotated"
															: "created"}
													</DialogTitle>
													<DialogDescription>
														<span className="font-medium">
															{revealedKey.name}
														</span>{" "}
														— copy the key now. It
														will not be shown again.
														The old value (if any)
														stopped working
														immediately.
													</DialogDescription>
												</DialogHeader>
												<div className="space-y-3 py-2">
													<div className="rounded-md border bg-muted p-3">
														<code className="block break-all font-mono text-xs">
															{revealedKey.rawKey}
														</code>
													</div>
													<Button
														className="w-full"
														onClick={handleCopy}
													>
														{copied ? (
															<>
																<CheckIcon className="mr-2 size-4" />
																Copied
															</>
														) : (
															<>
																<CopyIcon className="mr-2 size-4" />
																Copy to
																clipboard
															</>
														)}
													</Button>
													<div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs">
														<ShieldIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
														<p>
															Store this value in
															a password manager
															or your CI's secrets
															store. Fabric only
															persists the SHA-256
															hash; the raw value
															is not retrievable
															later.
														</p>
													</div>
												</div>
												<DialogFooter>
													<Button
														onClick={() =>
															handleDialogChange(
																false,
															)
														}
													>
														Done
													</Button>
												</DialogFooter>
											</>
										) : null}
									</DialogContent>
								</Dialog>
							</div>
						</section>

						{/* Existing keys */}
						<section className="flex flex-col gap-3">
							<span className="app-editorial-label">
								{t(
									"settings.auditLog.apiKeysDrawer.existingKeysHeading",
								)}
							</span>
							<div className="rounded-md border bg-card">
								{isLoading ? (
									<div className="p-4 text-sm text-muted-foreground">
										Loading keys…
									</div>
								) : keys && keys.length > 0 ? (
									<ul
										className="divide-y divide-border/60"
										data-testid="audit-api-keys-list"
									>
										{keys.map((k) => {
											const revealed =
												revealedPrefixes.has(k.id);
											return (
												<li
													key={k.id}
													className={cn(
														"flex flex-col gap-2 p-4",
														k.isActive
															? undefined
															: "opacity-60",
													)}
												>
													<div className="flex items-start justify-between gap-3">
														<div className="flex min-w-0 flex-col gap-1">
															<div className="flex items-center gap-2">
																<KeyIcon className="size-4 text-muted-foreground" />
																<span className="truncate font-medium">
																	{k.name}
																</span>
																{k.isActive ? (
																	<Badge
																		variant="secondary"
																		className="bg-secondary/15 text-foreground"
																	>
																		{t(
																			"settings.auditLog.apiKeysDrawer.statusActive",
																		)}
																	</Badge>
																) : (
																	<Badge variant="outline">
																		{t(
																			"settings.auditLog.apiKeysDrawer.statusRevoked",
																		)}
																	</Badge>
																)}
															</div>
															<div className="flex items-center gap-1">
																<code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
																	{revealed
																		? k.keyPrefix
																		: "••••••••••••"}
																	…
																</code>
																<Button
																	variant="ghost"
																	size="icon"
																	className="h-6 w-6"
																	aria-label={
																		revealed
																			? t(
																					"settings.auditLog.apiKeysDrawer.hideSecret",
																				)
																			: t(
																					"settings.auditLog.apiKeysDrawer.showSecret",
																				)
																	}
																	onClick={() =>
																		togglePrefix(
																			k.id,
																		)
																	}
																>
																	{revealed ? (
																		<EyeOffIcon className="size-3.5" />
																	) : (
																		<EyeIcon className="size-3.5" />
																	)}
																</Button>
																<Button
																	variant="ghost"
																	size="icon"
																	className="h-6 w-6"
																	aria-label={t(
																		"settings.auditLog.apiKeysDrawer.copyPrefix",
																	)}
																	onClick={() =>
																		copyToClipboard(
																			k.keyPrefix,
																			"prefix",
																		)
																	}
																>
																	<CopyIcon className="size-3.5" />
																</Button>
															</div>
															<div className="flex flex-wrap gap-1">
																{k.scopes
																	.filter(
																		(s) =>
																			s ===
																				"audit_log:read" ||
																			s ===
																				"audit_log:export" ||
																			s ===
																				"*",
																	)
																	.map(
																		(s) => (
																			<Badge
																				key={
																					s
																				}
																				variant="secondary"
																				className="font-mono text-[10px]"
																			>
																				{
																					s
																				}
																			</Badge>
																		),
																	)}
															</div>
															<div className="mt-1 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground sm:grid-cols-3">
																<span>
																	Created{" "}
																	<span className="text-foreground">
																		{formatDate(
																			k.createdAt,
																		)}
																	</span>
																</span>
																<span>
																	Expires{" "}
																	<span className="text-foreground">
																		{k.expiresAt
																			? formatDate(
																					k.expiresAt,
																				)
																			: t(
																					"settings.auditLog.apiKeysDrawer.never",
																				)}
																	</span>
																</span>
																<span>
																	{t(
																		"settings.auditLog.apiKeysDrawer.lastUsed",
																	)}{" "}
																	<span className="text-foreground">
																		{lastUsedRelative(
																			k.lastUsedAt,
																			t(
																				"settings.auditLog.apiKeysDrawer.never",
																			),
																		)}
																	</span>
																</span>
															</div>
														</div>
														{k.isActive ? (
															<DropdownMenu>
																<DropdownMenuTrigger
																	asChild
																>
																	<Button
																		variant="ghost"
																		size="icon"
																		aria-label={`Actions for ${k.name}`}
																		data-testid={`audit-key-actions-${k.id}`}
																	>
																		<MoreHorizontalIcon className="size-4" />
																	</Button>
																</DropdownMenuTrigger>
																<DropdownMenuContent align="end">
																	<DropdownMenuItem
																		onClick={() =>
																			copyToClipboard(
																				k.id,
																				t(
																					"settings.auditLog.apiKeysDrawer.copyId",
																				),
																			)
																		}
																	>
																		<CopyIcon className="mr-2 size-3.5" />
																		{t(
																			"settings.auditLog.apiKeysDrawer.copyId",
																		)}
																	</DropdownMenuItem>
																	<DropdownMenuItem
																		onClick={() =>
																			handleRotate(
																				k.id,
																				k.name,
																			)
																		}
																	>
																		<RefreshCwIcon className="mr-2 size-3.5" />
																		Rotate
																	</DropdownMenuItem>
																	<DropdownMenuSeparator />
																	{onViewAuditTrail ? (
																		<DropdownMenuItem
																			onClick={() => {
																				onViewAuditTrail(
																					k.id,
																				);
																				onOpenChange(
																					false,
																				);
																			}}
																		>
																			<KeyIcon className="mr-2 size-3.5" />
																			{t(
																				"settings.auditLog.apiKeysDrawer.viewAuditTrail",
																			)}
																		</DropdownMenuItem>
																	) : null}
																	<DropdownMenuSeparator />
																	<DropdownMenuItem
																		className="text-destructive focus:text-destructive"
																		onClick={() =>
																			handleRevoke(
																				k.id,
																				k.name,
																			)
																		}
																	>
																		<XCircleIcon className="mr-2 size-3.5" />
																		Revoke
																	</DropdownMenuItem>
																</DropdownMenuContent>
															</DropdownMenu>
														) : null}
													</div>
												</li>
											);
										})}
									</ul>
								) : (
									<div className="flex flex-col items-start gap-1 p-6 text-sm">
										<p className="font-medium">
											No API keys yet.
										</p>
										<p className="text-xs text-muted-foreground">
											Create a key to fetch this audit log
											from your CI, a monitoring tool, or
											your local CLI.
										</p>
									</div>
								)}
							</div>
						</section>

						{/* Lifecycle events */}
						<section className="flex flex-col gap-3">
							<span className="app-editorial-label">
								{t(
									"settings.auditLog.apiKeysDrawer.lifecycleHeading",
								)}
							</span>
							<div className="rounded-md border bg-card">
								{lifecycleItems.length === 0 ? (
									<div className="p-4 text-xs text-muted-foreground">
										{t(
											"settings.auditLog.apiKeysDrawer.lifecycleEmpty",
										)}
									</div>
								) : (
									<ul
										className="divide-y divide-border/60"
										data-testid="audit-api-keys-lifecycle"
									>
										{lifecycleItems.map((row) => {
											const created = new Date(
												row.createdAt,
											);
											const relative =
												formatDistanceToNow(created, {
													addSuffix: true,
												});
											return (
												<li
													key={row.id}
													className="flex items-start gap-3 p-3 text-xs"
												>
													<div className="flex min-w-0 flex-1 flex-col gap-0.5">
														<div className="flex items-center gap-2">
															<code className="font-mono text-[11px] text-foreground">
																{row.action}
															</code>
															<span className="text-muted-foreground">
																•
															</span>
															<span className="text-muted-foreground">
																{relative}
															</span>
														</div>
														<div className="text-muted-foreground">
															<span>
																{row.actorEmailSnapshot ??
																	row.actorNameSnapshot ??
																	"system"}
															</span>
															{row.resourceName ? (
																<>
																	<span className="mx-1">
																		→
																	</span>
																	<span className="text-foreground">
																		{
																			row.resourceName
																		}
																	</span>
																</>
															) : null}
														</div>
													</div>
												</li>
											);
										})}
									</ul>
								)}
							</div>
						</section>
					</div>
				</SheetContent>
			</Sheet>
		</TooltipProvider>
	);
}
