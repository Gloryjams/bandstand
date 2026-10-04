// What to tell the musician when "Add chart" fails for one file. The server
// answers a refusal with a plain sentence in `detail`; show that when it exists,
// and fall back to a short phrase per status when it does not.

export function uploadFailureMessage(status: number, detail?: string | null): string {
  if (status === 409) return "already in the library";
  if (status === 413) return "too large for this server";
  const sentence = (detail ?? "").trim();
  if (sentence) return sentence;
  if (status === 400) return "unsupported file type";
  return `failed (${status})`;
}

// Reads the `detail` sentence from a failed response, or nothing when the body
// is not the JSON shape the server sends (a proxy page, an empty body).
export async function readFailureDetail(r: Response): Promise<string | undefined> {
  try {
    const body: unknown = await r.json();
    if (body && typeof body === "object" && "detail" in body) {
      const d = (body as { detail: unknown }).detail;
      return typeof d === "string" ? d : undefined;
    }
  } catch {
    // not JSON
  }
  return undefined;
}
