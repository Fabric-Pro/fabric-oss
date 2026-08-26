# Dynamic Worker Sandbox API Module

This module provides short-lived JavaScript and TypeScript execution using Cloudflare Dynamic Workers.

## Features

- **JS/TS execution**: Run JavaScript and TypeScript snippets in isolated V8 isolates
- **Stateless**: Each request runs in a fresh execution context
- **Rich output**: Return text and JSON-friendly results plus captured logs
- **Security**: No default network access inside the isolate
- **Shared auth path**: Reuses the existing sandbox worker and JWT auth secret

## API Endpoints

### Execute Code

**POST** `/api/sandbox/execute`

Execute code in a Dynamic Worker isolate.

**Request:**
```json
{
  "code": "console.log('Hello, world!'); return { ok: true };",
  "language": "javascript",
  "timeout": 30000,
}
```

**Response:**
```json
{
  "code": "console.log('Hello, world!'); return { ok: true };",
  "logs": [
    { "type": "stdout", "text": "Hello, world!" }
  ],
  "results": [
    { "type": "json", "json": { "ok": true } }
  ],
  "executionCount": 1,
  "executionTime": 150
}
```

## Configuration

### Sandbox Worker Setup

Deploy `services/sandbox-worker` with a Dynamic Worker Loader binding and point the API at it.

### Environment Variables

Add to `.env.local`:

```bash
SANDBOX_WORKER_URL="https://your-sandbox-worker.workers.dev"
SANDBOX_AUTH_SECRET="replace-with-strong-shared-secret"
```

## Usage Example

```typescript
import { orpcClient } from "@shared/lib/orpc-client";

// Execute JavaScript code
const result = await orpcClient.sandbox.execute({
  code: `
const numbers = [1, 2, 3, 4];
const sum = numbers.reduce((a, b) => a + b, 0);
console.log("sum", sum);
return { sum };
  `,
  language: "javascript",
  timeout: 30000,
});

console.log(result.logs);
console.log(result.results);
```

## Current Status

This module now delegates to the sandbox worker's `/execute` endpoint. The worker must be deployed and configured with a Dynamic Worker Loader binding.

## Documentation

- [Cloudflare Dynamic Workers](https://developers.cloudflare.com/dynamic-workers/)
