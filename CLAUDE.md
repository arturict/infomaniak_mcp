# CLAUDE.md - Infomaniak MCP Server

This file provides guidance to Claude Code when working with this codebase.

## Project Overview

This is an MCP (Model Context Protocol) server that provides tools for interacting with the Infomaniak API. It lets AI assistants read and draft e-mail in Infomaniak Mail, work with kDrive files, manage domains and DNS, and (opt-in) web hosting, Swiss Backup, VPS, dedicated servers, SSL certificates, invoicing, kChat and mailbox administration.

## Tech Stack

- **Language**: TypeScript (ES2022)
- **Module System**: Node16 ESM
- **Runtime**: Node.js >= 18 (Docker image: node:22-slim)
- **Key Dependencies**:
  - `@modelcontextprotocol/sdk` - MCP server SDK
  - `zod` - Schema validation
- **Build Output**: `./build/`

## Project Structure

```
src/
├── index.ts              # Entry point: reads env, builds clients, policy and transport
├── server.ts             # Tool definitions (`tools`), call handler, createMcpServer()
├── tool-policy.ts        # Toolsets and access classes; which tools are listed/callable
├── infomaniak-client.ts  # api.infomaniak.com client (domains, DNS, kDrive, hosting, ...)
├── mail-client.ts        # mail.infomaniak.com/api client, ported from Infomaniak's MIT mcp-server-mail
├── mail-tools.ts         # infomaniak_mail_* tool definitions and handler
├── kchat-client.ts       # kChat client
├── content.ts            # File/attachment content blocks, size caps, text detection
├── html.ts               # HTML-to-text for e-mail bodies
├── schemas.ts            # Zod (v3) input schemas and validate()
└── transports/
    ├── stdio.ts          # stdio transport
    └── http.ts           # Streamable HTTP with bearer auth, CORS from env
```

Tests live next to the code as `*.test.ts` (Vitest).

## Build and Run Commands

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript to build/
npm run dev          # Watch mode for development
npm start            # Run the built server
npm test             # Run unit tests
npm run test:watch   # Run tests in watch mode
npm run test:coverage # Run tests with coverage report
npm run typecheck    # Type check without emitting
npm run inspector    # Test with MCP Inspector (requires INFOMANIAK_API_TOKEN env var)
```

## Architecture

- `createMcpServer(deps, options)` lists `tools` filtered by the `ToolPolicy`
  and refuses calls the policy forbids before any validation or API request.
- Every tool must have a rule in `tool-policy.ts` (toolset + access class:
  read, low_risk, write, dangerous, send); unclassified tools are never listed.
  A test fails when a tool has no rule.
- `INFOMANIAK_TOOLSETS` selects groups (default `account,mail,drive,domain`);
  `INFOMANIAK_ALLOW_WRITES`, `INFOMANIAK_ALLOW_DANGEROUS` and
  `INFOMANIAK_ENABLE_MAIL_SEND` unlock access classes.
- API clients are created once per process in `index.ts`; the HTTP transport
  creates one MCP server per session (or per request when stateless).
- Handlers return plain data (serialised as JSON text) or a `ToolContent`
  with ready-made content blocks (images, embedded resources).
- api.infomaniak.com: Bearer token, 60 requests/minute (token bucket + retries).

## Tool Groups

`account`, `mail` (user-side e-mail), `drive` (kDrive), `domain` (domains and
DNS) are enabled by default. `hosting`, `vps`, `dedicated`, `swiss_backup`,
`certificate`, `invoicing`, `kchat`, `mailadmin` (mailbox administration) and
`api` (generic call) are opt-in.

## Development Guidelines

### Adding a New Tool

1. Add tool definition to the `tools` array in `src/server.ts` (mail tools: `src/mail-tools.ts`) with:
   - `name`: Prefixed with `infomaniak_`
   - `description`: Clear description of what it does
   - `inputSchema`: JSON Schema for parameters

2. Add the handler case in `handleToolCall` and a Zod schema in `src/schemas.ts`

3. Classify the tool in `src/tool-policy.ts` (toolset and access class)

4. If needed, add corresponding method to `InfomaniakClient` class with proper TypeScript types

### API Endpoint Patterns

- API version is in the path: `/1/` (v1) or `/2/` (v2 for kDrive)
- Account-scoped endpoints: `/1/account/{account_id}/...`
- Service-specific: `/1/domain/`, `/1/mail/`, `/1/web/`, etc.

### Type Safety

- All API responses use the `ApiResponse<T>` wrapper type
- Create specific interfaces for response data types
- Use `unknown` for endpoints where response structure isn't fully typed

## Testing

Use the MCP Inspector for testing:

```bash
INFOMANIAK_API_TOKEN=your-token npm run inspector
```

## Common Issues

- **401 errors**: Invalid or expired API token
- **403 errors**: Token missing required scope
- **429 errors**: Rate limit exceeded (60 req/min)
- Build errors: Ensure `npm install` was run and TypeScript is installed
