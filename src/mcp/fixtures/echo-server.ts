/**
 * A minimal but REAL stdio MCP server, used only as a test fixture so the bridge
 * can be exercised end-to-end without any external dependency. It speaks the
 * actual newline-delimited JSON-RPC stdio transport (MCP 2025-03-26): initialize,
 * tools/list, tools/call, ping. Not a mock — a genuine, tiny server.
 */
interface RpcMessage {
  jsonrpc: "2.0";
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
}

function send(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

function handle(message: RpcMessage): void {
  const { id, method, params } = message;
  if (method === "initialize") {
    send({
      id,
      result: {
        protocolVersion: (params?.protocolVersion as string) ?? "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "echo", version: "0.0.0" },
      },
    });
    return;
  }
  if (method === "tools/list") {
    send({
      id,
      result: {
        tools: [
          {
            name: "echo",
            description: "Echo back the given text.",
            inputSchema: {
              type: "object",
              properties: { text: { type: "string" } },
              required: ["text"],
            },
          },
        ],
      },
    });
    return;
  }
  if (method === "tools/call") {
    const args = (params?.arguments as { text?: string } | undefined) ?? {};
    send({ id, result: { content: [{ type: "text", text: String(args.text ?? "") }] } });
    return;
  }
  if (method === "ping") {
    send({ id, result: {} });
    return;
  }
  // Other requests get a clean "method not found"; notifications (no id) are ignored.
  if (id !== undefined) send({ id, error: { code: -32601, message: `method not found: ${method}` } });
}

let buffer = "";
process.stdin.on("data", (chunk: Buffer) => {
  buffer += chunk.toString("utf8");
  let newline = buffer.indexOf("\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) {
      try {
        handle(JSON.parse(line) as RpcMessage);
      } catch {
        /* ignore unparseable lines */
      }
    }
    newline = buffer.indexOf("\n");
  }
});
process.stdin.resume();
