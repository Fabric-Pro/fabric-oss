"use client";

/** A bounded, accessible table over the rows already recorded for this run. */
export function DatabricksRunResult({
	output,
}: {
	output: Record<string, unknown>;
}) {
	if (!Array.isArray(output.columns) || !Array.isArray(output.rows)) {
		return null;
	}
	const columns = output.columns.slice(0, 50).map((column, index) => ({
		name:
			typeof column?.name === "string"
				? column.name
				: `Column ${index + 1}`,
		type: typeof column?.type_name === "string" ? column.type_name : "",
	}));
	const rows = output.rows.slice(0, 100);
	const workspace =
		typeof output.workspaceUrl === "string" &&
		/^https:\/\/[^\s/@]+\.[a-z.]+$/i.test(output.workspaceUrl)
			? output.workspaceUrl
			: null;
	return (
		<div className="min-w-0 space-y-2 text-xs">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<span>
					{output.rows.length} result{" "}
					{output.rows.length === 1 ? "row" : "rows"}
				</span>
				{workspace && (
					<a
						href={workspace}
						target="_blank"
						rel="noopener noreferrer"
						className="underline underline-offset-2"
					>
						Open Databricks ↗
					</a>
				)}
			</div>
			{typeof output.statementId === "string" && (
				<p className="break-all text-muted-foreground">
					Statement <code>{output.statementId}</code>
				</p>
			)}
			{output.truncated === true && (
				<output className="block rounded border bg-muted p-2">
					Databricks truncated this result at the configured limit.
				</output>
			)}
			<section
				aria-label="Databricks result rows"
				// biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users must be able to focus and scroll the bounded result table.
				tabIndex={0}
				className="max-h-72 overflow-auto rounded border focus-visible:outline-2 focus-visible:outline-ring"
			>
				<table className="w-full border-collapse text-left">
					<caption className="sr-only">Databricks SQL result</caption>
					<thead className="sticky top-0 bg-muted">
						<tr>
							{columns.map((column, index) => (
								<th
									key={index}
									scope="col"
									className="whitespace-nowrap border-b px-2 py-1.5 font-medium"
								>
									{column.name}
									{column.type && (
										<span className="ml-1 font-normal text-muted-foreground">
											{column.type}
										</span>
									)}
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{rows.map((row, index) => (
							<tr key={index}>
								{columns.map((_column, position) => (
									<td
										key={position}
										className="max-w-72 truncate border-b px-2 py-1.5 font-mono"
									>
										{Array.isArray(row) &&
										row[position] !== null &&
										row[position] !== undefined ? (
											String(row[position]).slice(0, 2000)
										) : (
											<span className="text-muted-foreground">
												NULL
											</span>
										)}
									</td>
								))}
							</tr>
						))}
					</tbody>
				</table>
			</section>
			{output.rows.length === 0 && (
				<p className="text-muted-foreground">
					The statement completed with no result rows.
				</p>
			)}
			{(output.rows.length > rows.length ||
				output.columns.length > columns.length) && (
				<p className="text-muted-foreground">
					Showing up to 100 rows and 50 columns. Open run details for
					the complete recorded output.
				</p>
			)}
		</div>
	);
}
