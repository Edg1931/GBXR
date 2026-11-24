import type { FetchLike } from "../xai.js";

/**
 * Instacart Developer Platform: creates a hosted shopping-list page where the
 * user picks a store and checks out. Endpoint: POST /idp/v1/products/products_link.
 * Verify field names against docs.instacart.com before going live.
 */
export interface Instacart {
  createShoppingListLink(title: string, items: string[]): Promise<string>;
}

export function createInstacart(opts: { apiKey?: string; baseUrl: string; fetch?: FetchLike }): Instacart {
  const doFetch = opts.fetch ?? fetch;
  // Docs recommend reusing a link until the list changes.
  const cache = new Map<string, string>();
  return {
    async createShoppingListLink(title, items) {
      if (!opts.apiKey) throw new Error("Instacart is not configured");
      const key = JSON.stringify([title, [...items].sort()]);
      const cached = cache.get(key);
      if (cached) return cached;
      const res = await doFetch(`${opts.baseUrl}/idp/v1/products/products_link`, {
        method: "POST",
        headers: { Authorization: `Bearer ${opts.apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          title,
          link_type: "shopping_list",
          line_items: items.map((name) => ({ name, quantity: 1, unit: "each" })),
        }),
      });
      if (!res.ok) throw new Error(`Instacart failed: ${res.status}`);
      const body = (await res.json()) as { products_link_url?: string };
      if (!body.products_link_url) throw new Error("Instacart returned no link");
      cache.set(key, body.products_link_url);
      return body.products_link_url;
    },
  };
}
