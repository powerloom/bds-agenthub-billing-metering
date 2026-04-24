/**
 * Strip sensitive path segments from provider RPC URLs so they can be exposed
 * in GET /credits/plans (e.g. Alchemy/Infura API keys in the path).
 */
export function redactRpcUrlForClient(url: string): string {
  const u = String(url).trim();
  if (!u) {
    return u;
  }
  try {
    const parsed = new URL(u);
    if (/\/v2\//i.test(parsed.pathname)) {
      parsed.pathname = parsed.pathname.replace(/\/v2\/.+$/i, "/v2/*");
    } else if (/\/v1\//i.test(parsed.pathname)) {
      parsed.pathname = parsed.pathname.replace(/\/v1\/.+$/i, "/v1/*");
    }
    parsed.search = "";
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return u;
  }
}
