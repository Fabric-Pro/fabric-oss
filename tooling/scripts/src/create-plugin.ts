import * as fs from "node:fs";
import * as path from "node:path";
import { logger } from "@repo/logs";

const PLUGINS_DIR = path.resolve(
	__dirname,
	"../../../apps/web/modules/saas/workflows/lib/plugins",
);

const STEPS_DIR = path.resolve(
	__dirname,
	"../../../packages/temporal/src/activities/lib/steps",
);

const STEP_REGISTRY_PATH = path.resolve(
	__dirname,
	"../../../packages/temporal/src/activities/lib/step-registry.ts",
);

interface PluginConfig {
	id: string;
	name: string;
	description: string;
	category:
		| "AI"
		| "Communication"
		| "Productivity"
		| "Developer"
		| "Data"
		| "Web";
	iconName: string;
	hasTestFunction: boolean;
	actions: ActionConfig[];
}

interface ActionConfig {
	slug: string;
	name: string;
	description: string;
}

function toKebabCase(str: string): string {
	return str
		.replace(/([a-z])([A-Z])/g, "$1-$2")
		.replace(/[\s_]+/g, "-")
		.toLowerCase();
}

function toPascalCase(str: string): string {
	return str
		.split(/[-_\s]+/)
		.map(
			(word) =>
				word.charAt(0).toUpperCase() + word.slice(1).toLowerCase(),
		)
		.join("");
}

function toCamelCase(str: string): string {
	const pascal = toPascalCase(str);
	return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

function toScreamingSnakeCase(str: string): string {
	return str
		.replace(/([a-z])([A-Z])/g, "$1_$2")
		.replace(/[\s-]+/g, "_")
		.toUpperCase();
}

function generatePluginIndexFile(config: PluginConfig): string {
	const pluginVarName = `${toCamelCase(config.id)}Plugin`;
	const typeId = toScreamingSnakeCase(config.id);
	const testFunctionName = `test${toPascalCase(config.id)}Connection`;

	const actionsArray = config.actions.map((action) => {
		const stepFunctionName = `${toCamelCase(action.slug)}Step`;
		return `
		{
			slug: "${action.slug}",
			label: "${action.name}",
			description: "${action.description}",
			category: "${config.category}",
			stepFunction: "${stepFunctionName}",
			stepImportPath: "${action.slug}",
			outputFields: [
				// Define what fields this action returns
				// Example: { field: "result", description: "The result of the action" },
			],
			configFields: [
				// Define input fields for this action
				// Example:
				// {
				//   key: "inputField",
				//   label: "Input Field",
				//   type: "template-input",
				//   required: true,
				//   placeholder: "Enter value or {{NodeName.field}}",
				// },
			],
		}`;
	});

	return `/**
 * ${config.name} Integration Plugin
 * 
 * ${config.description}
 * 
 * Aligned with Vercel workflow-builder-template patterns
 */

import { ${config.iconName} } from "lucide-react";
import { registerIntegration } from "../registry";
import type { IntegrationPlugin } from "../types";

export const ${pluginVarName}: IntegrationPlugin = {
	type: "${typeId}" as const, // Add to IntegrationType in types.ts
	label: "${config.name}",
	description: "${config.description}",
	icon: ${config.iconName},
	color: "text-gray-500", // Change to appropriate Tailwind color

	formFields: [
		{
			id: "apiKey",
			label: "API Key",
			type: "password",
			placeholder: "Enter your ${config.name} API key",
			configKey: "apiKey",
			envVar: "${typeId}_API_KEY",
			helpText: "Get your API key from the ${config.name} dashboard",
			required: true,
		},
	],
${
	config.hasTestFunction
		? `
	testConfig: {
		getTestFunction: async () => {
			const { ${testFunctionName} } = await import("./test");
			return ${testFunctionName};
		},
	},
`
		: ""
}
	actions: [${actionsArray.join(",\n")}
	],
};

// Auto-register on import
registerIntegration(${pluginVarName});

export default ${pluginVarName};
`;
}

function generateStepFile(config: PluginConfig, action: ActionConfig): string {
	const stepFunctionName = `execute${toPascalCase(action.slug)}Step`;
	const typeId = toScreamingSnakeCase(config.id);

	return `/**
 * ${action.name} Step
 * ${action.description}
 */

import { fetchCredentialsByProvider } from "@repo/database";
import type { NodeExecutionResult, StepParams } from "../../types";
import { interpolateTemplate } from "./utils";

export async function ${stepFunctionName}(
	params: StepParams,
): Promise<NodeExecutionResult> {
	// Extract config values
	const { /* add your config fields here */ } = params.nodeConfig as {
		// Define your config field types
	};

	// Get credentials for this integration
	const credentials = await fetchCredentialsByProvider(
		"${typeId}",
		params.userId,
		params.organizationId,
	);

	if (!credentials?.${typeId}_API_KEY) {
		return {
			success: false,
			error: "${config.name} API key not configured. Please configure it in Settings > Integrations.",
		};
	}

	try {
		// TODO: Implement your step logic here
		// Use interpolateTemplate() for fields that support {{NodeName.field}} syntax
		// 
		// Example:
		// const interpolatedValue = interpolateTemplate(yourField, params.inputs);
		// 
		// const response = await fetch("https://api.example.com/action", {
		//   method: "POST",
		//   headers: {
		//     "Content-Type": "application/json",
		//     Authorization: \`Bearer \${credentials.${typeId}_API_KEY}\`,
		//   },
		//   body: JSON.stringify({ value: interpolatedValue }),
		// });
		// 
		// const result = await response.json();
		
		return {
			success: true,
			output: {
				// Return output fields that match your outputFields config
				message: "${action.name} completed",
			},
		};
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : "${action.name} failed",
		};
	}
}
`;
}

function generateTestFile(config: PluginConfig): string {
	const functionName = `test${toPascalCase(config.id)}Connection`;
	const typeId = toScreamingSnakeCase(config.id);

	return `/**
 * ${config.name} Integration Test Functions
 */

import type { TestConnectionResult } from "../types";

/**
 * Tests the ${config.name} connection with provided credentials
 */
export async function ${functionName}(
	credentials: Record<string, string>,
): Promise<TestConnectionResult> {
	try {
		const apiKey = credentials.${typeId}_API_KEY;
		
		if (!apiKey) {
			return {
				success: false,
				error: "${typeId}_API_KEY is required",
			};
		}

		// TODO: Implement actual connection test
		// Example:
		// const response = await fetch("https://api.example.com/test", {
		//   headers: { Authorization: \`Bearer \${apiKey}\` },
		// });
		// 
		// if (!response.ok) {
		//   return {
		//     success: false,
		//     error: \`API returned status \${response.status}\`,
		//   };
		// }

		return {
			success: true,
			message: "${config.name} connection successful",
		};
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : "Unknown error",
		};
	}
}
`;
}

function updateStepsIndex(config: PluginConfig): void {
	const stepsIndexPath = path.join(STEPS_DIR, "index.ts");
	let content = fs.readFileSync(stepsIndexPath, "utf-8");

	// Add exports for each action
	const exports = config.actions
		.map((action) => {
			const stepFunctionName = `execute${toPascalCase(action.slug)}Step`;
			const nodeType = `${config.id}-${action.slug}`;
			return `export { ${stepFunctionName} } from "./${nodeType}";`;
		})
		.join("\n");

	// Add comment and exports at the end (before utilities export)
	const utilsExportMatch = content.match(
		/\/\/ Utilities[\s\S]*export \* from "\.\/utils";/,
	);
	if (utilsExportMatch && utilsExportMatch.index !== undefined) {
		const insertPos = utilsExportMatch.index;
		const commentLine = `\n// ${config.name} steps\n`;
		content =
			content.slice(0, insertPos) +
			commentLine +
			exports +
			"\n\n" +
			content.slice(insertPos);
	} else {
		// Just append
		content += `\n// ${config.name} steps\n${exports}\n`;
	}

	fs.writeFileSync(stepsIndexPath, content);
}

function updateStepRegistry(config: PluginConfig): void {
	let content = fs.readFileSync(STEP_REGISTRY_PATH, "utf-8");

	// Find the closing of the stepRegistry object and add entries before it
	const registryEntries = config.actions
		.map((action) => {
			const nodeType = `${config.id}-${action.slug}`;
			const stepFunctionName = `execute${toPascalCase(action.slug)}Step`;
			return `
	"${nodeType}": {
		name: "${action.name}",
		load: async () => {
			const mod = await import("./steps/${nodeType}");
			return mod.${stepFunctionName};
		},
	},`;
		})
		.join("");

	// Find the last entry in the registry (before the closing brace)
	// Look for pattern like "}, };" at the end of registry
	const lastEntryMatch = content.match(/(\t},)\n(\};)/);
	if (lastEntryMatch && lastEntryMatch.index !== undefined) {
		const insertPos = lastEntryMatch.index + lastEntryMatch[1].length;
		const comment = `\n\n\t// ${config.name} steps`;
		content =
			content.slice(0, insertPos) +
			comment +
			registryEntries +
			content.slice(insertPos);
	}

	fs.writeFileSync(STEP_REGISTRY_PATH, content);
}

function updateIndexFile(config: PluginConfig): void {
	const indexPath = path.join(PLUGINS_DIR, "index.ts");
	let content = fs.readFileSync(indexPath, "utf-8");

	const pluginVarName = `${toCamelCase(config.id)}Plugin`;

	// Add import statement for the new plugin
	const importLine = `import "./${config.id}";`;
	const exportLine = `export { ${pluginVarName} } from "./${config.id}";`;

	// Find the last plugin import and add the new one after it
	const lastImportMatch = content.match(
		/import "\.\/[^"]+";(?![\s\S]*import "\.\/[^"]+")/,
	);
	if (lastImportMatch && lastImportMatch.index !== undefined) {
		const insertPos = lastImportMatch.index + lastImportMatch[0].length;
		content =
			content.slice(0, insertPos) +
			`\n${importLine}` +
			content.slice(insertPos);
	} else {
		// If no plugin imports found, add before exports
		const exportsStart = content.indexOf("// Re-export individual plugins");
		if (exportsStart !== -1) {
			content =
				content.slice(0, exportsStart) +
				`${importLine}\n\n` +
				content.slice(exportsStart);
		}
	}

	// Find the last plugin export and add the new one after it
	const lastExportMatch = content.match(
		/export \{ \w+Plugin \} from "\.\/[^"]+";(?![\s\S]*export \{ \w+Plugin \})/,
	);
	if (lastExportMatch && lastExportMatch.index !== undefined) {
		const insertPos = lastExportMatch.index + lastExportMatch[0].length;
		content =
			content.slice(0, insertPos) +
			`\n${exportLine}` +
			content.slice(insertPos);
	}

	fs.writeFileSync(indexPath, content);
}

async function main() {
	logger.info("🔌 Workflow Plugin Generator");
	logger.info(
		"This will create a new integration plugin for the workflow builder.\n",
	);
	logger.info("Aligned with Vercel workflow-builder-template patterns.\n");

	// Plugin ID
	const rawId = await logger.prompt("Enter plugin ID (e.g., my-service):", {
		required: true,
		placeholder: "my-service",
		type: "text",
	});
	const id = toKebabCase(rawId);

	// Plugin Name
	const name = await logger.prompt(
		"Enter plugin display name (e.g., My Service):",
		{
			required: true,
			placeholder: "My Service",
			type: "text",
		},
	);

	// Description
	const description = await logger.prompt("Enter plugin description:", {
		required: true,
		placeholder: "Integration with My Service API",
		type: "text",
	});

	// Icon
	const iconName = await logger.prompt(
		"Enter Lucide icon name (e.g., Sparkles, Globe, Mail):",
		{
			required: true,
			placeholder: "Puzzle",
			type: "text",
		},
	);

	// Category
	const categoryOptions = [
		"AI",
		"Communication",
		"Productivity",
		"Developer",
		"Data",
		"Web",
	];
	logger.info("\nAvailable categories:");
	categoryOptions.forEach((cat, i) => {
		logger.info(`  ${i + 1}. ${cat}`);
	});

	const categoryIndex = await logger.prompt("Select category (1-6):", {
		required: true,
		placeholder: "1",
		type: "text",
	});
	const category = categoryOptions[
		Number.parseInt(categoryIndex, 10) - 1
	] as PluginConfig["category"];

	// Test function
	const hasTestFunction = await logger.prompt(
		"Include test connection function?",
		{
			required: true,
			type: "confirm",
			default: true,
		},
	);

	// Actions
	const actions: ActionConfig[] = [];
	let addMoreActions = true;

	logger.info("\nNow let's define the actions for this plugin.");

	while (addMoreActions) {
		const actionSlug = await logger.prompt(
			"Enter action slug (e.g., send-message):",
			{
				required: true,
				placeholder: "send-message",
				type: "text",
			},
		);

		const actionName = await logger.prompt("Enter action display name:", {
			required: true,
			placeholder: "Send Message",
			type: "text",
		});

		const actionDescription = await logger.prompt(
			"Enter action description:",
			{
				required: true,
				placeholder: "Send a message via My Service",
				type: "text",
			},
		);

		actions.push({
			slug: toKebabCase(actionSlug),
			name: actionName,
			description: actionDescription,
		});

		addMoreActions = await logger.prompt("Add another action?", {
			required: true,
			type: "confirm",
			default: false,
		});
	}

	const config: PluginConfig = {
		id,
		name,
		description,
		category,
		iconName,
		hasTestFunction,
		actions,
	};

	// Create plugin directory
	const pluginDir = path.join(PLUGINS_DIR, id);

	if (fs.existsSync(pluginDir)) {
		const overwrite = await logger.prompt(
			`Plugin "${id}" already exists. Overwrite?`,
			{
				required: true,
				type: "confirm",
				default: false,
			},
		);

		if (!overwrite) {
			logger.info("Aborted.");
			return;
		}
	}

	fs.mkdirSync(pluginDir, { recursive: true });

	// Generate and write plugin index file
	const pluginContent = generatePluginIndexFile(config);
	fs.writeFileSync(path.join(pluginDir, "index.ts"), pluginContent);
	logger.info(`✅ Created plugin file: ${id}/index.ts`);

	// Generate test file if requested
	if (hasTestFunction) {
		const testContent = generateTestFile(config);
		fs.writeFileSync(path.join(pluginDir, "test.ts"), testContent);
		logger.info(`✅ Created test file: ${id}/test.ts`);
	}

	// Generate Temporal step files for each action
	logger.info("\n📦 Creating backend step files...");
	for (const action of actions) {
		const nodeType = `${id}-${action.slug}`;
		const stepContent = generateStepFile(config, action);
		const stepFilePath = path.join(STEPS_DIR, `${nodeType}.ts`);
		fs.writeFileSync(stepFilePath, stepContent);
		logger.info(`✅ Created step file: steps/${nodeType}.ts`);
	}

	// Update steps index.ts
	try {
		updateStepsIndex(config);
		logger.info("✅ Updated steps/index.ts to export step functions");
	} catch (_error) {
		logger.warn(
			"⚠️  Could not auto-update steps/index.ts. Please add manually.",
		);
	}

	// Update step registry
	try {
		updateStepRegistry(config);
		logger.info("✅ Updated step-registry.ts to register steps");
	} catch (_error) {
		logger.warn(
			"⚠️  Could not auto-update step-registry.ts. Please add manually.",
		);
	}

	// Update main index.ts to import the plugin
	try {
		updateIndexFile(config);
		logger.info("✅ Updated plugins index.ts to register the plugin");
	} catch (_error) {
		logger.warn("⚠️  Could not auto-update index.ts. Please add manually:");
		logger.info(`   import "./${id}";`);
		logger.info(`   export { ${toCamelCase(id)}Plugin } from "./${id}";`);
	}

	// Add type reminder
	const typeId = toScreamingSnakeCase(id);
	logger.warn(
		`\n⚠️  Don't forget to add "${typeId}" to IntegrationType in types.ts`,
	);
	logger.warn(
		`⚠️  And add "${typeId}" to WorkflowIntegrationProvider enum in packages/database/prisma/schema.prisma`,
	);

	logger.success("\n🎉 Plugin created successfully!");
	logger.info("\n📋 Files created:");
	logger.info(`   Frontend:  apps/web/.../plugins/${id}/index.ts`);
	if (hasTestFunction) {
		logger.info(`   Test:      apps/web/.../plugins/${id}/test.ts`);
	}
	for (const action of actions) {
		logger.info(
			`   Backend:   packages/temporal/.../steps/${id}-${action.slug}.ts`,
		);
	}

	logger.info("\n📝 Next steps:");
	logger.info(
		`1. Add "${typeId}" to IntegrationType in ${PLUGINS_DIR}/types.ts`,
	);
	logger.info(
		`2. Add "${typeId}" to WorkflowIntegrationProvider in packages/database/prisma/schema.prisma`,
	);
	logger.info(
		"3. Run 'pnpm --filter @repo/database generate' to regenerate Prisma types",
	);
	logger.info(
		`4. Edit ${pluginDir}/index.ts to configure formFields and outputFields`,
	);
	if (hasTestFunction) {
		logger.info(
			`5. Edit ${pluginDir}/test.ts to implement connection testing`,
		);
	}
	logger.info(
		"6. Edit the step files in packages/temporal/.../steps/ to implement your logic",
	);
	logger.info(
		"7. Add credential mapper in packages/database/prisma/queries/workflows/credential-fetcher.ts",
	);
	logger.info("8. Run 'pnpm build' to verify everything compiles");

	logger.info("\n📚 See existing plugins for examples:");
	logger.info("   - Frontend: apps/web/.../plugins/github/index.ts");
	logger.info(
		"   - Backend:  packages/temporal/.../steps/github-create-issue.ts",
	);
}

main().catch((error) => {
	logger.error("Failed to create plugin:", error);
	process.exit(1);
});
