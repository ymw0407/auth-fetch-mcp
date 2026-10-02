import http from "node:http";
import net from "node:net";
import { resolveSafeHost } from "./security.js";

/** Shared by Chromium and its request context; connect only to the checked IP. */
export async function startSafeProxy() {
  const sockets = new Set<net.Socket>();
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url!);
      if (url.protocol !== "http:") throw new Error("Unsupported proxy scheme");
      const ip = await resolveSafeHost(url.hostname.replace(/^\[|\]$/g, ""));
      if (response.destroyed) return;
      const headers: http.OutgoingHttpHeaders = { ...request.headers, host: url.host };
      delete headers["proxy-authorization"];
      delete headers["proxy-connection"];
      const upstream = http.request({
        hostname: ip, port: url.port || 80, method: request.method,
        path: url.pathname + url.search, headers, agent: false,
      }, incoming => {
        response.writeHead(incoming.statusCode || 502, incoming.headers);
        incoming.on("error", () => response.destroy());
        incoming.pipe(response);
      });
      upstream.on("error", () => response.destroy());
      response.on("close", () => upstream.destroy());
      request.on("error", () => upstream.destroy());
      request.pipe(upstream);
    } catch {
      response.writeHead(403).end("Blocked destination");
    }
  });
  const tunnel = async (request: http.IncomingMessage, client: net.Socket, head: Buffer, connect: boolean) => {
    try {
      const url = new URL(connect ? `http://${request.url}` : request.url!);
      if (!["http:", "ws:"].includes(url.protocol)) throw new Error("Unsupported proxy scheme");
      const ip = await resolveSafeHost(url.hostname.replace(/^\[|\]$/g, ""));
      if (client.destroyed) return;
      const upstream = net.connect({ host: ip, port: Number(url.port || (connect ? 443 : 80)) });
      sockets.add(upstream);
      upstream.on("close", () => sockets.delete(upstream));
      upstream.on("error", () => client.destroy());
      client.on("close", () => upstream.destroy());
      upstream.on("connect", () => {
        if (connect) {
          client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        } else {
          const headers = { ...request.headers, host: url.host };
          const lines = Object.entries(headers)
            .filter(([key]) => !key.startsWith("proxy-"))
            .map(([key, value]) => `${key}: ${value}`);
          upstream.write(`${request.method} ${url.pathname}${url.search} HTTP/1.1\r\n${lines.join("\r\n")}\r\n\r\n`);
        }
        if (head.length) upstream.write(head);
        client.pipe(upstream).pipe(client);
      });
    } catch {
      client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    }
  };
  server.on("connect", (request, client, head) => void tunnel(request, client as net.Socket, head, true));
  server.on("upgrade", (request, client, head) => void tunnel(request, client as net.Socket, head, false));
  server.on("connection", socket => {
    sockets.add(socket);
    socket.on("error", () => socket.destroy());
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as net.AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close() {
      for (const socket of sockets) socket.destroy();
      server.close();
    },
  };
}
