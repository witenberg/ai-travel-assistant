import { type Tool } from './types.js';
import { getWeather } from './getWeather.js';
import { getPlaceDetails } from './getPlaceDetails.js';
import { getPhotos } from './getPhotos.js';
import { searchFlights } from './searchFlights.js';

export const TOOLS: readonly Tool[] = [getPlaceDetails, getWeather, getPhotos, searchFlights];

export const byName = (name: string): Tool | undefined => TOOLS.find((t) => t.name === name);

/** Translates our tool contract into the Bedrock Converse API toolConfig. */
export const toolConfig = (tools: readonly Tool[] = TOOLS) => ({
  tools: tools.map((t) => ({
    // The SDK expects DocumentType; our JSON Schema conforms, but the SDK type is wider.
    toolSpec: { name: t.name, description: t.description, inputSchema: { json: t.inputSchema as any } },
  })),
});

export * from './types.js';
export { getWeather, getPlaceDetails, getPhotos, searchFlights };
