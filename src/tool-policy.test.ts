import { describe, it, expect } from "vitest";
import { callRefusal, isToolListed, policyFromEnv, toolRule } from "./tool-policy.js";
import { tools } from "./server.js";

const listed = (env: Record<string, string>) => {
  const policy = policyFromEnv(env);
  return new Set(tools.map((t) => t.name).filter((n) => isToolListed(n, policy)));
};

describe("default policy", () => {
  const names = listed({});

  it("lists mail, drive, domain and account read tools plus mail drafts", () => {
    for (const name of [
      "infomaniak_get_profile",
      "infomaniak_mail_read_email",
      "infomaniak_mail_search_emails",
      "infomaniak_mail_create_draft",
      "infomaniak_mail_flag",
      "infomaniak_kdrive_download_file",
      "infomaniak_list_kdrive_files",
      "infomaniak_list_dns_records",
    ]) {
      expect(names).toContain(name);
    }
  });

  it("hides writes, dangerous tools, sending and other toolsets", () => {
    for (const name of [
      "infomaniak_create_dns_record",
      "infomaniak_kdrive_upload_file",
      "infomaniak_renew_domain",
      "infomaniak_update_domain_nameservers",
      "infomaniak_share_kdrive_file",
      "infomaniak_empty_kdrive_trash",
      "infomaniak_mail_send_draft",
      "infomaniak_list_vps",
      "infomaniak_api_call",
      "infomaniak_create_mailbox",
      "infomaniak_kchat_get_me",
    ]) {
      expect(names).not.toContain(name);
    }
  });

  it("refuses a hidden tool when it is called anyway", () => {
    const policy = policyFromEnv({});
    expect(callRefusal("infomaniak_renew_domain", { domain: "example.com" }, policy)).toMatch(/INFOMANIAK_ALLOW_DANGEROUS/);
    expect(callRefusal("infomaniak_kdrive_upload_file", {}, policy)).toMatch(/INFOMANIAK_ALLOW_WRITES/);
    expect(callRefusal("infomaniak_list_vps", {}, policy)).toMatch(/INFOMANIAK_TOOLSETS/);
    expect(callRefusal("infomaniak_mail_send_draft", {}, policy)).toMatch(/INFOMANIAK_ENABLE_MAIL_SEND/);
    expect(callRefusal("infomaniak_not_a_tool", {}, policy)).toMatch(/Unknown tool/);
    expect(callRefusal("infomaniak_mail_create_draft", {}, policy)).toBeNull();
  });
});

describe("opt-in flags", () => {
  it("enables plain writes but keeps dangerous tools hidden", () => {
    const names = listed({ INFOMANIAK_ALLOW_WRITES: "true" });
    expect(names).toContain("infomaniak_create_dns_record");
    expect(names).toContain("infomaniak_kdrive_upload_file");
    expect(names).not.toContain("infomaniak_renew_domain");
    expect(names).not.toContain("infomaniak_share_kdrive_file");
  });

  it("needs both writes and dangerous for dangerous tools", () => {
    expect(listed({ INFOMANIAK_ALLOW_DANGEROUS: "true" })).not.toContain("infomaniak_renew_domain");
    expect(listed({ INFOMANIAK_ALLOW_WRITES: "true", INFOMANIAK_ALLOW_DANGEROUS: "true" })).toContain("infomaniak_renew_domain");
  });

  it("enables sending independently of writes", () => {
    expect(listed({ INFOMANIAK_ENABLE_MAIL_SEND: "true" })).toContain("infomaniak_mail_send_draft");
  });

  it("allows GET through the generic API tool but treats other methods as dangerous", () => {
    const policy = policyFromEnv({ INFOMANIAK_TOOLSETS: "api", INFOMANIAK_ALLOW_WRITES: "true" });
    expect(isToolListed("infomaniak_api_call", policy)).toBe(true);
    expect(callRefusal("infomaniak_api_call", { method: "GET", endpoint: "/1/ping" }, policy)).toBeNull();
    expect(callRefusal("infomaniak_api_call", { method: "delete", endpoint: "/1/x" }, policy)).toMatch(/dangerous/);
  });
});

describe("INFOMANIAK_TOOLSETS", () => {
  it("limits the listed tools to the named toolsets", () => {
    const names = listed({ INFOMANIAK_TOOLSETS: "mail" });
    expect(names).toContain("infomaniak_mail_list_emails");
    expect(names).not.toContain("infomaniak_list_kdrive_files");
  });

  it("accepts all and rejects unknown names", () => {
    expect(listed({ INFOMANIAK_TOOLSETS: "all" })).toContain("infomaniak_list_vps");
    expect(() => policyFromEnv({ INFOMANIAK_TOOLSETS: "mail,email" })).toThrow(/email/);
  });

  it("classifies every defined tool, so none is silently unreachable", () => {
    expect(tools.filter((t) => !toolRule(t.name)).map((t) => t.name)).toEqual([]);
  });
});
