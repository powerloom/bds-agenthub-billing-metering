export type UsageClientSource = "cli" | "mcp" | "direct" | "unknown";

const CLIENT_SOURCES = new Set<string>(["cli", "mcp", "direct", "unknown"]);

export type DeductUsageMetadata = {
  httpMethod: string;
  requestPath: string;
  routeTemplate: string;
  clientSource: UsageClientSource;
  description: string;
};

function normalizePath(path: string): string {
  const p = path.trim();
  if (!p) return "";
  return p.startsWith("/") ? p : `/${p}`;
}

function normalizeMethod(method: string): string {
  const m = method.trim().toUpperCase();
  return m || "GET";
}

export function normalizeClientSource(raw: unknown): UsageClientSource {
  if (typeof raw !== "string") {
    return "unknown";
  }
  const v = raw.trim().toLowerCase();
  if (CLIENT_SOURCES.has(v)) {
    return v as UsageClientSource;
  }
  return "unknown";
}

export function resolveRouteTemplate(routeTemplate: unknown, requestPath: string): string {
  if (typeof routeTemplate === "string") {
    const t = normalizePath(routeTemplate);
    if (t.startsWith("/mpp/")) {
      return t;
    }
  }
  return "unknown";
}

export function buildUsageMetadata(body: {
  path?: unknown;
  method?: unknown;
  route_template?: unknown;
  client_source?: unknown;
}): DeductUsageMetadata {
  const requestPath = normalizePath(typeof body.path === "string" ? body.path : "");
  const httpMethod = normalizeMethod(typeof body.method === "string" ? body.method : "");
  const routeTemplate = resolveRouteTemplate(body.route_template, requestPath);
  const clientSource = normalizeClientSource(body.client_source);
  const pathForDesc = requestPath || "unknown";
  const description = `usage ${httpMethod} ${pathForDesc}`.slice(0, 500);

  return {
    httpMethod,
    requestPath: requestPath || pathForDesc,
    routeTemplate,
    clientSource,
    description,
  };
}

export type EndpointUsageRow = {
  route_template: string;
  http_method: string;
  call_count: number;
  credits_used: number;
};

export function queryUsageByEndpoint(
  db: import("../types.js").SqliteDb,
  apiKeyId: string,
  since: string,
  limit: number,
): EndpointUsageRow[] {
  return db
    .prepare(
      `SELECT route_template, http_method,
              COUNT(*) AS call_count,
              SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END) AS credits_used
       FROM credit_transactions
       WHERE api_key_id = ? AND type = 'usage' AND created_at >= ?
         AND route_template IS NOT NULL AND route_template != 'unknown'
       GROUP BY route_template, http_method
       ORDER BY credits_used DESC, call_count DESC
       LIMIT ?`,
    )
    .all(apiKeyId, since, limit) as EndpointUsageRow[];
}
