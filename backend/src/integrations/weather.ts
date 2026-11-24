import type { FetchLike } from "../xai.js";

export interface Weather {
  temperatureF: number;
  precipitationIn: number;
  summary: string;
}

const CODES: Record<number, string> = {
  0: "clear", 1: "mostly clear", 2: "partly cloudy", 3: "overcast", 45: "foggy", 48: "foggy",
  51: "light drizzle", 61: "light rain", 63: "rain", 65: "heavy rain", 71: "light snow", 73: "snow",
  75: "heavy snow", 80: "rain showers", 95: "thunderstorms",
};

/** Open-Meteo: free, no API key. */
export async function currentWeather(lat: number, lon: number, doFetch: FetchLike = fetch): Promise<Weather> {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(lat));
  url.searchParams.set("longitude", String(lon));
  url.searchParams.set("current", "temperature_2m,precipitation,weather_code");
  url.searchParams.set("temperature_unit", "fahrenheit");
  url.searchParams.set("precipitation_unit", "inch");
  const res = await doFetch(url);
  if (!res.ok) throw new Error(`weather failed: ${res.status}`);
  const b = (await res.json()) as { current: { temperature_2m: number; precipitation: number; weather_code: number } };
  return {
    temperatureF: Math.round(b.current.temperature_2m),
    precipitationIn: b.current.precipitation,
    summary: CODES[b.current.weather_code] ?? "mixed",
  };
}
