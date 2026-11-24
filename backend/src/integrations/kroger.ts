import type { FetchLike } from "../xai.js";

export interface PriceQuote {
  product: string;
  description: string;
  regular: number;
  promo?: number;
}

/** Anything that can price a product at a store. Kroger is the first provider. */
export interface PriceProvider {
  quote(product: string, locationId: string): Promise<PriceQuote | undefined>;
}

/**
 * Kroger public API: client-credentials OAuth, then product search filtered by
 * store (prices are store-specific). Uses the official API, not scraping.
 */
export function createKroger(opts: { clientId?: string; clientSecret?: string; fetch?: FetchLike }): PriceProvider {
  const doFetch = opts.fetch ?? fetch;
  let token: { value: string; expires: number } | undefined;

  async function accessToken() {
    if (token && token.expires > Date.now() + 30_000) return token.value;
    if (!opts.clientId || !opts.clientSecret) throw new Error("Kroger is not configured");
    const res = await doFetch("https://api.kroger.com/v1/connect/oauth2/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${opts.clientId}:${opts.clientSecret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials&scope=product.compact",
    });
    if (!res.ok) throw new Error(`Kroger auth failed: ${res.status}`);
    const b = (await res.json()) as { access_token: string; expires_in: number };
    token = { value: b.access_token, expires: Date.now() + b.expires_in * 1000 };
    return token.value;
  }

  return {
    async quote(product, locationId) {
      const url = new URL("https://api.kroger.com/v1/products");
      url.searchParams.set("filter.term", product);
      url.searchParams.set("filter.locationId", locationId);
      url.searchParams.set("filter.limit", "5");
      const res = await doFetch(url, { headers: { Authorization: `Bearer ${await accessToken()}`, Accept: "application/json" } });
      if (!res.ok) throw new Error(`Kroger products failed: ${res.status}`);
      const body = (await res.json()) as { data?: Array<{ description?: string; items?: Array<{ price?: { regular?: number; promo?: number } }> }> };
      for (const p of body.data ?? []) {
        const price = p.items?.find((i) => i.price?.regular)?.price;
        if (price?.regular) {
          const promo = price.promo && price.promo > 0 && price.promo < price.regular ? price.promo : undefined;
          return { product, description: p.description ?? product, regular: price.regular, promo };
        }
      }
      return undefined;
    },
  };
}
