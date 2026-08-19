import { type Tool, fetchJson } from './types.js';
import { geocode } from './geocode.js';

/**
 * Constant, not a parameter. When the model could choose the number of days it
 * asked for 3, cut off the weekend itself, and then reported "no data".
 * Fewer knobs in a tool schema means fewer ways for the model to get it wrong.
 */
const FORECAST_DAYS = 7;

/** WMO codes -> text. Open-meteo returns numbers; the model gets words. */
const WMO: Record<number, string> = {
  0: 'clear sky', 1: 'mainly clear', 2: 'partly cloudy', 3: 'overcast',
  45: 'fog', 48: 'depositing rime fog', 51: 'light drizzle', 53: 'drizzle', 55: 'dense drizzle',
  61: 'light rain', 63: 'rain', 65: 'heavy rain',
  71: 'light snow', 73: 'snow', 75: 'heavy snow',
  80: 'rain showers', 81: 'rain showers', 82: 'violent rain showers',
  95: 'thunderstorm', 96: 'thunderstorm with hail', 99: 'thunderstorm with hail',
};

/**
 * The weekday name is computed here, not by the model. In testing the model was
 * off by one day when deriving weekdays from dates — calendar arithmetic is a job
 * for code, not for an LLM.
 */
const weekdayOf = (isoDate: string): string =>
  new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'UTC' }).format(
    new Date(`${isoDate}T12:00:00Z`),
  );

interface ForecastResponse {
  current?: { temperature_2m: number; weather_code: number; wind_speed_10m: number };
  daily?: {
    time: string[]; temperature_2m_max: number[]; temperature_2m_min: number[];
    precipitation_probability_max: number[]; weather_code: number[];
  };
}

export interface WeatherInput { city: string }

export const getWeather: Tool<WeatherInput> = {
  name: 'get_weather',
  description:
    'Returns current weather and a 7-day forecast for a city. Each day includes its date ' +
    'and weekday name. Use it when the user asks about weather, what to pack, or when to travel.',
  requiredScope: 'weather:read',
  inputSchema: {
    type: 'object',
    properties: {
      city: { type: 'string', description: 'City or place name, e.g. "Lisbon"' },
    },
    required: ['city'],
  },

  async execute({ city }) {
    // Open-meteo does not accept city names — geocode first (shared with get_photos).
    const place = await geocode(city);
    if (!place) return { found: false, message: `No place found named "${city}".` };

    const forecast = await fetchJson<ForecastResponse>(
      `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}` +
        `&current=temperature_2m,weather_code,wind_speed_10m` +
        `&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code` +
        `&forecast_days=${FORECAST_DAYS}&timezone=auto`,
    );

    const d = forecast.daily;
    return {
      found: true,
      place: place.label,
      current: forecast.current && {
        temperatureC: forecast.current.temperature_2m,
        windKmh: forecast.current.wind_speed_10m,
        conditions: WMO[forecast.current.weather_code] ?? 'unknown',
      },
      forecast: d?.time.map((date, i) => ({
        date,
        weekday: weekdayOf(date),
        maxC: d.temperature_2m_max[i],
        minC: d.temperature_2m_min[i],
        rainChancePct: d.precipitation_probability_max[i],
        conditions: WMO[d.weather_code[i] ?? -1] ?? 'unknown',
      })),
    };
  },
};
