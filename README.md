# Infomaniak MCP Server

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A [Model Context Protocol](https://modelcontextprotocol.io/) server for the
[Infomaniak API](https://developer.infomaniak.com/). It lets an AI assistant
read and draft e-mail in Infomaniak Mail, work with client files in kDrive,
and look after domains and DNS. Hosting, VPS, dedicated servers, Swiss Backup,
certificates, invoices, kChat and mailbox administration are available as
opt-in tool groups.

This is a fork of [daniviber/infomaniak_mcp](https://github.com/daniviber/infomaniak_mcp).

## Features

- **Mail**: list mailboxes and folders, list and search e-mails, read an
  e-mail as plain text (HTML converted and truncated), download attachments,
  create, update and delete drafts (with reply threading), move messages,
  mark them read or unread, flag them. Sending is off unless enabled.
- **kDrive**: browse and search files, read file content (text inline, other
  files up to 10 MB as embedded resources), upload files, manage directories,
  trash, versions and favorites.
- **Domains and DNS**: list domains, read nameservers, manage DNS records.
- **Safe defaults**: only read tools and low-risk mail actions are enabled
  out of the box. Writes, dangerous operations and sending each need their
  own environment flag, and hidden tools are refused even if called by name.
- **HTTP transport** with bearer authentication, plus stdio for local clients.

## API token

Create a token in the [Infomaniak Manager](https://manager.infomaniak.com/v3/ng/accounts/token/list)
with the scopes for the tool groups you enable:

| Tool group | Scope |
|------------|-------|
| `mail` (reading and drafting e-mail) | `workspace:mail` |
| `drive` (kDrive) | `drive` |
| `domain` (domains and DNS) | `domain` |
| `account` (profile, accounts, products) | `accounts`, `user_info` |
| `mailadmin`, `hosting`, `vps`, `dedicated`, `swiss_backup`, `certificate`, `invoicing` | the matching product scope (`mail`, `web`, ...) |

Scope names change occasionally; if a call returns 403, check the token's
scopes in the Manager.

## Installation

```bash
git clone https://github.com/arturict/infomaniak_mcp.git
cd infomaniak_mcp
npm ci
npm run build
```

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `INFOMANIAK_API_TOKEN` | required | Infomaniak API token |
| `INFOMANIAK_TOOLSETS` | `account,mail,drive,domain` | Comma-separated tool groups to enable: `account`, `mail`, `drive`, `domain`, `hosting`, `vps`, `dedicated`, `swiss_backup`, `certificate`, `invoicing`, `kchat`, `mailadmin`, `api`, or `all` |
| `INFOMANIAK_ALLOW_WRITES` | `false` | Enable tools that change data (DNS records, kDrive uploads, moves, renames, deletions to trash, ...) |
| `INFOMANIAK_ALLOW_DANGEROUS` | `false` | Together with `INFOMANIAK_ALLOW_WRITES`, enable dangerous tools (see below) |
| `INFOMANIAK_ENABLE_MAIL_SEND` | `false` | Enable `infomaniak_mail_send_draft` |
| `INFOMANIAK_MAIL_TOKEN` | `INFOMANIAK_API_TOKEN` | Separate token for the mail tools, if the main token lacks `workspace:mail` |
| `INFOMANIAK_MAIL_MAILBOX` | first mailbox | Default mailbox for mail tools, as email address or UUID |
| `KDRIVE_ID` | - | Default kDrive ID; makes `drive_id` optional |
| `KCHAT_HOST`, `KCHAT_TOKEN` | - | kChat host (e.g. `yourteam.kchat.infomaniak.com`) and token, for the `kchat` group |
| `MCP_TRANSPORT` | `stdio` | `stdio` or `http` |
| `MCP_AUTH_TOKEN` | - | Bearer token required on `/mcp` in HTTP mode |
| `MCP_ALLOW_NO_AUTH` | `false` | Start HTTP mode without `MCP_AUTH_TOKEN` (only behind a proxy that authenticates) |
| `MCP_HOST` | `0.0.0.0` | HTTP bind address |
| `MCP_PORT` / `PORT` | `3000` | HTTP port |
| `MCP_CORS_ORIGINS` | none | Comma-separated browser origins allowed by CORS; empty disables CORS |
| `MCP_STATELESS` | `false` | Create a server per request instead of keeping sessions |

### Tool access

Every tool has an access class:

- **read**: always enabled.
- **low-risk mail actions**: drafts, moving messages, read/unread and flags
  in the token owner's own mailbox. Always enabled; nothing leaves the mailbox.
- **write**: needs `INFOMANIAK_ALLOW_WRITES=true`.
- **dangerous**: needs `INFOMANIAK_ALLOW_WRITES=true` and
  `INFOMANIAK_ALLOW_DANGEROUS=true`. These are `infomaniak_renew_domain`
  (a purchase), `infomaniak_update_domain_nameservers`,
  `infomaniak_delete_mailbox`, `infomaniak_delete_site`,
  `infomaniak_delete_database`, `infomaniak_empty_kdrive_trash`,
  `infomaniak_share_kdrive_file` (publishes a link), VPS and dedicated server
  reboot/shutdown, and `infomaniak_api_call` with a method other than GET.
- **send**: `infomaniak_mail_send_draft`, needs `INFOMANIAK_ENABLE_MAIL_SEND=true`.

Disabled tools are not listed and are refused when called.

## Running

### stdio (local clients)

```json
{
  "mcpServers": {
    "infomaniak": {
      "command": "node",
      "args": ["/path/to/infomaniak_mcp/build/index.js"],
      "env": { "INFOMANIAK_API_TOKEN": "your-api-token" }
    }
  }
}
```

### HTTP

```bash
MCP_TRANSPORT=http MCP_AUTH_TOKEN="$(openssl rand -hex 32)" \
INFOMANIAK_API_TOKEN=your-api-token node build/index.js
```

Every request to `/mcp` must send `Authorization: Bearer <MCP_AUTH_TOKEN>`.
`/health` is unauthenticated and returns only `{"status":"ok"}`. Put the
server behind HTTPS (a reverse proxy or tunnel) when it is reachable from
other machines.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/mcp` | POST | JSON-RPC messages (initialize, tool calls, ...) |
| `/mcp` | GET | SSE stream for server-to-client messages |
| `/mcp` | DELETE | End a session |

### Docker

```bash
docker build -t infomaniak-mcp .
docker run -p 3000:3000 \
  -e INFOMANIAK_API_TOKEN=your-api-token \
  -e MCP_AUTH_TOKEN=your-mcp-token \
  infomaniak-mcp
```

The image runs the HTTP transport as a non-root user on port 3000.

## Client setup (HTTP)

The examples assume the server runs at `https://mcp.example.com/mcp` and the
bearer token is in the environment variable `INFOMANIAK_MCP_TOKEN`.

**Claude Code**

```bash
claude mcp add --transport http infomaniak https://mcp.example.com/mcp \
  --header "Authorization: Bearer $INFOMANIAK_MCP_TOKEN"
```

**Codex** (`~/.codex/config.toml`)

```toml
[mcp_servers.infomaniak]
url = "https://mcp.example.com/mcp"
bearer_token_env_var = "INFOMANIAK_MCP_TOKEN"
```

**OpenCode** (`opencode.json`)

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "infomaniak": {
      "type": "remote",
      "url": "https://mcp.example.com/mcp",
      "enabled": true,
      "headers": { "Authorization": "Bearer {env:INFOMANIAK_MCP_TOKEN}" }
    }
  }
}
```

## Tools

The default configuration lists 31 tools: everything marked read or
low-risk in the `account`, `mail`, `drive` and `domain` groups.

### mail

| Tool | Access | Description |
|------|--------|-------------|
| `infomaniak_mail_list_mailboxes` | read | Mailboxes the token can read |
| `infomaniak_mail_list_folders` | read | Folders with id, path, role and counts |
| `infomaniak_mail_list_emails` | read | Threads in a folder (default INBOX), filter unread or flagged |
| `infomaniak_mail_search_emails` | read | Search by text, sender, recipient, subject, dates |
| `infomaniak_mail_read_email` | read | One e-mail as plain text (or cleaned HTML), attachments, reply id |
| `infomaniak_mail_download_attachment` | read | Attachment up to 10 MB as image or embedded resource |
| `infomaniak_mail_create_draft` | low-risk | Draft, optionally as a threaded reply and with base64 attachments |
| `infomaniak_mail_update_draft` | low-risk | Change a draft |
| `infomaniak_mail_delete_draft` | low-risk | Delete a draft |
| `infomaniak_mail_move_emails` | low-risk | Move messages to another folder |
| `infomaniak_mail_mark_seen` | low-risk | Mark read or unread |
| `infomaniak_mail_flag` | low-risk | Flag or unflag |
| `infomaniak_mail_send_draft` | send | Send a draft |

Folders can be given by id, role (`INBOX`, `SENT`, `DRAFT`, `TRASH`,
`ARCHIVE`, `SPAM`) or path. Draft attachments are passed as base64 content;
the server never reads local files.

Draft updates and sends start from the draft as this server process saved
it. For a draft created elsewhere or before a restart, the server reads it
from the API and refuses to save it if any field cannot be read safely.

### drive

| Tool | Access |
|------|--------|
| `infomaniak_list_kdrives`, `infomaniak_get_kdrive` | read |
| `infomaniak_list_kdrive_files`, `infomaniak_get_kdrive_file`, `infomaniak_search_kdrive_files` | read |
| `infomaniak_kdrive_download_file` | read |
| `infomaniak_list_kdrive_trash`, `infomaniak_list_kdrive_file_versions`, `infomaniak_get_kdrive_activity`, `infomaniak_list_kdrive_favorites` | read |
| `infomaniak_kdrive_upload_file` | write |
| `infomaniak_create_kdrive_directory`, `infomaniak_move_kdrive_file`, `infomaniak_copy_kdrive_file`, `infomaniak_rename_kdrive_file` | write |
| `infomaniak_delete_kdrive_file`, `infomaniak_restore_kdrive_file`, `infomaniak_add_kdrive_favorite`, `infomaniak_remove_kdrive_favorite` | write |
| `infomaniak_share_kdrive_file`, `infomaniak_empty_kdrive_trash` | dangerous |

`infomaniak_kdrive_download_file` returns text files (txt, md, csv, json,
html, ...) as text and other files up to 10 MB, such as PDFs or Office
documents, as embedded resources. `infomaniak_kdrive_upload_file` takes text
or base64 content up to 10 MB.

### domain

| Tool | Access |
|------|--------|
| `infomaniak_list_domains`, `infomaniak_get_domain`, `infomaniak_get_domain_nameservers`, `infomaniak_list_dns_records` | read |
| `infomaniak_create_dns_record`, `infomaniak_update_dns_record`, `infomaniak_delete_dns_record` | write |
| `infomaniak_update_domain_nameservers`, `infomaniak_renew_domain` | dangerous |

### account

`infomaniak_ping`, `infomaniak_get_profile`, `infomaniak_list_accounts`,
`infomaniak_get_account`, `infomaniak_list_products` (all read).

### Opt-in groups

| Group | Tools |
|-------|-------|
| `mailadmin` | Mail services, mailboxes, aliases, redirections, autoresponders (admin side; cannot read messages) |
| `hosting` | Web hostings, sites, databases, cron jobs, FTP accounts |
| `vps` | List, inspect, boot, reboot and shut down VPS |
| `dedicated` | List, inspect and reboot dedicated servers |
| `swiss_backup` | Swiss Backup products and slots |
| `certificate` | SSL certificates |
| `invoicing` | Invoices |
| `kchat` | Teams, channels, posts and users (needs `KCHAT_HOST` and `KCHAT_TOKEN`) |
| `api` | `infomaniak_api_call` for any endpoint; non-GET methods count as dangerous |

## Development

```bash
npm ci
npm run typecheck
npm test
npm run build
INFOMANIAK_API_TOKEN=your-token npm run inspector   # MCP Inspector over stdio
```

The Infomaniak API allows 60 requests per minute; the client throttles and
retries on 429 and 5xx responses.

## Credits

- The mail client in `src/mail-client.ts` is ported from Infomaniak's
  official [mcp-server-mail](https://github.com/Infomaniak/mcp-server-mail)
  (MIT License); its header carries the license notice.
- kDrive endpoint paths follow Infomaniak's official
  [mcp-server-kdrive](https://github.com/Infomaniak/mcp-server-kdrive).

## License

MIT, see [LICENSE](LICENSE).
