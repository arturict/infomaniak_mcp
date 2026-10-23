/**
 * Which tools a server instance lists and accepts.
 *
 * Every tool belongs to one toolset and one access class. A tool is listed
 * and callable only when its toolset is enabled and its access class is
 * allowed by the environment:
 *
 * - read       always allowed
 * - low_risk   always allowed: changes in the token owner's own mailbox that
 *              are easy to undo (drafts, seen/flag state, moving messages)
 * - write      INFOMANIAK_ALLOW_WRITES=true
 * - dangerous  INFOMANIAK_ALLOW_WRITES=true and INFOMANIAK_ALLOW_DANGEROUS=true:
 *              purchases, nameserver changes, deletions that cannot be undone,
 *              public links, server reboots and non-GET generic API calls
 * - send       INFOMANIAK_ENABLE_MAIL_SEND=true (sending e-mail)
 *
 * Tools without a rule are never listed or callable.
 */

export const TOOLSETS = [
  "account",
  "mail",
  "drive",
  "domain",
  "hosting",
  "vps",
  "dedicated",
  "swiss_backup",
  "certificate",
  "invoicing",
  "kchat",
  "mailadmin",
  "api",
] as const;

export type Toolset = (typeof TOOLSETS)[number];

export const DEFAULT_TOOLSETS: readonly Toolset[] = ["account", "mail", "drive", "domain"];

export type Access = "read" | "low_risk" | "write" | "dangerous" | "send";

export interface ToolRule {
  toolset: Toolset;
  access: Access;
}

export interface ToolPolicy {
  toolsets: ReadonlySet<Toolset>;
  allowWrites: boolean;
  allowDangerous: boolean;
  enableMailSend: boolean;
}

function rules(toolset: Toolset, byAccess: Partial<Record<Access, string[]>>): [string, ToolRule][] {
  const groups: [Access, string[] | undefined][] = [
    ["read", byAccess.read],
    ["low_risk", byAccess.low_risk],
    ["write", byAccess.write],
    ["dangerous", byAccess.dangerous],
    ["send", byAccess.send],
  ];
  return groups.flatMap(([access, names]) =>
    (names ?? []).map((name): [string, ToolRule] => [`infomaniak_${name}`, { toolset, access }]),
  );
}

const TOOL_RULES = new Map<string, ToolRule>([
  ...rules("account", {
    read: ["ping", "get_profile", "list_accounts", "get_account", "list_products"],
  }),
  ...rules("domain", {
    read: ["list_domains", "get_domain", "get_domain_nameservers", "list_dns_records"],
    write: ["create_dns_record", "update_dns_record", "delete_dns_record"],
    dangerous: ["update_domain_nameservers", "renew_domain"],
  }),
  ...rules("mail", {
    read: [
      "mail_list_mailboxes",
      "mail_list_folders",
      "mail_list_emails",
      "mail_search_emails",
      "mail_read_email",
      "mail_download_attachment",
    ],
    low_risk: [
      "mail_create_draft",
      "mail_update_draft",
      "mail_delete_draft",
      "mail_move_emails",
      "mail_mark_seen",
      "mail_flag",
    ],
    send: ["mail_send_draft"],
  }),
  ...rules("drive", {
    read: [
      "list_kdrives",
      "get_kdrive",
      "list_kdrive_files",
      "get_kdrive_file",
      "search_kdrive_files",
      "kdrive_download_file",
      "list_kdrive_trash",
      "list_kdrive_file_versions",
      "get_kdrive_activity",
      "list_kdrive_favorites",
    ],
    write: [
      "kdrive_upload_file",
      "create_kdrive_directory",
      "move_kdrive_file",
      "copy_kdrive_file",
      "rename_kdrive_file",
      "delete_kdrive_file",
      "restore_kdrive_file",
      "add_kdrive_favorite",
      "remove_kdrive_favorite",
    ],
    dangerous: ["share_kdrive_file", "empty_kdrive_trash"],
  }),
  ...rules("mailadmin", {
    read: [
      "list_mail_services",
      "get_mail_service",
      "list_mailboxes",
      "get_mailbox",
      "list_email_redirections",
      "get_mailbox_autoresponder",
      "list_mailbox_folders",
    ],
    write: [
      "create_mailbox",
      "update_mailbox",
      "add_mailbox_alias",
      "delete_mailbox_alias",
      "create_email_redirection",
      "delete_email_redirection",
      "update_mailbox_autoresponder",
    ],
    dangerous: ["delete_mailbox"],
  }),
  ...rules("hosting", {
    read: [
      "list_web_hostings",
      "get_web_hosting",
      "list_sites",
      "get_site",
      "list_databases",
      "get_database",
      "list_cron_jobs",
      "list_ftp_accounts",
    ],
    write: [
      "create_site",
      "update_site",
      "create_database",
      "create_cron_job",
      "update_cron_job",
      "delete_cron_job",
      "create_ftp_account",
      "update_ftp_account",
      "delete_ftp_account",
    ],
    dangerous: ["delete_site", "delete_database"],
  }),
  ...rules("swiss_backup", {
    read: ["list_swiss_backups", "get_swiss_backup", "list_swiss_backup_slots"],
  }),
  ...rules("vps", {
    read: ["list_vps", "get_vps"],
    write: ["boot_vps"],
    dangerous: ["reboot_vps", "shutdown_vps"],
  }),
  ...rules("dedicated", {
    read: ["list_dedicated_servers", "get_dedicated_server"],
    dangerous: ["reboot_dedicated_server"],
  }),
  ...rules("certificate", { read: ["list_certificates", "get_certificate"] }),
  ...rules("invoicing", { read: ["list_invoices", "get_invoice"] }),
  ...rules("kchat", {
    read: [
      "kchat_get_me",
      "kchat_list_teams",
      "kchat_list_my_teams",
      "kchat_list_channels",
      "kchat_list_my_channels",
      "kchat_get_channel",
      "kchat_get_channel_posts",
      "kchat_search_posts",
      "kchat_search_users",
      "kchat_list_users",
    ],
    write: ["kchat_create_post", "kchat_delete_post", "kchat_create_direct"],
  }),
  // The generic call is listed as read; non-GET methods are checked per call.
  ...rules("api", { read: ["api_call"] }),
]);

export function toolRule(name: string): ToolRule | undefined {
  return TOOL_RULES.get(name);
}

function parseFlag(value: string | undefined): boolean {
  return ["true", "1"].includes((value ?? "").trim().toLowerCase());
}

function isToolset(value: string): value is Toolset {
  return (TOOLSETS as readonly string[]).includes(value);
}

/** Read the policy from environment variables; unknown toolset names fail fast. */
export function policyFromEnv(env: Record<string, string | undefined>): ToolPolicy {
  const raw = env.INFOMANIAK_TOOLSETS?.trim();
  let toolsets: Toolset[];
  if (!raw) {
    toolsets = [...DEFAULT_TOOLSETS];
  } else if (raw.toLowerCase() === "all") {
    toolsets = [...TOOLSETS];
  } else {
    const names = raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    const unknown = names.filter((n) => !isToolset(n));
    if (unknown.length > 0) {
      throw new Error(`Unknown INFOMANIAK_TOOLSETS entries: ${unknown.join(", ")}. Valid: ${TOOLSETS.join(", ")}, or all`);
    }
    toolsets = names.filter(isToolset);
  }
  return {
    toolsets: new Set(toolsets),
    allowWrites: parseFlag(env.INFOMANIAK_ALLOW_WRITES),
    allowDangerous: parseFlag(env.INFOMANIAK_ALLOW_DANGEROUS),
    enableMailSend: parseFlag(env.INFOMANIAK_ENABLE_MAIL_SEND),
  };
}

function accessRefusal(access: Access, policy: ToolPolicy): string | null {
  switch (access) {
    case "read":
    case "low_risk":
      return null;
    case "write":
      return policy.allowWrites ? null : "it changes data; set INFOMANIAK_ALLOW_WRITES=true to enable it";
    case "dangerous":
      return policy.allowWrites && policy.allowDangerous
        ? null
        : "it is a dangerous operation; it needs both INFOMANIAK_ALLOW_WRITES=true and INFOMANIAK_ALLOW_DANGEROUS=true";
    case "send":
      return policy.enableMailSend ? null : "sending e-mail is disabled; set INFOMANIAK_ENABLE_MAIL_SEND=true to enable it";
  }
}

/** Whether `tools/list` should include this tool. */
export function isToolListed(name: string, policy: ToolPolicy): boolean {
  const rule = toolRule(name);
  return !!rule && policy.toolsets.has(rule.toolset) && accessRefusal(rule.access, policy) === null;
}

/** Why a call must be refused, or null when it may run. */
export function callRefusal(name: string, args: Record<string, unknown> | undefined, policy: ToolPolicy): string | null {
  const rule = toolRule(name);
  if (!rule) return `Unknown tool: ${name}`;
  if (!policy.toolsets.has(rule.toolset)) {
    return `Tool ${name} is not enabled: add "${rule.toolset}" to INFOMANIAK_TOOLSETS`;
  }
  let access = rule.access;
  if (name === "infomaniak_api_call") {
    const method = typeof args?.method === "string" ? args.method.toUpperCase() : "GET";
    if (method !== "GET") access = "dangerous";
  }
  const reason = accessRefusal(access, policy);
  return reason ? `Tool ${name} is refused: ${reason}` : null;
}
