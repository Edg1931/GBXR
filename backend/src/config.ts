export interface Config {
  port: number;
  xaiApiKey: string;
  xaiBaseUrl: string;
  visionModel: string;
  taskModel: string;
  supabaseJwtSecret?: string;
  supabaseJwksUrl?: string;
  devAuth: boolean;
  instacartApiKey?: string;
  instacartBaseUrl: string;
  krogerClientId?: string;
  krogerClientSecret?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const opt = (k: string) => (env[k] && env[k]!.trim() !== "" ? env[k]!.trim() : undefined);
  return {
    port: Number(env.PORT ?? 8787),
    xaiApiKey: opt("XAI_API_KEY") ?? "",
    xaiBaseUrl: opt("XAI_BASE_URL") ?? "https://api.x.ai/v1",
    visionModel: opt("XAI_VISION_MODEL") ?? "grok-4.20-0309-non-reasoning",
    taskModel: opt("XAI_TASK_MODEL") ?? "grok-4.20-reasoning",
    supabaseJwtSecret: opt("SUPABASE_JWT_SECRET"),
    supabaseJwksUrl: opt("SUPABASE_JWKS_URL"),
    devAuth: env.DEV_AUTH === "1",
    instacartApiKey: opt("INSTACART_API_KEY"),
    instacartBaseUrl: opt("INSTACART_BASE_URL") ?? "https://connect.dev.instacart.tools",
    krogerClientId: opt("KROGER_CLIENT_ID"),
    krogerClientSecret: opt("KROGER_CLIENT_SECRET"),
  };
}
