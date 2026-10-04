type Config = { baseUrl: string; key: string };

let cfg: Config | null = null;

export function configureApi(c: Config) {
  cfg = c;
}

export function getApiConfig(): Config | null {
  return cfg;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  if (!cfg) throw new Error("API not configured");
  const headers: Record<string, string> = { "X-Bandstand-Key": cfg.key };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(cfg.baseUrl + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}`);
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) return (await res.json()) as T;
  return (await res.blob()) as unknown as T;
}

export const api = {
  get: <T = unknown>(p: string) => request<T>("GET", p),
  put: <T = unknown>(p: string, b?: unknown) => request<T>("PUT", p, b ?? {}),
  post: <T = unknown>(p: string, b?: unknown) => request<T>("POST", p, b ?? {}),
  delete: <T = unknown>(p: string) => request<T>("DELETE", p),
  raw: (p: string, init?: RequestInit) => {
    if (!cfg) throw new Error("API not configured");
    return fetch(cfg.baseUrl + p, {
      ...init,
      headers: { ...init?.headers, "X-Bandstand-Key": cfg.key },
    });
  },
};
