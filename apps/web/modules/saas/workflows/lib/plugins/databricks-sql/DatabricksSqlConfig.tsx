"use client";

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import { Textarea } from "@ui/components/textarea";
import Link from "next/link";
import { useId } from "react";
import type { ActionConfigComponentProps } from "../types";

type Parameter = { name: string; type: string; value: string | null };
const selectClass =
	"h-9 w-full min-w-0 rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-2 focus-visible:outline-ring";
function Config({
	config,
	onChange,
	ai,
}: ActionConfigComponentProps & { ai: boolean }) {
	const id = useId();
	const { organizationId, basePath } = useOrganizationContext();
	const integrationId =
		typeof config.integrationId === "string" ? config.integrationId : "";
	const warehouseId =
		typeof config.warehouseId === "string" ? config.warehouseId : "";
	const connections = useQuery(
		orpc.workflows.integrations.listDatabricksSqlConnections.queryOptions({
			input: { organizationId },
		}),
	);
	const warehouses = useQuery({
		...orpc.workflows.integrations.listDatabricksSqlWarehouses.queryOptions(
			{ input: { organizationId, integrationId } },
		),
		enabled: !!integrationId,
	});
	const options = connections.data?.connections ?? [];
	const selected = warehouses.data?.warehouses.find(
		(w) => w.id === warehouseId,
	);
	const change = (key: string, value: unknown) =>
		onChange({ ...config, [key]: value });
	const parameters = Array.isArray(config.parameters)
		? (config.parameters as Parameter[])
		: [];
	const setParameter = (index: number, patch: Partial<Parameter>) =>
		change(
			"parameters",
			parameters.map((p, i) => (i === index ? { ...p, ...patch } : p)),
		);
	return (
		<div className="space-y-4">
			<div className="space-y-1.5">
				<Label htmlFor={`${id}-connection`}>Connection</Label>
				<select
					id={`${id}-connection`}
					className={selectClass}
					value={integrationId}
					disabled={connections.isLoading}
					onChange={(e) =>
						onChange({
							...config,
							integrationId: e.target.value,
							warehouseId: "",
						})
					}
				>
					<option value="">Select a Databricks SQL connection</option>
					{integrationId &&
						!options.some((c) => c.id === integrationId) && (
							<option value={integrationId}>
								Connection unavailable — select another
							</option>
						)}
					{options.map((c) => (
						<option key={c.id} value={c.id}>
							{c.name}
							{c.shared
								? " · Team connection"
								: " · Your connection"}
						</option>
					))}
				</select>
				{connections.error ? (
					<p role="alert" className="text-xs text-destructive">
						Could not load connections.{" "}
						<button
							type="button"
							className="underline"
							onClick={() => connections.refetch()}
						>
							Try again
						</button>
					</p>
				) : !connections.isLoading && !options.length ? (
					<p className="text-xs text-muted-foreground">
						Connect Databricks SQL with your own credentials, or ask
						a team member to share a connection.
					</p>
				) : null}
				<Link
					className="text-xs underline underline-offset-2"
					href={`${basePath}/settings/integrations/actions?integration=DATABRICKS_SQL`}
					target="_blank"
					rel="noopener noreferrer"
				>
					Manage Databricks connections ↗
				</Link>
			</div>
			<div className="space-y-1.5">
				<Label htmlFor={`${id}-warehouse`}>SQL warehouse</Label>
				<select
					id={`${id}-warehouse`}
					className={selectClass}
					value={warehouseId}
					disabled={!integrationId || warehouses.isFetching}
					onChange={(e) => change("warehouseId", e.target.value)}
				>
					<option value="">
						{warehouses.isFetching
							? "Loading warehouses…"
							: "Select an existing warehouse"}
					</option>
					{warehouseId && !selected && (
						<option value={warehouseId}>
							Previously selected warehouse — refresh to verify
						</option>
					)}
					{warehouses.data?.warehouses.map((w) => (
						<option key={w.id} value={w.id}>
							{w.name} · {w.state.toLowerCase()}
						</option>
					))}
				</select>
				{integrationId &&
					!warehouses.isFetching &&
					!warehouses.error &&
					warehouses.data?.warehouses.length === 0 && (
						<p
							role="status"
							className="text-xs text-muted-foreground"
						>
							No warehouses are visible. Ask your Databricks
							administrator for warehouse access.
						</p>
					)}
				{warehouses.error && (
					<p role="alert" className="text-xs text-destructive">
						Could not load warehouses. Verify the connection's
						permissions.{" "}
						<button
							type="button"
							className="underline"
							onClick={() => warehouses.refetch()}
						>
							Try again
						</button>
					</p>
				)}
				{selected && selected.state !== "RUNNING" && (
					<p role="status" className="text-xs text-muted-foreground">
						Start this warehouse in Databricks before running.
						Manage warehouse compute in Databricks.
					</p>
				)}
			</div>
			{ai ? (
				<>
					<div className="space-y-1.5">
						<Label htmlFor={`${id}-endpoint`}>
							Model serving endpoint
						</Label>
						<Input
							id={`${id}-endpoint`}
							placeholder="example-model-endpoint"
							value={String(config.endpoint ?? "")}
							onChange={(e) => change("endpoint", e.target.value)}
						/>
						<p className="text-xs text-muted-foreground">
							Your service principal needs CAN QUERY. Use a
							warehouse and endpoint that support ai_query.
						</p>
					</div>
					<div className="space-y-1.5">
						<Label htmlFor={`${id}-request`}>AI request</Label>
						<Textarea
							id={`${id}-request`}
							maxLength={8192}
							rows={5}
							placeholder="Summarize {{Previous step.summary}}"
							value={String(config.request ?? "")}
							onChange={(e) => change("request", e.target.value)}
						/>
						<p className="text-xs text-muted-foreground">
							One request per step, up to 8,192 characters and 512
							output tokens. Databricks model charges apply.
						</p>
					</div>
				</>
			) : (
				<>
					<div className="space-y-1.5">
						<Label htmlFor={`${id}-sql`}>SQL statement</Label>
						<Textarea
							id={`${id}-sql`}
							className="font-mono text-xs"
							rows={7}
							placeholder="SELECT * FROM catalog.schema.table WHERE status = :status LIMIT 100"
							maxLength={50000}
							value={String(config.statement ?? "")}
							onChange={(e) =>
								change("statement", e.target.value)
							}
						/>
						<p className="text-xs text-muted-foreground">
							Use three-part Unity Catalog table names. Bind
							dynamic values below as :name parameters. SQL text
							does not expand template expressions.
						</p>
					</div>
					<fieldset className="space-y-2">
						<legend className="text-sm font-medium">
							Named parameters
						</legend>
						{parameters.map((p, index) => (
							<div
								key={`${id}-${index}`}
								className="space-y-2 rounded-md border p-2"
							>
								<div className="flex gap-2">
									<Input
										aria-label={`Parameter ${index + 1} name`}
										placeholder="status"
										value={p.name}
										onChange={(e) =>
											setParameter(index, {
												name: e.target.value,
											})
										}
									/>
									<select
										aria-label={`Parameter ${index + 1} type`}
										className={selectClass}
										value={p.type}
										onChange={(e) =>
											setParameter(index, {
												type: e.target.value,
											})
										}
									>
										{[
											"STRING",
											"BOOLEAN",
											"INT",
											"BIGINT",
											"DOUBLE",
											"DATE",
											"TIMESTAMP",
										].map((t) => (
											<option key={t}>{t}</option>
										))}
									</select>
								</div>
								<Input
									aria-label={`Parameter ${index + 1} value`}
									placeholder="Value or {{Previous step.field}}"
									value={p.value ?? ""}
									onChange={(e) =>
										setParameter(index, {
											value: e.target.value,
										})
									}
								/>
								<Button
									type="button"
									variant="ghost"
									size="sm"
									onClick={() =>
										change(
											"parameters",
											parameters.filter(
												(_, i) => i !== index,
											),
										)
									}
								>
									Remove parameter {index + 1}
								</Button>
							</div>
						))}
						<Button
							type="button"
							variant="outline"
							size="sm"
							disabled={parameters.length >= 50}
							onClick={() =>
								change("parameters", [
									...parameters,
									{ name: "", type: "STRING", value: "" },
								])
							}
						>
							Add parameter
						</Button>
					</fieldset>
					<div className="space-y-1.5">
						<Label htmlFor={`${id}-limit`}>Result row limit</Label>
						<Input
							id={`${id}-limit`}
							type="number"
							min={1}
							max={1000}
							value={String(config.rowLimit ?? 100)}
							onChange={(e) => change("rowLimit", e.target.value)}
						/>
					</div>
				</>
			)}
			<p className="rounded-md bg-muted p-3 text-xs leading-5 text-muted-foreground">
				Runs only when you run the workflow or its published schedule
				fires. Results are capped at 1 MB. Statements time out after 90
				seconds and are not automatically retried. SQL and model
				execution may incur Databricks charges.
			</p>
		</div>
	);
}
export const DatabricksSqlConfig = (props: ActionConfigComponentProps) => (
	<Config {...props} ai={false} />
);
export const DatabricksAiConfig = (props: ActionConfigComponentProps) => (
	<Config {...props} ai />
);
