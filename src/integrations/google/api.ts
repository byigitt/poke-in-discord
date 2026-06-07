/**
 * One typed, authenticated fetch for every Google REST call. Returns a
 * discriminated result so tools branch on `ok` instead of juggling try/catch and
 * `res.ok` everywhere — and so a 401 (expired/revoked grant) is easy to surface
 * as "reconnect", distinct from a real API error.
 */
export type GoogleResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly status: number; readonly message: string };

/** Call a Google API with the user's bearer token; parse JSON, or report the failure. */
export async function googleApi<T>(token: string, url: string, init?: RequestInit): Promise<GoogleResult<T>> {
  const res = await fetch(url, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init?.headers as Record<string, string> | undefined),
    },
  });
  const body = await res.text();
  if (!res.ok) return { ok: false, status: res.status, message: body.slice(0, 300) };
  return { ok: true, data: (body ? JSON.parse(body) : {}) as T };
}
