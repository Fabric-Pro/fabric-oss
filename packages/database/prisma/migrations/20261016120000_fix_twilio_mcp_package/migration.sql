-- Twilio's catalog command pointed at a package that never existed; use Twilio's MCP server.
UPDATE "mcp_server"
   SET "command"     = 'npx -y @twilio-alpha/mcp@0.7.0',
       "docsUrl"     = 'https://www.npmjs.com/package/@twilio-alpha/mcp',
       "description" = 'Your Twilio account: messages, calls, phone numbers and usage. Read data and, with approval, send messages or place calls.'
 WHERE "key" = 'twilio'
   AND "isSystemProvided" = true
   AND "userId" IS NULL
   AND "organizationId" IS NULL;
