"use client";

/**
 * Operator surface for publishing customer-facing status announcements.
 *
 * Lives on the existing admin monitoring dashboard rather than in a new admin
 * area: an operator reaches for this while looking at the incident that prompted
 * it, and splitting the two would mean navigating away mid-incident.
 *
 * Without this the announcement tables are reachable only through the API, which
 * in practice means nobody publishes anything during an incident — so the
 * customer-facing surface would only ever show probe-derived status and never
 * "we know, we're on it".
 */

import type { StatusUpdateImpact, StatusUpdateLifecycle } from "@repo/database";
import { formatUtc } from "@saas/system-health/lib/format-utc";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Card } from "@ui/components/card";
import { Input } from "@ui/components/input";
import { Textarea } from "@ui/components/textarea";
import { cn } from "@ui/lib";
import { useState } from "react";

/**
 * Aliased to the generated Prisma enum types rather than re-declared, so adding a
 * variant to the schema breaks the label/tone maps below instead of leaving them
 * silently short. `import type` is erased at build time, so this costs the client
 * bundle nothing.
 */
type Lifecycle = StatusUpdateLifecycle;
type Impact = StatusUpdateImpact;

const LIFECYCLES: Lifecycle[] = [
	"INVESTIGATING",
	"IDENTIFIED",
	"MONITORING",
	"RESOLVED",
	"SCHEDULED",
	"IN_PROGRESS",
	"COMPLETED",
];

const IMPACTS: Impact[] = ["NONE", "MINOR", "MAJOR", "CRITICAL"];

const QUERY_KEY = ["systemHealth", "admin", "statusUpdates"] as const;

interface AdminStatusUpdate {
	id: string;
	title: string;
	lifecycle: Lifecycle;
	impact: Impact;
	startedAt: string | Date;
	resolvedAt: string | Date | null;
	affectedComponentKeys: string[];
	revisions: { id: string; lifecycle: Lifecycle; createdAt: string | Date }[];
}

interface ComponentOption {
	key: string;
	displayName: string;
	customerVisible: boolean;
}

export function StatusAnnouncementAuthoring() {
	const queryClient = useQueryClient();
	const [title, setTitle] = useState("");
	const [body, setBody] = useState("");
	const [impact, setImpact] = useState<Impact>("MINOR");
	const [lifecycle, setLifecycle] = useState<Lifecycle>("INVESTIGATING");
	const [componentKeys, setComponentKeys] = useState<string[]>([]);
	const [error, setError] = useState<string | null>(null);

	const list = useQuery({
		queryKey: QUERY_KEY,
		queryFn: async () =>
			(await orpcClient.systemHealth.admin.listStatusUpdates({
				limit: 20,
			})) as {
				updates: AdminStatusUpdate[];
				components: ComponentOption[];
			},
	});

	const publish = useMutation({
		mutationFn: async () =>
			orpcClient.systemHealth.admin.publishStatusUpdate({
				title,
				body,
				impact,
				lifecycle,
				affectedComponentKeys: componentKeys,
				affectedProviderKeys: [],
			}),
		onSuccess: () => {
			setTitle("");
			setBody("");
			setComponentKeys([]);
			setError(null);
			queryClient.invalidateQueries({ queryKey: QUERY_KEY });
		},
		onError: (err: unknown) => {
			setError(err instanceof Error ? err.message : "Failed to publish");
		},
	});

	const appendRevision = useMutation({
		mutationFn: async (input: {
			statusUpdateId: string;
			lifecycle: Lifecycle;
			body: string;
		}) => orpcClient.systemHealth.admin.appendStatusRevision(input),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: QUERY_KEY });
		},
	});

	const components = list.data?.components ?? [];
	// `updates` is optional-chained separately from `data`: a caller (or a test
	// harness) can hand back a partial payload, and guarding only `data` would
	// throw on `.length` instead of rendering the empty state.
	const updates = list.data?.updates ?? [];
	const canPublish =
		title.trim().length > 0 && body.trim().length > 0 && !publish.isPending;

	return (
		<section
			aria-labelledby="status-authoring-heading"
			className="space-y-4"
		>
			<div>
				<h2
					id="status-authoring-heading"
					className="font-medium text-base text-foreground"
				>
					Customer status announcements
				</h2>
				<p className="mt-1 text-muted-foreground text-sm">
					Published to every customer's System Health page. Write for
					a customer, not an operator: no root cause, no internal
					component names, no hostnames.
				</p>
			</div>

			<Card className="border-border/60 bg-card p-5">
				<div className="grid gap-3">
					<label className="block">
						<span className="mb-1 block font-medium text-xs">
							Headline
						</span>
						<Input
							value={title}
							onChange={(e) => setTitle(e.target.value)}
							placeholder="Slower AI responses for some workspaces"
							maxLength={200}
						/>
					</label>
					<label className="block">
						<span className="mb-1 block font-medium text-xs">
							What customers should know
						</span>
						<Textarea
							value={body}
							onChange={(e) => setBody(e.target.value)}
							rows={4}
							placeholder="Some requests are taking longer than usual. Your data is unaffected and no action is needed."
							maxLength={10000}
						/>
					</label>

					<div className="flex flex-wrap gap-4">
						<label className="block">
							<span className="mb-1 block font-medium text-xs">
								Customer impact
							</span>
							<select
								value={impact}
								onChange={(e) =>
									setImpact(e.target.value as Impact)
								}
								className="h-9 rounded-md border border-border/60 bg-card px-2 text-sm"
							>
								{IMPACTS.map((value) => (
									<option key={value} value={value}>
										{value}
									</option>
								))}
							</select>
						</label>
						<label className="block">
							<span className="mb-1 block font-medium text-xs">
								Stage
							</span>
							<select
								value={lifecycle}
								onChange={(e) =>
									setLifecycle(e.target.value as Lifecycle)
								}
								className="h-9 rounded-md border border-border/60 bg-card px-2 text-sm"
							>
								{LIFECYCLES.map((value) => (
									<option key={value} value={value}>
										{value}
									</option>
								))}
							</select>
						</label>
					</div>

					<div>
						<span className="mb-1.5 block font-medium text-xs">
							Affected components
						</span>
						<div className="flex flex-wrap gap-2">
							{components.map((component) => {
								const selected = componentKeys.includes(
									component.key,
								);
								return (
									<button
										key={component.key}
										type="button"
										aria-pressed={selected}
										onClick={() =>
											setComponentKeys((prev) =>
												selected
													? prev.filter(
															(k) =>
																k !==
																component.key,
														)
													: [...prev, component.key],
											)
										}
										className={cn(
											"rounded-full border px-2.5 py-1 text-xs transition-colors",
											"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
											// Solid fill when selected: text-primary on a
											// 10% tint of itself measured 3.64:1 in dark
											// mode, below the AA floor.
											selected
												? "border-primary bg-primary text-primary-foreground"
												: "border-border/60 text-muted-foreground hover:text-foreground",
										)}
									>
										{component.displayName}
									</button>
								);
							})}
						</div>
						<p className="mt-1.5 text-muted-foreground text-xs">
							Impact NONE is informational and never changes a
							component's status.
						</p>
					</div>

					{error && (
						<p role="alert" className="text-destructive text-xs">
							{error}
						</p>
					)}

					<div>
						<Button
							size="sm"
							disabled={!canPublish}
							onClick={() => publish.mutate()}
						>
							{publish.isPending ? "Publishing…" : "Publish"}
						</Button>
					</div>
				</div>
			</Card>

			<div>
				<p className="mb-2 font-medium text-muted-foreground text-xs">
					Recent announcements
				</p>
				{list.isLoading ? (
					<p className="text-muted-foreground text-sm">Loading…</p>
				) : list.isError ? (
					// Distinct from the empty state on purpose. Both used to render
					// "Nothing published yet", so a transient fetch failure told an
					// operator mid-incident that no announcement existed — inviting a
					// duplicate.
					<Card className="border-destructive/40 bg-destructive/5 p-4">
						<p className="text-destructive text-sm">
							Could not load existing announcements. This list may
							be incomplete — check before publishing, to avoid a
							duplicate.
						</p>
					</Card>
				) : updates.length === 0 ? (
					<Card className="border-border/60 bg-muted/40 p-4">
						<p className="text-muted-foreground text-sm">
							Nothing published yet.
						</p>
					</Card>
				) : (
					<Card className="divide-y divide-border/60 border-border/60 bg-card">
						{updates.map((update) => (
							<div key={update.id} className="p-4">
								<div className="flex flex-wrap items-start justify-between gap-2">
									<div className="min-w-0">
										<p className="font-medium text-foreground text-sm">
											{update.title}
										</p>
										<p className="mt-0.5 text-muted-foreground text-xs">
											{update.impact} · {update.lifecycle}{" "}
											· started{" "}
											{formatUtc(update.startedAt)}
											{update.resolvedAt
												? ` · resolved ${formatUtc(update.resolvedAt)}`
												: ""}
											{update.affectedComponentKeys
												.length > 0
												? ` · ${update.affectedComponentKeys.join(", ")}`
												: ""}
										</p>
									</div>
									<RevisionForm
										disabled={appendRevision.isPending}
										onSubmit={(next) =>
											appendRevision.mutate({
												statusUpdateId: update.id,
												...next,
											})
										}
									/>
								</div>
							</div>
						))}
					</Card>
				)}
			</div>
		</section>
	);
}

/**
 * Inline "append a revision" control.
 *
 * Revisions are append-only by design — there is no edit or delete path, because
 * rewriting what customers were already told defeats the purpose of publishing a
 * timeline. A correction is a new revision.
 */
function RevisionForm({
	disabled,
	onSubmit,
}: {
	disabled: boolean;
	onSubmit: (input: { lifecycle: Lifecycle; body: string }) => void;
}) {
	const [open, setOpen] = useState(false);
	const [lifecycle, setLifecycle] = useState<Lifecycle>("IDENTIFIED");
	const [body, setBody] = useState("");

	if (!open) {
		return (
			<Button variant="outline" size="sm" onClick={() => setOpen(true)}>
				Add update
			</Button>
		);
	}

	return (
		<div className="flex w-full flex-col gap-2 sm:w-auto">
			<div className="flex gap-2">
				<select
					value={lifecycle}
					onChange={(e) => setLifecycle(e.target.value as Lifecycle)}
					aria-label="Stage for this update"
					className="h-8 rounded-md border border-border/60 bg-card px-2 text-xs"
				>
					{LIFECYCLES.map((value) => (
						<option key={value} value={value}>
							{value}
						</option>
					))}
				</select>
				<Input
					value={body}
					onChange={(e) => setBody(e.target.value)}
					placeholder="What changed"
					aria-label="Update text"
					className="h-8 text-xs"
				/>
			</div>
			<div className="flex gap-2">
				<Button
					size="sm"
					disabled={disabled || body.trim().length === 0}
					onClick={() => {
						onSubmit({ lifecycle, body });
						setBody("");
						setOpen(false);
					}}
				>
					Post
				</Button>
				<Button
					variant="ghost"
					size="sm"
					onClick={() => {
						setOpen(false);
						setBody("");
					}}
				>
					Cancel
				</Button>
			</div>
		</div>
	);
}
