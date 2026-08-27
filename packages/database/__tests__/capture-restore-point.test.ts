import { describe, expect, it } from "vitest";
import {
	checkDumpCompatibility,
	connectionEnv,
	describeUnprovable,
	explainDumpFailure,
	majorVersion,
	parseBranchResponse,
	readConfig,
	restorePointName,
} from "../scripts/capture-restore-point";

const NEON = { NEON_API_KEY: "k", NEON_PROJECT_ID: "p" };
const DUMP = {
	RESTORE_POINT_DIR: "/tmp/rp",
	DATABASE_URL: "postgresql://u:pw@h:5432/db",
};

describe("provider selection", () => {
	it("picks neon from its credentials", () => {
		const r = readConfig(NEON);
		expect(r.configured && r.config.provider).toBe("neon");
	});

	it("picks pg_dump from an output directory and a connection string", () => {
		const r = readConfig(DUMP);
		expect(r.configured && r.config.provider).toBe("pg_dump");
	});

	it("prefers neon when both are configured, since a branch is cheaper", () => {
		const r = readConfig({ ...NEON, ...DUMP });
		expect(r.configured && r.config.provider).toBe("neon");
	});

	it("honours an explicit override", () => {
		const r = readConfig({
			...NEON,
			...DUMP,
			RESTORE_POINT_PROVIDER: "pg_dump",
		});
		expect(r.configured && r.config.provider).toBe("pg_dump");
	});

	it("reports what an explicitly requested provider is missing rather than falling back", () => {
		// Silently capturing a dump when the caller asked for a Neon branch would
		// leave them looking for a branch that does not exist.
		const r = readConfig({ ...DUMP, RESTORE_POINT_PROVIDER: "neon" });
		expect(r.configured).toBe(false);
		if (!r.configured) {
			expect(r.reason).toContain("NEON_API_KEY");
			expect(r.reason).toContain("NEON_PROJECT_ID");
		}
	});

	it("rejects an unknown provider name", () => {
		const r = readConfig({ ...NEON, RESTORE_POINT_PROVIDER: "s3" });
		expect(r.configured).toBe(false);
		if (!r.configured) {
			expect(r.reason).toMatch(/expected "neon" or "pg_dump"/);
		}
	});

	it("is unconfigured when nothing is set", () => {
		const r = readConfig({});
		expect(r.configured).toBe(false);
		if (!r.configured) {
			expect(r.reason).toMatch(/no provider configured/);
		}
	});

	it("treats a blank value as absent — an empty CI secret is not configuration", () => {
		expect(
			readConfig({ NEON_API_KEY: "   ", NEON_PROJECT_ID: "p" })
				.configured,
		).toBe(false);
	});

	it("prefers DIRECT_URL, which is what migrations themselves use", () => {
		const r = readConfig({
			RESTORE_POINT_DIR: "/tmp/rp",
			DATABASE_URL: "postgresql://u:pw@pooler/db",
			DIRECT_URL: "postgresql://u:pw@direct/db",
		});
		expect(
			r.configured &&
				r.config.provider === "pg_dump" &&
				r.config.connectionString,
		).toContain("direct");
	});
});

describe("connectionEnv", () => {
	it("splits a connection string into the variables pg_dump reads", () => {
		expect(
			connectionEnv("postgresql://alice:s3cret@db.example:6543/fabric"),
		).toEqual({
			PGHOST: "db.example",
			PGPORT: "6543",
			PGUSER: "alice",
			PGPASSWORD: "s3cret",
			PGDATABASE: "fabric",
		});
	});

	it("carries sslmode through, which managed Postgres requires", () => {
		expect(
			connectionEnv("postgresql://u:p@h/db?sslmode=require").PGSSLMODE,
		).toBe("require");
	});

	it("decodes percent-encoded credentials", () => {
		const env = connectionEnv("postgresql://user%40corp:p%40ss@h/db");
		expect(env.PGUSER).toBe("user@corp");
		expect(env.PGPASSWORD).toBe("p@ss");
	});

	it("omits what the URL does not carry rather than inventing defaults", () => {
		const env = connectionEnv("postgresql://h/db");
		expect(env.PGPORT).toBeUndefined();
		expect(env.PGUSER).toBeUndefined();
		expect(env.PGPASSWORD).toBeUndefined();
	});
});

describe("restorePointName", () => {
	it("carries the commit and a timestamp", () => {
		const name = restorePointName(
			"abcdef1234567890",
			"2026-07-30T21:00:00.000Z",
		);
		expect(name).toContain("abcdef123456");
		expect(name.startsWith("pre-migration-")).toBe(true);
	});

	it("contains no character Neon rejects in a branch name", () => {
		expect(restorePointName("abc", "2026-07-30T21:00:00.000Z")).not.toMatch(
			/[:.]/,
		);
	});

	it("differs between two promotions of the same commit", () => {
		expect(restorePointName("abc", "2026-07-30T21:00:00.000Z")).not.toBe(
			restorePointName("abc", "2026-07-30T21:05:00.000Z"),
		);
	});

	it("does not throw when the commit is unknown", () => {
		expect(
			restorePointName(undefined, "2026-07-30T21:00:00.000Z"),
		).toContain("unknown");
	});
});

describe("parseBranchResponse", () => {
	it("reads id and name", () => {
		expect(
			parseBranchResponse({ branch: { id: "br-1", name: "n" } }),
		).toEqual({
			id: "br-1",
			name: "n",
		});
	});

	it("throws rather than reporting a capture that did not happen", () => {
		expect(() => parseBranchResponse({})).toThrow(/no branch/);
		expect(() => parseBranchResponse({ branch: { id: 5 } })).toThrow(
			/no branch/,
		);
	});
});

describe("checkDumpCompatibility", () => {
	const CLIENT_16 =
		"pg_dump (PostgreSQL) 16.14 (Ubuntu 16.14-1.pgdg24.04+1)\n";

	it("rejects a client older than the server, naming what to install", () => {
		// The exact case that failed on dev: server 17.10, runner client 16.14.
		expect(() =>
			checkDumpCompatibility(CLIENT_16, "17.10 (986efc8)"),
		).toThrow(
			/pg_dump 16 cannot dump a PostgreSQL 17 server.*postgresql-client-17/s,
		);
	});

	it("accepts a matching major", () => {
		expect(() => checkDumpCompatibility(CLIENT_16, "16.14")).not.toThrow();
	});

	it("accepts a client newer than the server", () => {
		expect(() =>
			checkDumpCompatibility("pg_dump (PostgreSQL) 17.2", "16.14"),
		).not.toThrow();
	});

	it("stays out of the way when either version is unparseable", () => {
		expect(() =>
			checkDumpCompatibility("pg_dump (weird build)", "17.10"),
		).not.toThrow();
		expect(() => checkDumpCompatibility(CLIENT_16, "")).not.toThrow();
	});
});

describe("majorVersion", () => {
	it("reads the major from both client and server formats", () => {
		expect(majorVersion("pg_dump (PostgreSQL) 16.14 (Ubuntu ...)")).toBe(
			16,
		);
		expect(majorVersion("17.10 (986efc8)")).toBe(17);
	});

	it("returns undefined rather than guessing", () => {
		expect(majorVersion("no digits here")).toBeUndefined();
	});
});

describe("explainDumpFailure", () => {
	// The message pg_dump actually produced on a dev promotion, 2026-08-19.
	const RLS_ERROR =
		"Command failed: pg_dump --format=custom --file /tmp/restore-points/x.dump\n" +
		'pg_dump: error: query failed: ERROR:  query would be affected by row-level security policy for table "agent"';

	it("explains the row-level-security refusal instead of passing it through raw", () => {
		const explained = explainDumpFailure(new Error(RLS_ERROR));
		expect(explained).toContain("BYPASSRLS");
		expect(explained).toContain("point-in-time recovery");
	});

	it("warns off the flag that makes the error vanish by dropping rows", () => {
		expect(explainDumpFailure(new Error(RLS_ERROR))).toContain(
			"--enable-row-security silently drops rows",
		);
	});

	it("keeps the original text, so nothing is hidden by the explanation", () => {
		expect(explainDumpFailure(new Error(RLS_ERROR))).toContain(RLS_ERROR);
	});

	it("passes an unrelated failure through untouched", () => {
		expect(explainDumpFailure(new Error("connection refused"))).toBe(
			"connection refused",
		);
	});
});

describe("describeUnprovable", () => {
	const NARROW = {
		schema: "public",
		table: "agent",
		reason: "no permissive policy grants this role unconditional visibility",
	};

	it("names each table and why it cannot be proven", () => {
		const message = describeUnprovable([NARROW]);
		expect(message).toContain("public.agent");
		expect(message).toContain("unconditional visibility");
	});

	it("says the capture was refused, not that it succeeded", () => {
		expect(describeUnprovable([NARROW])).toMatch(/^Refusing to capture/);
	});

	it("offers the three ways out", () => {
		const message = describeUnprovable([NARROW]);
		expect(message).toContain("BYPASSRLS");
		expect(message).toContain("unconditional permissive policy");
		expect(message).toContain("point-in-time recovery");
	});

	it("caps a long list rather than printing a whole schema", () => {
		const many = Array.from({ length: 14 }, (_, i) => ({
			...NARROW,
			table: `t${i}`,
		}));
		const message = describeUnprovable(many);
		expect(message).toContain("...and 4 more");
		expect(message).not.toContain("t10");
	});
});
