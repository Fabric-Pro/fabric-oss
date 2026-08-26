/**
 * Evidence Table Component Generators
 *
 * Generates Evidence DataTable and related components.
 */

import type { TableConfig } from "../types";

/**
 * Generate a DataTable component
 */
export function generateDataTable(config: TableConfig): string {
	const columnsAttr = config.columns
		? generateColumnsConfig(config.columns)
		: "";

	return `<DataTable
	data={${config.dataSource}}
	${config.search !== false ? "search={true}" : "search={false}"}
	${config.pagination !== false ? "" : "pagination={false}"}
	${config.rowsPerPage ? `rows={${config.rowsPerPage}}` : ""}
	${columnsAttr}
/>`;
}

/**
 * Generate columns configuration for DataTable
 */
function generateColumnsConfig(
	columns: NonNullable<TableConfig["columns"]>,
): string {
	if (columns.length === 0) {
		return "";
	}

	const colDefs = columns
		.map((col) => {
			const parts = [`id: "${col.field}"`];

			if (col.label) {
				parts.push(`title: "${escapeAttr(col.label)}"`);
			}
			if (col.format) {
				parts.push(`fmt: "${col.format}"`);
			}
			if (col.align) {
				parts.push(`align: "${col.align}"`);
			}

			return `{ ${parts.join(", ")} }`;
		})
		.join(",\n\t\t");

	return `columns={[
		${colDefs}
	]}`;
}

/**
 * Generate a simple HTML table (for basic tabular data)
 */
export function generateSimpleTable(
	headers: string[],
	rows: string[][],
): string {
	const headerRow = headers.map((h) => `<th>${escapeHtml(h)}</th>`).join("");
	const bodyRows = rows
		.map(
			(row) =>
				`<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`,
		)
		.join("\n");

	return `<table>
<thead>
	<tr>${headerRow}</tr>
</thead>
<tbody>
${bodyRows}
</tbody>
</table>`;
}

/**
 * Generate a Value component (single value display)
 */
export function generateValue(config: {
	dataSource: string;
	column: string;
	row?: number;
	format?: string;
}): string {
	return `<Value
	data={${config.dataSource}}
	column="${config.column}"
	${config.row !== undefined ? `row={${config.row}}` : ""}
	${config.format ? `fmt="${config.format}"` : ""}
/>`;
}

/**
 * Escape HTML entities
 */
function escapeHtml(str: string): string {
	return str
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

/**
 * Escape attribute value
 */
function escapeAttr(str: string): string {
	return str
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}
