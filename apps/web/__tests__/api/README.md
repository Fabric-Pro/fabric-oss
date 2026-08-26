# API Integration Tests

This directory contains all API integration tests for the Fabric application.

## Structure

```
__tests__/api/
├── README.md                           # This file
├── mcp-oauth-flow.integration.test.ts  # OAuth 2.0 + PKCE flow tests
├── mcp-configs.integration.test.ts     # MCP configuration CRUD tests
└── ... (add more API test files here)
```

## Running Tests

### Run all API integration tests
```bash
pnpm --filter @repo/web test -- __tests__/api
```

### Run specific test file
```bash
pnpm --filter @repo/web test -- mcp-oauth-flow
pnpm --filter @repo/web test -- mcp-configs
```

### Run with coverage
```bash
pnpm --filter @repo/web test:coverage -- __tests__/api
```

### Watch mode
```bash
pnpm --filter @repo/web test -- __tests__/api --watch
```

## Test Categories

### MCP OAuth Flow Tests (`mcp-oauth-flow.integration.test.ts`)
Tests the complete OAuth 2.0 + PKCE flow:
- OAuth start (PKCE generation, state management)
- Authorization URL building
- Token exchange (callback)
- Token refresh
- DCR (Dynamic Client Registration)
- Edge cases (expired state, invalid tokens, etc.)

### MCP Configuration Tests (`mcp-configs.integration.test.ts`)
Tests MCP configuration CRUD operations:
- Create configurations (API Key, OAuth2, None)
- Update configurations
- Delete configurations
- List configurations (user & organization scoped)
- Authorization checks

## Writing New API Tests

### Template

```typescript
import { beforeAll, describe, expect, it, vi } from "vitest";

// Mock database
const mockDb = {
  // Add your mocks here
};

vi.mock("@repo/database", () => mockDb);

// Mock auth
vi.mock("@repo/auth", () => ({
  auth: {
    api: {
      getSession: () => ({
        user: { id: "user-123", email: "test@example.com" },
      }),
    },
  },
}));

describe("Your API Integration Tests", () => {
  beforeAll(() => {
    global.fetch = vi.fn();
  });

  it("should test something", async () => {
    // Your test here
  });
});
```

### Best Practices

1. **Mock External Dependencies**: Always mock database, auth, and external services
2. **Test Happy Path First**: Start with successful scenarios
3. **Test Error Cases**: Include validation errors, authorization failures, etc.
4. **Use Descriptive Names**: Test names should clearly describe what's being tested
5. **Keep Tests Isolated**: Each test should be independent
6. **Clean Up Mocks**: Use `beforeEach` and `afterEach` for setup/teardown

## Coverage Goals

- **Target**: 80%+ coverage for API endpoints
- **Focus Areas**:
  - Request validation
  - Authorization checks
  - Business logic
  - Error handling
  - Edge cases

## Debugging Tests

### Enable verbose output
```bash
pnpm --filter @repo/web test -- __tests__/api --reporter=verbose
```

### Debug a single test
```bash
pnpm --filter @repo/web test -- __tests__/api --inspect-brk
```

### View test UI
```bash
pnpm --filter @repo/web test:ui
# Then navigate to __tests__/api
```

## CI/CD Integration

These tests are automatically run in CI/CD pipeline:
```yaml
- name: Run API Integration Tests
  run: pnpm --filter @repo/web test -- __tests__/api
```

## Related Documentation

- [Testing Guide](../../docs/testing.md)
- [MCP Implementation Review](../../docs/mcp.md)
- [Production Improvements](../../docs/production-improvements-summary.md)
