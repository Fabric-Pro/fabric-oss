import { defineConfig } from "prisma/config";

const directUrl = process.env.DIRECT_URL;
const databaseCommand = process.argv
	.slice(2)
	.some((argument) => ["migrate", "db", "studio"].includes(argument));

// Build-time generation does not connect to a database. Database commands use
// the direct connection, rather than the application's pooled DATABASE_URL.
if (!directUrl && databaseCommand) {
	throw new Error("DIRECT_URL is required for Prisma database commands.");
}

export default defineConfig({
	schema: "prisma/schema.prisma",
	migrations: { path: "prisma/migrations" },
	datasource: {
		url: directUrl,
		shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL,
	},
});
