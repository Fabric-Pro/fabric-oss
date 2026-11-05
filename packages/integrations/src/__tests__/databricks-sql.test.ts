import { describe, expect, it, vi } from "vitest";
import {
	executeDatabricksSql,
	listDatabricksSqlWarehouses,
} from "../databricks-sql";

const host = "https://example.cloud.databricks.com";
const credentials = {
	DATABRICKS_HOST: host,
	DATABRICKS_CLIENT_ID: "example-client",
	DATABRICKS_CLIENT_SECRET: "example-secret",
};
const json = (value: unknown, status = 200) =>
	new Response(JSON.stringify(value), {
		status,
		headers: { "Content-Type": "application/json" },
	});
const success = {
	statement_id: "example-statement",
	status: { state: "SUCCEEDED" },
	manifest: {
		schema: { columns: [{ name: "answer", type_name: "STRING" }] },
		truncated: false,
	},
	result: { data_array: [["42"]] },
};
function harness(
	route: (path: string, init?: RequestInit) => Response | Promise<Response>,
) {
	return vi.fn<typeof fetch>(async (input, init) => {
		const url = new URL(String(input));
		if (url.pathname === "/oidc/v1/token")
			return json({
				access_token: "example-token",
				token_type: "Bearer",
				expires_in: 3600,
			});
		if (url.pathname === "/api/2.0/sql/warehouses/example-warehouse")
			return json({ state: "RUNNING" });
		return route(url.pathname, init);
	});
}
const input = {
	warehouseId: "example-warehouse",
	statement: "SELECT :value AS answer",
	parameters: [{ name: "value", type: "STRING" as const, value: "42" }],
	pollIntervalMs: 0,
};

describe("Databricks SQL protocol", () => {
	it("uses only explicit OAuth credentials, named parameters and bounded inline results", async () => {
		const fetchImpl = harness(() => json(success));
		const result = await executeDatabricksSql(credentials, {
			...input,
			fetchImpl,
		});
		expect(result.rows).toEqual([["42"]]);
		const [, init] = fetchImpl.mock.calls.find(([url]) =>
			String(url).endsWith("/sql/statements"),
		)!;
		expect(JSON.parse(String(init?.body))).toMatchObject({
			warehouse_id: "example-warehouse",
			parameters: input.parameters,
			byte_limit: 1000000,
			row_limit: 100,
			disposition: "INLINE",
		});
		expect(
			fetchImpl.mock.calls.every(
				([url, options]) =>
					String(url).startsWith(host) &&
					options?.redirect === "error",
			),
		).toBe(true);
		expect(new Headers(init?.headers).get("Authorization")).toBe(
			"Bearer example-token",
		);
	});
	it.each([
		"http://example.cloud.databricks.com",
		"https://localhost",
		"https://127.0.0.1",
		"https://example.com",
		"https://example.cloud.databricks.com/unsafe",
		"https://example.cloud.databricks.com?secret=yes",
		"https://user:secret@example.cloud.databricks.com",
		"https://example.cloud.databricks.com:8443",
	])(
		"rejects unsafe origin %s before any credential send",
		async (origin) => {
			const fetchImpl = harness(() => json(success));
			await expect(
				executeDatabricksSql(
					{ ...credentials, DATABRICKS_HOST: origin },
					{ ...input, fetchImpl },
				),
			).rejects.toThrow();
			expect(fetchImpl).not.toHaveBeenCalled();
		},
	);
	it("does not fall back to environment credentials", async () => {
		const fetchImpl = harness(() => json(success));
		await expect(
			executeDatabricksSql({}, { ...input, fetchImpl }),
		).rejects.toThrow();
		expect(fetchImpl).not.toHaveBeenCalled();
	});
	it("refuses stopped compute without submitting or starting it", async () => {
		const fetchImpl = vi.fn<typeof fetch>(async (input) =>
			String(input).endsWith("/token")
				? json({ access_token: "example-token", expires_in: 3600 })
				: json({ state: "STOPPED" }),
		);
		await expect(
			executeDatabricksSql(credentials, { ...input, fetchImpl }),
		).rejects.toThrow("not running");
		expect(
			fetchImpl.mock.calls.some(
				([url, init]) =>
					init?.method === "POST" && String(url).includes("/sql/"),
			),
		).toBe(false);
	});
	it("polls an asynchronous statement and follows only bounded internal result pages", async () => {
		const fetchImpl = harness((path) => {
			if (path.endsWith("/statements"))
				return json({
					statement_id: "example-statement",
					status: { state: "PENDING" },
				});
			if (path.endsWith("/example-statement"))
				return json({
					...success,
					result: {
						data_array: [["first"]],
						next_chunk_internal_link:
							"/api/2.0/sql/statements/example-statement/result/chunks/1?row_offset=1",
					},
				});
			return json({ data_array: [["second"]] });
		});
		const result = await executeDatabricksSql(credentials, {
			...input,
			fetchImpl,
		});
		expect(result.rows).toEqual([["first"], ["second"]]);
	});
	it("rejects external pagination without forwarding credentials", async () => {
		const fetchImpl = harness(() =>
			json({
				...success,
				result: {
					next_chunk_internal_link: "https://example.com/secret",
				},
			}),
		);
		await expect(
			executeDatabricksSql(credentials, { ...input, fetchImpl }),
		).rejects.toThrow("invalid result page");
		expect(
			fetchImpl.mock.calls.every(([url]) => String(url).startsWith(host)),
		).toBe(true);
	});
	it("cancels the remote statement on caller cancellation", async () => {
		const controller = new AbortController();
		const fetchImpl = harness((path) => {
			if (path.endsWith("/statements")) {
				controller.abort();
				return json({
					statement_id: "example-statement",
					status: { state: "RUNNING" },
				});
			}
			return new Response(null, { status: 204 });
		});
		await expect(
			executeDatabricksSql(credentials, {
				...input,
				fetchImpl,
				signal: controller.signal,
			}),
		).rejects.toMatchObject({ statementId: "example-statement" });
		expect(
			fetchImpl.mock.calls.some(
				([url, init]) =>
					String(url).endsWith("/example-statement/cancel") &&
					init?.method === "POST" &&
					!init.signal?.aborted,
			),
		).toBe(true);
	});
	it("does not retry an ambiguous submission or expose provider error bodies", async () => {
		const fetchImpl = harness(() =>
			json({ error: "example-secret private rows" }, 503),
		);
		await expect(
			executeDatabricksSql(credentials, { ...input, fetchImpl }),
		).rejects.toThrow("may have started");
		expect(
			fetchImpl.mock.calls.filter(([url]) =>
				String(url).endsWith("/statements"),
			),
		).toHaveLength(1);
	});
	it("retries an explicit 401 once after refreshing OAuth", async () => {
		let tries = 0;
		const fetchImpl = harness(() =>
			++tries === 1 ? json({}, 401) : json(success),
		);
		await expect(
			executeDatabricksSql(credentials, { ...input, fetchImpl }),
		).resolves.toMatchObject({ rows: [["42"]] });
		expect(
			fetchImpl.mock.calls.filter(([url]) =>
				String(url).endsWith("/statements"),
			),
		).toHaveLength(2);
		expect(
			fetchImpl.mock.calls.filter(([url]) =>
				String(url).endsWith("/token"),
			),
		).toHaveLength(2);
	});
	it("rejects interpolated SQL and duplicate parameters before submitting", async () => {
		const fetchImpl = harness(() => json(success));
		await expect(
			executeDatabricksSql(credentials, {
				...input,
				statement: "SELECT {{unsafe}}",
				fetchImpl,
			}),
		).rejects.toThrow("static text");
		await expect(
			executeDatabricksSql(credentials, {
				...input,
				parameters: [...input.parameters, ...input.parameters],
				fetchImpl,
			}),
		).rejects.toThrow("unique names");
		expect(fetchImpl).not.toHaveBeenCalled();
	});
	it("reports failed statements and a bounded row result without fake success", async () => {
		const fetchImpl = harness(() =>
			json({
				statement_id: "example-statement",
				status: {
					state: "FAILED",
					error: { message: "example-secret" },
				},
			}),
		);
		await expect(
			executeDatabricksSql(credentials, { ...input, fetchImpl }),
		).rejects.toThrow("did not succeed");
		const tooMany = harness(() =>
			json({ ...success, result: { data_array: [["a"], ["b"]] } }),
		);
		await expect(
			executeDatabricksSql(credentials, {
				...input,
				rowLimit: 1,
				fetchImpl: tooMany,
			}),
		).rejects.toThrow("configured limit");
	});
	it("lists metadata without running a statement", async () => {
		const fetchImpl = harness(() =>
			json({
				warehouses: [
					{
						id: "example-warehouse",
						name: "Example",
						state: "RUNNING",
					},
				],
			}),
		);
		expect(
			await listDatabricksSqlWarehouses(credentials, fetchImpl),
		).toHaveLength(1);
		expect(
			fetchImpl.mock.calls.some(([url]) =>
				String(url).includes("statements"),
			),
		).toBe(false);
	});
});
