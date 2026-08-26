# Examples

## PRD Generation (research → agent → present)
```json
[{"id":"step-1","capability":"web","app":"firecrawl_search","type":"research","description":"Research AI code review tools","expectedOutput":"Competitor analysis"},{"id":"step-2","capability":"agent","app":"project_document_generator","type":"generate","description":"Generate PRD","executor":"project_document_generator","inputs":{"context":"step-1 results"}},{"id":"step-3","capability":"llm","type":"generate","description":"Present PRD sections","expectedOutput":"PRD content"}]
```

## Code Debugging (CUGA handles all)
```json
[{"id":"step-1","capability":"agent","app":"cuga_generalist","type":"generate","description":"Debug script, fix error, test fix","executor":"cuga_generalist","inputs":{"fullTask":true}},{"id":"step-2","capability":"llm","type":"generate","description":"Present fixed code with explanation","expectedOutput":"Fixed code"}]
```

## Browser Automation (CUGA)
```json
[{"id":"step-1","capability":"agent","app":"cuga_generalist","type":"api","description":"Fill contact form on company.com, submit, screenshot confirmation","executor":"cuga_generalist","inputs":{"fullTask":true}},{"id":"step-2","capability":"llm","type":"generate","description":"Confirm submission","expectedOutput":"Confirmation"}]
```

## MCP Update (get → iterate → confirm)
```json
[{"id":"step-1","capability":"mcp_tool","type":"research","description":"Get account context","expectedOutput":"IDs"},{"id":"step-2","capability":"mcp_tool","type":"research","description":"List containers","expectedOutput":"Container IDs"},{"id":"step-3","capability":"mcp_tool","type":"research","description":"Get items","expectedOutput":"Items"},{"id":"step-4","capability":"mcp_tool","type":"api","description":"Update items","iterateOver":"step_3.items"},{"id":"step-5","capability":"llm","type":"generate","description":"Confirm updates","expectedOutput":"Confirmation"}]
```

## MCP Create (get context → create → confirm)
```json
[{"id":"step-1","capability":"mcp_tool","type":"research","description":"Get account context"},{"id":"step-2","capability":"mcp_tool","type":"research","description":"Find target container"},{"id":"step-3","capability":"mcp_tool","type":"api","riskLevel":"high","requiresApproval":true,"description":"Create items"},{"id":"step-4","capability":"llm","type":"generate","description":"Confirm creation"}]
```

## Notes
- MCP: Get identifiers before actions
- CUGA: Pass entire task, don't decompose
- Always end with llm step presenting results
