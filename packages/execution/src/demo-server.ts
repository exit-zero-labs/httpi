import { Buffer } from "node:buffer";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

export const defaultDemoHost = "127.0.0.1";
export const defaultDemoPort = 4318;

interface DemoState {
  basicItems: Map<string, { id: string; name: string; status: string }>;
  commerceCarts: Map<
    string,
    {
      id: string;
      customerId: string;
      items: Array<{ id: string; sku: string; quantity: number }>;
    }
  >;
  commerceOrders: Map<
    string,
    {
      id: string;
      status: string;
      couponCode?: string | undefined;
      shippingNote?: string | undefined;
    }
  >;
  lastCreateBody?: Record<string, unknown>;
  lastApiKey?: string;
  lastCommerceToken?: string;
  lastCommerceBodies: {
    createCart?: Record<string, unknown>;
    addItem?: Record<string, unknown>;
    checkout?: Record<string, unknown>;
  };
  restarts: Array<{
    id: string;
    serviceId: string;
    reason?: string | undefined;
  }>;
  recoveryFailuresRemaining: number;
  flakyUserFailuresRemaining: number;
}

class InvalidJsonBodyError extends Error {
  constructor() {
    super("Invalid JSON request body.");
  }
}

export async function startDemoServer(options: {
  host?: string | undefined;
  port?: number | undefined;
} = {}): Promise<{
  server: ReturnType<typeof createServer>;
  baseUrl: string;
}> {
  const host = options.host ?? defaultDemoHost;
  const port = options.port ?? defaultDemoPort;
  const state: DemoState = {
    basicItems: new Map(),
    commerceCarts: new Map(),
    commerceOrders: new Map(),
    lastCommerceBodies: {},
    restarts: [],
    recoveryFailuresRemaining: 1,
    flakyUserFailuresRemaining: 1,
  };

  const server = createServer(async (request, response) => {
    const requestUrl = new URL(
      request.url ?? "/",
      `http://${host}:${port}`,
    );
    const bodyText = await readRequestBody(request);
    const authHeader = request.headers.authorization;

    if (request.method === "GET" && requestUrl.pathname === "/ping") {
      writeJson(response, 200, { ok: true, service: "runmark-demo" });
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/env/ping") {
      writeJson(response, 200, {
        ok: true,
        environment: requestUrl.searchParams.get("env"),
      });
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/auth/login") {
      const body = parseJsonBodyOrWriteError(response, bodyText);
      if (!body) {
        return;
      }
      if (body.email !== "dev@example.com" || body.password !== "swordfish") {
        writeJson(response, 401, { error: "unauthorized" });
        return;
      }
      writeJson(response, 200, { token: "secret-token" });
      return;
    }

    if (requestUrl.pathname.startsWith("/basic/")) {
      if (!hasBasicAuth(request.headers.authorization, "admin", "swordfish")) {
        writeJson(response, 401, { error: "unauthorized" });
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/basic/items") {
        const body = parseJsonBodyOrWriteError(response, bodyText);
        if (!body) {
          return;
        }
        const itemId = `itm_${slugify(String(body.name ?? "item"))}`;
        const item = {
          id: itemId,
          name: String(body.name ?? "item"),
          status: String(body.status ?? "active"),
        };
        state.basicItems.set(itemId, item);
        writeJson(response, 201, item);
        return;
      }

      const basicItemMatch = requestUrl.pathname.match(/^\/basic\/items\/([^/]+)$/);
      if (basicItemMatch) {
        const itemId = basicItemMatch[1];
        const item = itemId ? state.basicItems.get(itemId) : undefined;
        if (!item) {
          writeJson(response, 404, { error: "not-found" });
          return;
        }

        if (request.method === "GET") {
          writeJson(response, 200, item);
          return;
        }

        if (request.method === "PATCH") {
          const body = parseJsonBodyOrWriteError(response, bodyText);
          if (!body) {
            return;
          }
          item.status = String(body.status ?? item.status);
          writeJson(response, 200, item);
          return;
        }
      }
    }

    if (request.method === "POST" && requestUrl.pathname === "/orders") {
      const apiKey = getHeaderValue(request.headers["x-api-key"]);
      if (apiKey !== "api-token-secret") {
        writeJson(response, 401, { error: "unauthorized" });
        return;
      }

      const body = parseJsonBodyOrWriteError(response, bodyText);
      if (!body) {
        return;
      }
      state.lastApiKey = apiKey;
      state.lastCreateBody = body;
      writeJson(response, 201, {
        id: `ord_${String(body.sku ?? "unknown")}`,
        status: "queued",
      });
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/orders/ord_sku_basic") {
      const apiKey = getHeaderValue(request.headers["x-api-key"]);
      if (apiKey !== "api-token-secret") {
        writeJson(response, 401, { error: "unauthorized" });
        return;
      }

      state.lastApiKey = apiKey;
      writeJson(response, 200, {
        id: "ord_sku_basic",
        status: "queued",
      });
      return;
    }

    if (
      authHeader !== "Bearer secret-token" &&
      authHeader !== "Bearer secondary-secret" &&
      !requestUrl.pathname.startsWith("/commerce/") &&
      !requestUrl.pathname.startsWith("/ops/") &&
      !requestUrl.pathname.startsWith("/recovery/") &&
      requestUrl.pathname !== "/recovery/report"
    ) {
      if (
        requestUrl.pathname === "/users/123" ||
        requestUrl.pathname === "/orders" ||
        requestUrl.pathname === "/users/123/touch" ||
        requestUrl.pathname === "/users/123/fail" ||
        requestUrl.pathname === "/users/123/flaky-once" ||
        requestUrl.pathname === "/session/rotate"
      ) {
        writeJson(response, 401, { error: "unauthorized" });
        return;
      }
    }

    if (request.method === "POST" && requestUrl.pathname === "/session/rotate") {
      writeJson(response, 200, {
        data: {
          refreshToken: "secondary-secret",
        },
        profile: {
          name: "Ada",
        },
      });
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/users/123") {
      writeJson(response, 200, { name: "Ada" });
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/users/123/fail") {
      writeJson(response, 500, {
        error: "upstream-failure",
        echoedToken: "secret-token",
      });
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/users/123/flaky-once") {
      if (state.flakyUserFailuresRemaining > 0) {
        state.flakyUserFailuresRemaining -= 1;
        writeJson(response, 500, {
          error: "transient-upstream-failure",
          echoedToken: "secret-token",
        });
        return;
      }

      writeJson(response, 200, { name: "Ada" });
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/orders") {
      writeJson(response, 200, { orders: [{ id: "ord_1" }] });
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/users/123/touch") {
      const body = parseJsonBodyOrWriteError(response, bodyText);
      if (!body) {
        return;
      }
      writeJson(response, 200, {
        touched: true,
        note: body.note ?? "demo-touch",
      });
      return;
    }

    if (requestUrl.pathname.startsWith("/commerce/")) {
      const apiKey = getHeaderValue(request.headers["x-api-key"]);
      if (apiKey !== "commerce-token-secret") {
        writeJson(response, 401, { error: "unauthorized" });
        return;
      }

      state.lastCommerceToken = apiKey;

      if (request.method === "POST" && requestUrl.pathname === "/commerce/carts") {
        const body = parseJsonBodyOrWriteError(response, bodyText);
        if (!body) {
          return;
        }
        const customerId = String(body.customerId ?? "customer");
        const cartId = `cart_${customerId}`;
        state.lastCommerceBodies.createCart = body;
        state.commerceCarts.set(cartId, {
          id: cartId,
          customerId,
          items: [],
        });
        writeJson(response, 201, {
          id: cartId,
          status: "open",
        });
        return;
      }

      const addItemMatch = requestUrl.pathname.match(/^\/commerce\/carts\/([^/]+)\/items$/);
      if (request.method === "POST" && addItemMatch) {
        const cartId = addItemMatch[1];
        const cart = cartId ? state.commerceCarts.get(cartId) : undefined;
        if (!cart) {
          writeJson(response, 404, { error: "not-found" });
          return;
        }

        const body = parseJsonBodyOrWriteError(response, bodyText);
        if (!body) {
          return;
        }
        const lineItem = {
          id: `li_${String(body.sku ?? "item")}`,
          sku: String(body.sku ?? "item"),
          quantity: Number(body.quantity ?? 1),
        };
        cart.items.push(lineItem);
        state.lastCommerceBodies.addItem = body;
        writeJson(response, 201, {
          id: lineItem.id,
          status: "attached",
        });
        return;
      }

      const checkoutMatch = requestUrl.pathname.match(
        /^\/commerce\/carts\/([^/]+)\/checkout$/,
      );
      if (request.method === "POST" && checkoutMatch) {
        const cartId = checkoutMatch[1];
        const cart = cartId ? state.commerceCarts.get(cartId) : undefined;
        if (!cart) {
          writeJson(response, 404, { error: "not-found" });
          return;
        }

        const body = parseJsonBodyOrWriteError(response, bodyText);
        if (!body) {
          return;
        }
        const firstItem = cart.items[0];
        const orderId = `ord_${cart.customerId}_${firstItem?.sku ?? "empty"}`;
        state.lastCommerceBodies.checkout = body;
        state.commerceOrders.set(orderId, {
          id: orderId,
          status: "queued",
          couponCode:
            typeof body.couponCode === "string" ? body.couponCode : undefined,
          shippingNote:
            typeof body.shippingNote === "string" ? body.shippingNote : undefined,
        });
        writeJson(response, 202, {
          order: {
            id: orderId,
          },
        });
        return;
      }

      const orderMatch = requestUrl.pathname.match(/^\/commerce\/orders\/([^/]+)$/);
      if (request.method === "GET" && orderMatch) {
        const orderId = orderMatch[1];
        const order = orderId ? state.commerceOrders.get(orderId) : undefined;
        if (!order) {
          writeJson(response, 404, { error: "not-found" });
          return;
        }

        writeJson(response, 200, order);
        return;
      }
    }

    if (requestUrl.pathname.startsWith("/ops/")) {
      const opsKey = getHeaderValue(request.headers["x-ops-key"]);
      if (opsKey !== "ops-token-secret") {
        writeJson(response, 401, { error: "unauthorized" });
        return;
      }

      const serviceHealthMatch = requestUrl.pathname.match(
        /^\/ops\/services\/([^/]+)\/health$/,
      );
      if (request.method === "GET" && serviceHealthMatch) {
        writeJson(response, 200, {
          serviceId: serviceHealthMatch[1],
          state: "degraded",
        });
        return;
      }

      const alertsMatch = requestUrl.pathname.match(/^\/ops\/services\/([^/]+)\/alerts$/);
      if (request.method === "GET" && alertsMatch) {
        writeJson(response, 200, {
          serviceId: alertsMatch[1],
          count: 3,
        });
        return;
      }

      const latestDeployMatch = requestUrl.pathname.match(
        /^\/ops\/services\/([^/]+)\/deployments\/latest$/,
      );
      if (request.method === "GET" && latestDeployMatch) {
        writeJson(response, 200, {
          deployment: {
            id: `dep_${latestDeployMatch[1]}_42`,
            status: "complete",
          },
        });
        return;
      }

      const restartMatch = requestUrl.pathname.match(/^\/ops\/services\/([^/]+)\/restart$/);
      if (request.method === "POST" && restartMatch) {
        const body = parseJsonBodyOrWriteError(response, bodyText);
        if (!body) {
          return;
        }
        const record = {
          id: `rst_${restartMatch[1]}_${state.restarts.length + 1}`,
          serviceId: String(restartMatch[1]),
          reason:
            typeof body.reason === "string" ? body.reason : "manual-restart",
        };
        state.restarts.push(record);
        writeJson(response, 202, {
          id: record.id,
          accepted: true,
        });
        return;
      }
    }

    if (requestUrl.pathname === "/recovery/report" && request.method === "GET") {
      if (state.recoveryFailuresRemaining > 0) {
        state.recoveryFailuresRemaining -= 1;
        writeJson(response, 503, {
          error: "upstream-unavailable",
        });
        return;
      }

      writeJson(response, 200, {
        id: "report_daily",
        status: "ready",
      });
      return;
    }

    const recoveryReportMatch = requestUrl.pathname.match(/^\/recovery\/report\/([^/]+)$/);
    if (request.method === "GET" && recoveryReportMatch) {
      writeJson(response, 200, {
        id: recoveryReportMatch[1],
        status: "ready",
      });
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/binary") {
      response.writeHead(200, {
        "content-type": "application/octet-stream",
      });
      response.end(Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]));
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/slow") {
      await new Promise((resolvePromise) => {
        setTimeout(resolvePromise, 200);
      });
      if (!response.destroyed) {
        writeJson(response, 200, { ok: true });
      }
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/override-secret") {
      writeJson(response, 200, { ok: true });
      return;
    }

    writeJson(response, 404, { error: "not-found" });
  });

  await new Promise((resolvePromise) => {
    server.listen(port, host, () => resolvePromise(undefined));
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Unable to determine demo server address.");
  }

  return {
    server,
    baseUrl: `http://${host}:${address.port}`,
  };
}

function parseJsonBody(value: string): Record<string, unknown> {
  if (value.length === 0) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new InvalidJsonBodyError();
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new InvalidJsonBodyError();
  }

  return parsed as Record<string, unknown>;
}

function parseJsonBodyOrWriteError(
  response: ServerResponse,
  value: string,
): Record<string, unknown> | undefined {
  try {
    return parseJsonBody(value);
  } catch (error) {
    if (error instanceof InvalidJsonBodyError) {
      writeJson(response, 400, { error: "invalid-json" });
      return undefined;
    }
    throw error;
  }
}

function getHeaderValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function hasBasicAuth(
  authorization: string | undefined,
  username: string,
  password: string,
): boolean {
  if (!authorization?.startsWith("Basic ")) {
    return false;
  }

  const encoded = authorization.slice("Basic ".length);
  return Buffer.from(encoded, "base64").toString("utf8") === `${username}:${password}`;
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function readRequestBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      resolvePromise(body);
    });
    request.on("error", rejectPromise);
  });
}

function writeJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  const payload = JSON.stringify(body);
  response.writeHead(statusCode, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  response.end(payload);
}
