// Offline only: validate rendered JSON/YAML against `databricks bundle schema`.
// Does not resolve resources, authenticate, contact a workspace or deploy.
const fs = require("node:fs");
const Ajv2020 = require("ajv/dist/2020");
const [schemaPath, ...paths] = process.argv.slice(2);
if (!schemaPath || paths.length === 0) {
	throw new Error("Expected schema and rendered config paths");
}
const ajv = new Ajv2020({ strict: false, allErrors: true });
const validate = ajv.compile(JSON.parse(fs.readFileSync(schemaPath, "utf8")));
for (const path of paths) {
	if (!validate(JSON.parse(fs.readFileSync(path, "utf8")))) {
		// Report schema locations only; no private binding values.
		console.error(
			JSON.stringify(
				validate.errors.map(({ instancePath, keyword }) => ({
					instancePath,
					keyword,
				})),
			),
		);
		process.exit(1);
	}
}
console.log(
	JSON.stringify({
		configs: paths.length,
		schemaValid: true,
		cloudCalls: false,
	}),
);
