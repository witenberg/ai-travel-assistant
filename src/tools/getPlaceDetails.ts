import { type Tool, fetchJson } from './types.js';

/**
 * Deviation from the diagram: it labelled this tool "LLM knowledge".
 * A tool whose implementation is "the model already knows" is a no-op — it adds
 * a round trip and contributes no data. The Wikipedia REST API is free, needs no
 * key, and returns fresher, citable information.
 * Rationale in CLAUDE.md -> "Deviations from the diagram".
 */

interface Summary {
  title: string;
  description?: string;
  extract?: string;
  content_urls?: { desktop?: { page?: string } };
  coordinates?: { lat: number; lon: number };
}

export interface PlaceInput { place: string }

async function summary(lang: string, place: string): Promise<Summary | null> {
  try {
    return await fetchJson<Summary>(
      `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(place.replace(/ /g, '_'))}`,
    );
  } catch {
    return null;
  }
}

export const getPlaceDetails: Tool<PlaceInput> = {
  name: 'get_place_details',
  description:
    'Returns a description of a travel destination: what it is, what it is known for, ' +
    'where it lies. Use it when the user asks about a destination or its attractions.',
  requiredScope: 'places:read',
  inputSchema: {
    type: 'object',
    properties: {
      place: { type: 'string', description: 'Place name, e.g. "Lisbon" or "Machu Picchu"' },
    },
    required: ['place'],
  },

  async execute({ place }) {
    const doc = await summary('en', place);
    if (!doc?.extract) {
      return { found: false, message: `No description found for "${place}". Answer from your own knowledge and say so.` };
    }
    return {
      found: true,
      title: doc.title,
      shortDescription: doc.description,
      summary: doc.extract,
      coordinates: doc.coordinates,
      source: doc.content_urls?.desktop?.page,
    };
  },
};
