import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

// A separate, short-lived capability for exactly one locally approved execution.
export async function collaborationBridge(
  action: (input: any) => unknown,
  directory?: string,
) {
  const token = randomBytes(32).toString("hex");
  const server = createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    const actual = Buffer.from(req.headers.authorization || ""),
      expected = Buffer.from("Bearer " + token);
    if (
      req.headers.origin ||
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    ) {
      res.writeHead(401).end("{}");
      return;
    }
    if (req.method !== "POST" || req.url !== "/action") {
      res.writeHead(404).end("{}");
      return;
    }
    try {
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 64000) throw new Error("请求过大");
        chunks.push(chunk);
      }
      res.end(
        JSON.stringify(
          action(JSON.parse(Buffer.concat(chunks).toString("utf8"))),
        ),
      );
    } catch (e) {
      res.writeHead(400).end(JSON.stringify({ error: String(e) }));
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 5000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const addr = server.address();
  const url = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/action`;
  const file = directory
    ? join(directory, randomBytes(16).toString("hex") + ".json")
    : "";
  try {
    if (file) {
      mkdirSync(directory!, { recursive: true });
      writeFileSync(file, JSON.stringify({ url, token }), {
        mode: 0o600,
        flag: "wx",
      });
    }
  } catch (e) {
    server.close();
    throw e;
  }
  return {
    url,
    token,
    file,
    close: () => {
      server.closeAllConnections();
      server.close();
      if (file) {
        try {
          unlinkSync(file);
        } catch (e) {
          console.error("Mesho: 无法移除已失效的协作接口凭证文件", file);
        }
      }
    },
  };
}
