import { describe, expect, test } from "bun:test";
import {
  BUILTIN_MCP_SERVERS,
  type BuiltinMcpServer,
  builtinToken,
  selectBuiltinServers,
  toServerConfig,
} from "./catalog.ts";

const httpServer: BuiltinMcpServer = {
  name: "acme",
  label: "Acme",
  capability: "Do Acme things",
  tokenEnv: ["ACME_TOKEN", "ACME_API_KEY"],
  transport: { type: "http", url: "https://mcp.acme.test/mcp" },
};

const stdioServer: BuiltinMcpServer = {
  name: "local",
  label: "Local",
  capability: "Do local things",
  tokenEnv: ["LOCAL_TOKEN"],
  transport: { type: "stdio", command: "npx", args: ["-y", "local-mcp"], tokenVar: "LOCAL_TOKEN" },
};

describe("builtinToken", () => {
  test("resolves the first present, non-blank env var in priority order", () => {
    expect(builtinToken(httpServer, { ACME_API_KEY: "second" })).toBe("second");
    expect(builtinToken(httpServer, { ACME_TOKEN: "first", ACME_API_KEY: "second" })).toBe("first");
  });

  test("treats a blank value as unset and falls through to the next name", () => {
    expect(builtinToken(httpServer, { ACME_TOKEN: "   ", ACME_API_KEY: "second" })).toBe("second");
    expect(builtinToken(httpServer, { ACME_TOKEN: "  " })).toBeNull();
    expect(builtinToken(httpServer, {})).toBeNull();
  });

  test("trims surrounding whitespace from the token", () => {
    expect(builtinToken(httpServer, { ACME_TOKEN: "  tok  " })).toBe("tok");
  });
});

describe("toServerConfig", () => {
  test("http server carries the token as an Authorization: Bearer header", () => {
    expect(toServerConfig(httpServer, "tok")).toEqual({
      type: "http",
      url: "https://mcp.acme.test/mcp",
      headers: { Authorization: "Bearer tok" },
    });
  });

  test("stdio server hands the token to the child via its own env var", () => {
    expect(toServerConfig(stdioServer, "tok")).toEqual({
      command: "npx",
      args: ["-y", "local-mcp"],
      env: { LOCAL_TOKEN: "tok" },
    });
  });
});

describe("selectBuiltinServers", () => {
  test("enables only servers with a configured credential, building their configs", () => {
    const { enabled, skipped } = selectBuiltinServers([httpServer, stdioServer], { ACME_TOKEN: "tok" });
    expect(enabled.map((s) => s.name)).toEqual(["acme"]);
    expect(enabled[0]?.config).toEqual({
      type: "http",
      url: "https://mcp.acme.test/mcp",
      headers: { Authorization: "Bearer tok" },
    });
    expect(enabled[0]?.capability).toBe("Do Acme things");
    expect(skipped).toEqual([{ name: "local", tokenEnv: ["LOCAL_TOKEN"] }]);
  });

  test("with no credentials, everything is skipped and names which env vars would enable it", () => {
    const { enabled, skipped } = selectBuiltinServers([httpServer, stdioServer], {});
    expect(enabled).toEqual([]);
    expect(skipped).toEqual([
      { name: "acme", tokenEnv: ["ACME_TOKEN", "ACME_API_KEY"] },
      { name: "local", tokenEnv: ["LOCAL_TOKEN"] },
    ]);
  });
});

describe("BUILTIN_MCP_SERVERS catalog", () => {
  test("server names and tool prefixes are unique", () => {
    const names = BUILTIN_MCP_SERVERS.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("ships GitHub, Notion, Linear, Stripe, Canva, and Hugging Face", () => {
    expect(BUILTIN_MCP_SERVERS.map((s) => s.name)).toEqual([
      "github",
      "notion",
      "linear",
      "stripe",
      "canva",
      "huggingface",
    ]);
  });

  test("every entry advertises a capability and at least one credential env var", () => {
    for (const server of BUILTIN_MCP_SERVERS) {
      expect(server.capability.length).toBeGreaterThan(0);
      expect(server.tokenEnv.length).toBeGreaterThan(0);
    }
  });

  test("GitHub connects to the official remote server with a bearer PAT", () => {
    const { enabled } = selectBuiltinServers(BUILTIN_MCP_SERVERS, { GITHUB_MCP_TOKEN: "ghp_x" });
    const github = enabled.find((s) => s.name === "github");
    expect(github?.config).toEqual({
      type: "http",
      url: "https://api.githubcopilot.com/mcp/",
      headers: { Authorization: "Bearer ghp_x" },
    });
  });

  test("Notion uses the official stdio server, handing its token to the child as NOTION_TOKEN", () => {
    const { enabled } = selectBuiltinServers(BUILTIN_MCP_SERVERS, { NOTION_MCP_TOKEN: "ntn_x" });
    const notion = enabled.find((s) => s.name === "notion");
    expect(notion?.config).toEqual({
      command: "npx",
      args: ["-y", "@notionhq/notion-mcp-server"],
      env: { NOTION_TOKEN: "ntn_x" },
    });
  });

  test("a single GitHub token leaves the other apps off", () => {
    const { enabled, skipped } = selectBuiltinServers(BUILTIN_MCP_SERVERS, { GITHUB_MCP_TOKEN: "x" });
    expect(enabled.map((s) => s.name)).toEqual(["github"]);
    expect(skipped.map((s) => s.name)).toEqual(["notion", "linear", "stripe", "canva", "huggingface"]);
  });
});
