import { type Tool, fetchJson } from './types.js';
import { geocode } from './geocode.js';

/**
 * Photos from Wikimedia Commons instead of AgentCore Browser.
 *
 * The diagram planned a Browser scraping the public web, but Browser is the most
 * expensive component in the architecture (note on the diagram: "ultra drogie").
 * Commons achieves the same for free, without a key and deterministically, and it
 * additionally returns author and licence — attribution that scraping would not give us.
 *
 * We search geographically (by coordinates) rather than by name: that returns photos
 * actually taken at the location, not ones whose filename happens to match.
 */

const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';
const SEARCH_RADIUS_M = 3000;

interface CommonsResponse {
  query?: {
    pages?: Record<string, {
      title?: string;
      imageinfo?: {
        thumburl?: string;
        descriptionurl?: string;
        extmetadata?: Record<string, { value?: string }>;
      }[];
    }>;
  };
}

/** extmetadata returns HTML (e.g. a link to the author profile) — the model gets plain text. */
const stripHtml = (html?: string): string | undefined =>
  html?.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim() || undefined;

export interface PhotosInput { place: string }

const PHOTO_COUNT = 4;

export const getPhotos: Tool<PhotosInput> = {
  name: 'get_photos',
  description:
    'Returns photos of a place from Wikimedia Commons, together with author and licence. ' +
    'Use it when the user asks for photos or wants to see what a place looks like.',
  requiredScope: 'photos:search',
  inputSchema: {
    type: 'object',
    properties: {
      place: { type: 'string', description: 'Place name, e.g. "Lisbon"' },
    },
    required: ['place'],
  },

  async execute({ place }) {
    const location = await geocode(place);
    if (!location) return { found: false, message: `No place found named "${place}".` };

    const url =
      `${COMMONS_API}?action=query&generator=geosearch` +
      `&ggscoord=${location.latitude}%7C${location.longitude}` +
      `&ggsradius=${SEARCH_RADIUS_M}&ggslimit=${PHOTO_COUNT}&ggsnamespace=6` +
      `&prop=imageinfo&iiprop=url%7Cextmetadata&iiurlwidth=800&format=json&origin=*`;

    const data = await fetchJson<CommonsResponse>(url, 8000);
    const pages = Object.values(data.query?.pages ?? {});

    const photos = pages.flatMap((page) => {
      const info = page.imageinfo?.[0];
      if (!info?.thumburl) return [];
      const meta = info.extmetadata ?? {};
      return [{
        url: info.thumburl,
        title: page.title?.replace(/^File:/, '').replace(/\.\w+$/, ''),
        author: stripHtml(meta.Artist?.value) ?? 'unknown',
        license: meta.LicenseShortName?.value ?? 'unknown',
        pageUrl: info.descriptionurl,
      }];
    });

    if (photos.length === 0) {
      return { found: false, message: `No photos within ${SEARCH_RADIUS_M / 1000} km of "${location.label}".` };
    }

    return {
      found: true,
      place: location.label,
      searchRadiusKm: SEARCH_RADIUS_M / 1000,
      photos,
      attributionNote: 'State the author and licence for every photo — required by the Commons licence.',
    };
  },
};
