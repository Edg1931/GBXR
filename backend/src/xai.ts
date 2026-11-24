/**
 * Thin xAI client. Endpoints used:
 *  - POST /realtime/client_secrets   short-lived secret for the app's voice WebSocket
 *  - POST /chat/completions          vision (image_url data URLs) + JSON output, and delegated tasks
 */
export type FetchLike = typeof fetch;

export interface ClientSecret {
  value: string;
  expiresAt: number;
}

export interface Xai {
  mintClientSecret(): Promise<ClientSecret>;
  /** Ask a vision model about images; returns parsed JSON matching the requested schema. */
  visionJson(opts: { system: string; prompt: string; imagesBase64: string[]; schemaName: string; schema: object }): Promise<unknown>;
  complete(opts: { system: string; prompt: string }): Promise<string>;
}

export class XaiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function createXai(opts: {
  apiKey: string;
  baseUrl: string;
  visionModel: string;
  taskModel: string;
  fetch?: FetchLike;
}): Xai {
  const doFetch = opts.fetch ?? fetch;
  const call = async (path: string, body: unknown) => {
    if (!opts.apiKey) throw new XaiError(500, "XAI_API_KEY is not configured");
    const res = await doFetch(`${opts.baseUrl}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${opts.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new XaiError(res.status, `xAI ${path} failed: ${res.status} ${text.slice(0, 300)}`);
    return JSON.parse(text) as any;
  };

  const firstMessage = (r: any): string => {
    const content = r?.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new XaiError(502, "xAI returned no message content");
    return content;
  };

  return {
    async mintClientSecret() {
      const r = await call("/realtime/client_secrets", { expires_after: { seconds: 300 } });
      // Accept both top-level and nested shapes.
      const value = r.value ?? r.client_secret?.value;
      const expiresAt = r.expires_at ?? r.client_secret?.expires_at;
      if (typeof value !== "string") throw new XaiError(502, "xAI returned no client secret");
      return { value, expiresAt: Number(expiresAt ?? Math.floor(Date.now() / 1000) + 300) };
    },

    async visionJson({ system, prompt, imagesBase64, schemaName, schema }) {
      const r = await call("/chat/completions", {
        model: opts.visionModel,
        temperature: 0.2,
        messages: [
          { role: "system", content: system },
          {
            role: "user",
            content: [
              ...imagesBase64.map((b64) => ({
                type: "image_url",
                image_url: { url: `data:image/jpeg;base64,${b64}`, detail: "high" },
              })),
              { type: "text", text: prompt },
            ],
          },
        ],
        response_format: { type: "json_schema", json_schema: { name: schemaName, schema, strict: true } },
      });
      const content = firstMessage(r).trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
      try {
        return JSON.parse(content);
      } catch {
        throw new XaiError(502, "xAI vision did not return valid JSON");
      }
    },

    async complete({ system, prompt }) {
      const r = await call("/chat/completions", {
        model: opts.taskModel,
        messages: [
          { role: "system", content: system },
          { role: "user", content: prompt },
        ],
      });
      return firstMessage(r);
    },
  };
}
