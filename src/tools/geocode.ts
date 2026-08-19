import { fetchJson } from './types.js';

/**
 * Shared geocoding (open-meteo, free, no key).
 * Two tools need it — weather and photos — hence its own module.
 */

export interface Place {
  latitude: number;
  longitude: number;
  label: string;
  countryCode?: string;
}

interface GeoResponse {
  results?: {
    latitude: number;
    longitude: number;
    name: string;
    country?: string;
    country_code?: string;
  }[];
}

export async function geocode(name: string): Promise<Place | null> {
  const geo = await fetchJson<GeoResponse>(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=1&language=en&format=json`,
  );
  const hit = geo.results?.[0];
  if (!hit) return null;
  return {
    latitude: hit.latitude,
    longitude: hit.longitude,
    label: [hit.name, hit.country].filter(Boolean).join(', '),
    countryCode: hit.country_code,
  };
}
