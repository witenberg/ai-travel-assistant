import { type Tool, ToolError } from './types.js';
import { duffelGet, duffelPost } from './duffel/client.js';

/**
 * Flight search via Duffel.
 *
 * Duffel works on IATA codes, not city names, so a search is two calls: resolve each
 * city to a code, then create an offer request. We resolve here rather than asking the
 * model for codes — the same principle as weekday names in get_weather: anything that
 * can be looked up deterministically should not be guessed by the LLM.
 */

interface PlaceSuggestion {
  data?: { iata_code?: string; name?: string; type?: string; iata_country_code?: string }[];
}

interface Segment {
  operating_carrier?: { name?: string; iata_code?: string };
  departing_at?: string;
  arriving_at?: string;
  origin?: { iata_code?: string };
  destination?: { iata_code?: string };
}

interface OfferRequestResponse {
  data?: {
    offers?: {
      total_amount?: string;
      total_currency?: string;
      owner?: { name?: string };
      slices?: { duration?: string; segments?: Segment[] }[];
    }[];
  };
}

/** "PT2H35M" -> "2h 35m". The model should not have to parse ISO-8601 durations. */
const humanDuration = (iso?: string): string | undefined => {
  const m = iso?.match(/PT(?:(\d+)H)?(?:(\d+)M)?/);
  if (!m) return undefined;
  return [m[1] && `${m[1]}h`, m[2] && `${m[2]}m`].filter(Boolean).join(' ') || undefined;
};

/** Prefer a city code over a single airport — it searches every airport in the metro area. */
async function resolveIata(city: string): Promise<{ code: string; label: string } | null> {
  const res = await duffelGet<PlaceSuggestion>('/places/suggestions', { query: city });
  const places = res.data ?? [];
  const hit = places.find((p) => p.type === 'city' && p.iata_code) ?? places.find((p) => p.iata_code);
  if (!hit?.iata_code) return null;
  return {
    code: hit.iata_code,
    label: [hit.name, hit.iata_country_code].filter(Boolean).join(', '),
  };
}

export interface FlightsInput {
  origin: string;
  destination: string;
  departureDate: string;
  adults?: number;
  cabinClass?: 'economy' | 'premium_economy' | 'business' | 'first';
}

const MAX_OFFERS = 5;

export const searchFlights: Tool<FlightsInput> = {
  name: 'search_flights',
  description:
    'Searches for flight offers between two cities on a given date and returns prices, ' +
    'airlines and durations. Use it when the user asks about flights, fares or how to get there.',
  requiredScope: 'flights:read',
  inputSchema: {
    type: 'object',
    properties: {
      origin: { type: 'string', description: 'Departure city, e.g. "Warsaw"' },
      destination: { type: 'string', description: 'Arrival city, e.g. "Lisbon"' },
      departureDate: { type: 'string', description: 'Departure date in YYYY-MM-DD format' },
      adults: { type: 'integer', description: 'Number of adult passengers, default 1', minimum: 1, maximum: 9 },
      cabinClass: {
        type: 'string',
        enum: ['economy', 'premium_economy', 'business', 'first'],
        description: 'Cabin class, default economy',
      },
    },
    required: ['origin', 'destination', 'departureDate'],
  },

  async execute({ origin, destination, departureDate, adults = 1, cabinClass = 'economy' }) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(departureDate)) {
      throw new ToolError(`departureDate must be YYYY-MM-DD, got "${departureDate}"`);
    }
    // Duffel rejects past dates with an opaque error — fail here with a message the model can act on.
    const today = new Date().toISOString().slice(0, 10);
    if (departureDate < today) {
      return { found: false, message: `Departure date ${departureDate} is in the past (today is ${today}).` };
    }

    const [from, to] = await Promise.all([resolveIata(origin), resolveIata(destination)]);
    if (!from) return { found: false, message: `No airport or city found for "${origin}".` };
    if (!to) return { found: false, message: `No airport or city found for "${destination}".` };

    const res = await duffelPost<OfferRequestResponse>('/air/offer_requests?return_offers=true', {
      data: {
        slices: [{ origin: from.code, destination: to.code, departure_date: departureDate }],
        passengers: Array.from({ length: adults }, () => ({ type: 'adult' })),
        cabin_class: cabinClass,
      },
    });

    const offers = (res.data?.offers ?? []).slice(0, MAX_OFFERS).map((offer) => {
      const slice = offer.slices?.[0];
      const segments = slice?.segments ?? [];
      const first = segments[0];
      const last = segments[segments.length - 1];
      return {
        price: offer.total_amount,
        currency: offer.total_currency,
        airline: offer.owner?.name ?? first?.operating_carrier?.name,
        duration: humanDuration(slice?.duration),
        stops: Math.max(segments.length - 1, 0),
        departsAt: first?.departing_at,
        arrivesAt: last?.arriving_at,
        from: first?.origin?.iata_code,
        to: last?.destination?.iata_code,
      };
    });

    if (offers.length === 0) {
      return {
        found: false,
        message:
          `No offers for ${from.code} -> ${to.code} on ${departureDate}. ` +
          `Note: Duffel test mode only carries a subset of airlines and routes.`,
      };
    }

    return { found: true, from: from.label, to: to.label, departureDate, adults, cabinClass, offers };
  },
};
