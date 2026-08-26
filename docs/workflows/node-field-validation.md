# Node Field Validation

How workflow node validation works, and how to prevent field name mismatches between a node's config and its executor.

- **Audience**: engineers adding or changing a Workflow Editor node type or plugin action
- **Owner**: Fabric platform team

## Overview

When a workflow is executed, each node goes through **preflight validation** before running. This validation ensures that:

1. Required fields are present and non-empty
2. Field values are in the correct format
3. Risk assessment is performed for high-risk operations

## The Field Name Problem

The workflow system has multiple components that use node field names:

1. **Workflow Builder UI** (`apps/web/modules/saas/workflows/`) - Uses field names like `aiPrompt`, `slackChannel`
2. **Preflight Validation** (`packages/temporal/src/activities/preflight-validation.ts`) - Validates field presence
3. **Step Implementations** (`packages/temporal/src/activities/lib/steps/`) - Uses fields to execute operations

If these components use different field names, validation can fail even when the user has filled in all required fields.

## Solution: Centralized Field Mappings

We use a single source of truth for field names: `packages/temporal/src/activities/lib/node-field-mappings.ts`

### Field Mapping Structure

```typescript
interface FieldMapping {
  primary: string;     // The main field name used by the workflow builder
  aliases: string[];   // Alternative names (SDK format, legacy, etc.)
  label: string;       // Human-readable label for error messages
  required: boolean;   // Whether this field is required
}
```

### Example: AI Generate Text Node

```typescript
{
  nodeType: "ai-generate-text",
  displayName: "Generate Text",
  requiredFields: [
    {
      primary: "aiPrompt",           // Workflow builder uses this
      aliases: ["prompt", "systemPrompt"],  // SDK may use these
      label: "Prompt",
      required: true,
    },
  ],
}
```

## How Validation Works

1. When a node is about to execute, `preflightValidation()` is called
2. The validation checks for the **primary** field name first
3. If not found, it checks all **aliases**
4. If no valid value is found, validation fails with the field's **label** in the error message

## Adding a New Node Type

When adding a new workflow node type:

### 1. Add Field Definition

Add the node to `NODE_FIELD_DEFINITIONS` in `node-field-mappings.ts`:

```typescript
{
  nodeType: "my-new-node",
  displayName: "My New Node",
  requiredFields: [
    {
      primary: "myField",
      aliases: ["field", "legacyField"],
      label: "My Field",
      required: true,
    },
  ],
}
```

### 2. Add Validation Rule

Add validation in `preflight-validation.ts`:

```typescript
"my-new-node": [
  {
    check: (config) => {
      const myField = config.myField as string | undefined;
      const field = config.field as string | undefined;
      
      const hasField = 
        (myField && myField.trim().length > 0) ||
        (field && field.trim().length > 0);
      
      if (!hasField) {
        return { field: "myField", message: "My Field is required", severity: "error" };
      }
      return null;
    },
  },
],
```

### 3. Add Tests

Add tests in `__tests__/node-field-consistency.test.ts`:

```typescript
describe("my-new-node", () => {
  it("should validate with primary field name", async () => {
    const result = await preflightValidation({
      // ...
      stepType: "my-new-node",
      stepConfig: { myField: "value" },
    });
    expect(result.valid).toBe(true);
  });
});
```

### 4. Run Tests

```bash
pnpm --filter @repo/temporal test
```

## Test Coverage

The test suite includes:

- **199 total tests** across 5 test files
- **Preflight Validation Tests** - Unit tests for each validation rule
- **Node Field Consistency Tests** - Ensures validation matches field definitions
- **Simulated Workflow Builder Scenarios** - End-to-end validation tests

### Running Tests

```bash
# Run all temporal package tests
pnpm --filter @repo/temporal test

# Run in watch mode
pnpm --filter @repo/temporal test:watch
```

## Common Issues

### "Prompt is required" error when prompt exists

**Cause**: The validation rule was checking for `prompt` but the workflow builder saves it as `aiPrompt`.

**Fix**: Ensure the validation rule checks both the primary field and all aliases.

### Empty string validation

Both empty strings (`""`) and whitespace-only strings (`"   "`) are rejected. The validation uses `trim().length > 0` to check for valid values.

## Debugging

Debug logging is enabled for validation failures. Check the Temporal worker logs for:

```
[Preflight] ai-generate-text validation failed. Config keys: ["aiPrompt", "aiModel"]
[Preflight] Config values: { prompt: undefined, systemPrompt: undefined, aiPrompt: "" }
```

This shows exactly what config was passed and why validation failed.

