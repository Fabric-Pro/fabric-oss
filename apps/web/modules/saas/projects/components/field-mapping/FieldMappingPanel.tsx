"use client";

import type { Prisma } from "@repo/database";
// Import the pure zod schema module directly (NOT the @repo/database barrel):
// the barrel re-exports the Prisma client, which a "use client" component must
// never pull into the browser bundle. This file only imports zod.
import {
	ADO_FIELD_MAPPING_PROVIDER,
	readFieldMappingConfig,
} from "@repo/database/src/field-mapping-schema";
import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@ui/components/card";
import {
	AlertTriangleIcon,
	CheckCircle2Icon,
	Loader2Icon,
	MapIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { getPmProviderLabel } from "../../lib/pm-provider-label";
import { AvailableFieldsList } from "./AvailableFieldsList";
import { ExampleTicketPreview } from "./ExampleTicketPreview";
import {
	type PmFieldCatalogEntry,
	type SelectedField,
	SOFT_CAP,
	seedFromCatalog,
	selectionsEqual,
} from "./field-mapping-helpers";
import { getOrpcCode } from "./orpc-error";
import { SelectedFieldsList } from "./SelectedFieldsList";

type Project = {
	id: string;
	name: string;
	organizationId?: string | null;
	projectManagementMcpServerId?: string | null;
	projectManagementMcpConfigId?: string | null;
	projectManagementContainerId?: string | null;
	projectManagementAdditionalContext?: Prisma.JsonValue | null;
	userRole?: string | null;
};

type Props = {
	project: Project;
};

const SECTION_LABEL_CLASS = "editorial-label";

/**
 * Field-mapping panel. Lets a project admin pick and
 * order which Azure DevOps fields compose a synced work item's body. Renders one
 * of three provider states: unsupported placeholder, no-PM-tool hint, or the full
 * ADO picker (available list + ordered selection + example-ticket preview + save).
 */
export function FieldMappingPanel({ project }: Props) {
	const queryClient = useQueryClient();

	const isConnected = Boolean(
		project.projectManagementMcpServerId ||
			project.projectManagementMcpConfigId,
	);

	// Connected provider — same query the PM card / roadmap use, so React Query
	// dedupes it. `detectedType` drives which provider state we render.
	const {
		data: pmCapabilities,
		isLoading: isLoadingCapabilities,
		isError: isCapabilitiesError,
		error: capabilitiesError,
		refetch: refetchCapabilities,
	} = useQuery({
		queryKey: [
			"pmCapabilities",
			project.id,
			project.organizationId ?? null,
		],
		queryFn: () =>
			orpcClient.projects.stories.pmCapabilities({
				projectId: project.id,
			}),
		staleTime: 60_000,
		enabled: isConnected,
	});
	const detectedType = pmCapabilities?.detectedType ?? null;
	const isAdo = detectedType === ADO_FIELD_MAPPING_PROVIDER;

	// Enumerating the catalog walks every work item type on the project, which is
	// several MCP round-trips — too much to spend on every settings-page load now
	// that suggestions come from the example ticket's form instead. Deferred until
	// the admin asks to browse all fields; "Refresh fields" re-invokes.
	const [catalogRequested, setCatalogRequested] = useState(false);
	const enumerate = useQuery({
		...orpc.projects.pm.enumerateFields.queryOptions({
			input: { projectId: project.id },
		}),
		enabled: isConnected && isAdo && catalogRequested,
		staleTime: Number.POSITIVE_INFINITY,
		retry: false,
	});

	const enumerateData = enumerate.data;
	const catalog: PmFieldCatalogEntry[] =
		enumerateData && "fields" in enumerateData ? enumerateData.fields : [];
	const enumerateUnsupported =
		enumerateData && "unsupported" in enumerateData
			? enumerateData.provider
			: null;

	// Persisted config → the working selection + the "saved" baseline for dirty
	// tracking. `null` config means "never configured" (eligible for the seed).
	const persistedConfig = readFieldMappingConfig(
		project.projectManagementAdditionalContext,
	);
	const [selected, setSelected] = useState<SelectedField[]>(
		persistedConfig?.fields ?? [],
	);
	const [savedFields, setSavedFields] = useState<SelectedField[]>(
		persistedConfig?.fields ?? [],
	);

	// Optional curated seed: one-shot, only when no config has ever
	// existed and the catalog has loaded. A starting selection the admin edits.
	const seededRef = useRef(false);
	useEffect(() => {
		if (
			seededRef.current ||
			persistedConfig !== null ||
			catalog.length === 0
		) {
			return;
		}
		seededRef.current = true;
		const seed = seedFromCatalog(catalog);
		if (seed.length > 0) {
			setSelected(seed);
		}
	}, [catalog, persistedConfig]);

	const isDirty = !selectionsEqual(selected, savedFields);
	const overCap = selected.length > SOFT_CAP;

	const projectGetQueryKey = orpc.projects.get.queryKey({
		input: {
			id: project.id,
			organizationId: project.organizationId ?? null,
		},
	});

	const save = useMutation({
		mutationFn: async (fields: SelectedField[]) => {
			const existing =
				(project.projectManagementAdditionalContext as Record<
					string,
					unknown
				> | null) ?? {};
			const mergedContext: Record<string, unknown> = {
				...existing,
				fieldMapping: {
					provider: ADO_FIELD_MAPPING_PROVIDER,
					fields,
				},
			};
			return orpcClient.projects.update({
				id: project.id,
				// Pass organizationId explicitly (null for personal) so
				// resolveOrganizationId can't fall back to the session's active org.
				organizationId: project.organizationId,
				projectManagementAdditionalContext: mergedContext,
			});
		},
		onSuccess: (_result, fields) => {
			queryClient.invalidateQueries({ queryKey: projectGetQueryKey });
			setSavedFields(fields);
			toast.success("Field mapping saved");
		},
		onError: (error) => {
			toast.error(
				`Failed to save: ${
					error instanceof Error ? error.message : "Unknown error"
				}`,
			);
		},
	});

	const addField = (field: SelectedField) => {
		if (selected.some((f) => f.id === field.id)) {
			return;
		}
		setSelected((prev) => [...prev, field]);
	};

	/** Append suggested fields in rank order, skipping ones already selected. */
	const addFields = (fields: SelectedField[]) => {
		setSelected((prev) => {
			const present = new Set(prev.map((f) => f.id));
			const additions = fields.filter((f) => !present.has(f.id));
			return additions.length > 0 ? [...prev, ...additions] : prev;
		});
	};

	const discard = () => setSelected(savedFields);
	const clearAll = () => setSelected([]);

	// ---- Provider states --------------------------------------

	const header = (
		<CardHeader>
			<p className={SECTION_LABEL_CLASS}>Inbound content</p>
			<CardTitle className="mt-2 flex items-center gap-2">
				<MapIcon className="size-5" aria-hidden="true" />
				Field mapping
			</CardTitle>
			<CardDescription>
				Choose which work-item fields Fabric pulls into a synced item's
				content, and in what order. Applies to future syncs.
			</CardDescription>
		</CardHeader>
	);

	// State (b): no PM tool connected.
	if (!isConnected) {
		return (
			<Card>
				{header}
				<CardContent>
					<p className="rounded-lg border border-dashed bg-muted/30 px-4 py-6 text-center text-muted-foreground text-sm">
						Connect a project management tool in the card above to
						map its fields into Fabric.
					</p>
				</CardContent>
			</Card>
		);
	}

	if (isLoadingCapabilities) {
		return (
			<Card>
				{header}
				<CardContent>
					<div className="flex items-center gap-2 text-muted-foreground text-sm">
						<Loader2Icon
							className="size-4 motion-safe:animate-spin"
							aria-hidden="true"
						/>
						Checking connected tool...
					</div>
				</CardContent>
			</Card>
		);
	}

	// The capability probe itself failed. Distinct from "connected to something
	// we don't recognize": telling an admin to reconnect a healthy connection
	// sends them down the wrong path, so surface the failure and offer a retry.
	if (isCapabilitiesError) {
		return (
			<Card>
				{header}
				<CardContent>
					<div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-6 text-center">
						<p className="text-destructive text-sm">
							{capabilitiesError instanceof Error
								? capabilitiesError.message
								: "Couldn't check the connected project management tool."}
						</p>
						<Button
							type="button"
							variant="outline"
							className="mt-3"
							onClick={() => refetchCapabilities()}
						>
							Try again
						</Button>
					</div>
				</CardContent>
			</Card>
		);
	}

	// State (a): provider unsupported (non-ADO, or ADO enumerate reports it).
	if ((detectedType && !isAdo) || enumerateUnsupported !== null) {
		const providerLabel =
			getPmProviderLabel(enumerateUnsupported ?? detectedType) ??
			"this tool";
		return (
			<Card>
				{header}
				<CardContent>
					<div className="rounded-lg border bg-muted/30 px-4 py-6">
						<p className="text-foreground text-sm">
							Custom field mapping isn't available for{" "}
							<span className="font-medium">{providerLabel}</span>{" "}
							yet.
						</p>
						<p className="mt-1 text-muted-foreground text-sm">
							Only Azure DevOps is supported in this release.
						</p>
					</div>
				</CardContent>
			</Card>
		);
	}

	// Connected, but we couldn't resolve the tool type (capabilities errored or
	// returned an unrecognized tool). Don't fall through to the ADO picker — that
	// would render a healthy-looking picker claiming the project has no fields.
	if (!isAdo) {
		return (
			<Card>
				{header}
				<CardContent>
					<p className="rounded-lg border border-dashed bg-muted/30 px-4 py-6 text-center text-muted-foreground text-sm">
						Couldn't determine the connected project management
						tool. Reopen the card above to reconnect, then try
						again.
					</p>
				</CardContent>
			</Card>
		);
	}

	// State (c): ADO connected — the full picker.
	return (
		<Card>
			{header}
			<CardContent className="space-y-5">
				<EnumerationBody
					isLoading={enumerate.isLoading}
					isError={enumerate.isError}
					error={enumerate.error}
					isRefetching={enumerate.isRefetching}
					dataUpdatedAt={enumerate.dataUpdatedAt}
					onRefetch={() => enumerate.refetch()}
					catalog={catalog}
					catalogRequested={catalogRequested}
					onRequestCatalog={() => setCatalogRequested(true)}
					selected={selected}
					projectId={project.id}
					onAdd={addField}
					onAddFields={addFields}
					onChangeSelected={setSelected}
					isSaving={save.isPending}
				/>

				{/* Saving is independent of the field catalog: the selection can come
				    from suggestions alone, so this must not wait on enumeration. */}
				{
					<>
						<div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
							<div className="flex items-center gap-3 text-sm">
								{isDirty ? (
									<span className="flex items-center gap-1.5 text-highlight">
										<AlertTriangleIcon
											className="size-4"
											aria-hidden="true"
										/>
										Unsaved changes
									</span>
								) : save.isSuccess ? (
									<span className="flex items-center gap-1.5 text-secondary">
										<CheckCircle2Icon
											className="size-4"
											aria-hidden="true"
										/>
										Saved
									</span>
								) : null}
							</div>
							<div className="flex items-center gap-2">
								{selected.length > 0 && (
									<Button
										type="button"
										variant="ghost"
										onClick={clearAll}
										disabled={save.isPending}
									>
										Clear all
									</Button>
								)}
								<Button
									type="button"
									variant="outline"
									onClick={discard}
									disabled={!isDirty || save.isPending}
								>
									Discard
								</Button>
								<Button
									type="button"
									onClick={() => save.mutate(selected)}
									disabled={!isDirty || save.isPending}
								>
									{save.isPending ? (
										<>
											<Loader2Icon
												className="mr-2 size-4 motion-safe:animate-spin"
												aria-hidden="true"
											/>
											Saving...
										</>
									) : (
										"Save mapping"
									)}
								</Button>
							</div>
						</div>

						{overCap && (
							<p
								className="flex items-start gap-1.5 text-highlight text-sm"
								aria-live="polite"
							>
								<AlertTriangleIcon
									className="mt-0.5 size-4 shrink-0"
									aria-hidden="true"
								/>
								<span>
									You've selected {selected.length} fields. We
									recommend keeping this under {SOFT_CAP}.
									Aggregating many large fields risks the ~2
									MiB PM-sync input limit and inflates the
									content indexed for search — fewer,
									content-bearing fields sync more reliably.
								</span>
							</p>
						)}
					</>
				}
			</CardContent>
		</Card>
	);
}

/**
 * The picker body for the ADO-connected state: handles the enumerate
 * loading / error / empty / ready sub-states, then renders the two-column
 * available + selected layout with the example-ticket preview on top.
 */
function EnumerationBody({
	isLoading,
	isError,
	error,
	isRefetching,
	dataUpdatedAt,
	onRefetch,
	catalog,
	catalogRequested,
	onRequestCatalog,
	selected,
	projectId,
	onAdd,
	onAddFields,
	onChangeSelected,
	isSaving,
}: {
	isLoading: boolean;
	isError: boolean;
	error: unknown;
	isRefetching: boolean;
	dataUpdatedAt: number;
	onRefetch: () => void;
	catalog: PmFieldCatalogEntry[];
	catalogRequested: boolean;
	onRequestCatalog: () => void;
	selected: SelectedField[];
	projectId: string;
	onAdd: (field: SelectedField) => void;
	onAddFields: (fields: SelectedField[]) => void;
	onChangeSelected: (fields: SelectedField[]) => void;
	isSaving: boolean;
}) {
	// The catalog pane is the only part that needs enumeration; suggestions and
	// the composed preview work without it, so they render immediately.
	let catalogPane: React.ReactNode;

	if (!catalogRequested) {
		catalogPane = (
			<div className="flex h-full flex-col items-start justify-center gap-2 rounded-lg border border-dashed bg-muted/30 px-4 py-6 text-center">
				<p className="w-full text-muted-foreground text-sm">
					Suggestions above cover the fields this work item type
					actually uses for content. Browse the full catalog only if
					you need something they miss.
				</p>
				<Button
					type="button"
					variant="outline"
					className="mx-auto"
					onClick={onRequestCatalog}
				>
					Browse all fields
				</Button>
			</div>
		);
	} else if (isLoading) {
		catalogPane = (
			<div className="flex items-center gap-2 text-muted-foreground text-sm">
				<Loader2Icon
					className="size-4 motion-safe:animate-spin"
					aria-hidden="true"
				/>
				Loading fields from Azure DevOps...
			</div>
		);
	} else if (isError) {
		const code = getOrpcCode(error);
		// Non-retryable, actionable states get a specific hint; only genuine
		// server failures offer a retry.
		if (code === "BAD_REQUEST") {
			catalogPane = (
				<p className="rounded-lg border border-dashed bg-muted/30 px-4 py-6 text-center text-muted-foreground text-sm">
					Select a board in the card above before mapping fields.
				</p>
			);
		} else if (code === "FORBIDDEN") {
			catalogPane = (
				<p className="rounded-lg border border-dashed bg-muted/30 px-4 py-6 text-center text-muted-foreground text-sm">
					Connect your own account to the project management tool to
					load its fields.
				</p>
			);
		} else {
			catalogPane = (
				<div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-6 text-center">
					<p className="text-destructive text-sm">
						{error instanceof Error
							? error.message
							: "Couldn't load PM fields."}
					</p>
					<Button
						type="button"
						variant="outline"
						className="mt-3"
						onClick={onRefetch}
					>
						Try again
					</Button>
				</div>
			);
		}
	} else if (catalog.length === 0) {
		catalogPane = (
			<p className="rounded-lg border border-dashed bg-muted/30 px-4 py-6 text-center text-muted-foreground text-sm">
				No fields found for this project's work item types.
			</p>
		);
	} else {
		catalogPane = (
			<AvailableFieldsList
				catalog={catalog}
				selected={selected}
				onAdd={onAdd}
				onRefresh={onRefetch}
				isRefreshing={isRefetching}
				lastRefreshedAt={dataUpdatedAt || null}
				disabled={isSaving}
			/>
		);
	}

	return (
		<>
			<ExampleTicketPreview
				projectId={projectId}
				catalog={catalog}
				selected={selected}
				onAddFields={onAddFields}
			/>

			<div className="grid gap-6 lg:grid-cols-2">
				{catalogPane}

				<div className="space-y-2">
					<div className="flex items-center justify-between">
						<span className="text-muted-foreground text-xs uppercase tracking-wider">
							Selected fields
						</span>
						<span className="text-muted-foreground text-xs tabular-nums">
							{selected.length}
							{selected.length > 0 && ` / ${SOFT_CAP}`}
						</span>
					</div>
					<p className="text-muted-foreground text-xs">
						Fewer, content-bearing fields sync more reliably. Large
						work-item bodies can approach the ~2 MiB PM-sync limit
						and inflate the content indexed for search, so we
						suggest keeping this under {SOFT_CAP} fields.
					</p>
					<SelectedFieldsList
						fields={selected}
						onChange={onChangeSelected}
						disabled={isSaving}
					/>
				</div>
			</div>
		</>
	);
}
