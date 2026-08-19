import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { getWeather } from '../src/tools/getWeather.js';
import { getPhotos } from '../src/tools/getPhotos.js';
import { getPlaceDetails } from '../src/tools/getPlaceDetails.js';
import { TOOLS, toolConfig } from '../src/tools/index.js';

describe('tool registry', () => {
  test('every tool declares a required scope', () => {
    for (const t of TOOLS) assert.match(t.requiredScope, /^[a-z]+:[a-z]+$/);
  });

  test('names are unique', () => {
    assert.equal(new Set(TOOLS.map((t) => t.name)).size, TOOLS.length);
  });

  test('toolConfig has the shape the Converse API requires', () => {
    for (const entry of toolConfig().tools) {
      assert.ok(entry.toolSpec.name);
      assert.ok(entry.toolSpec.description);
      assert.equal((entry.toolSpec.inputSchema.json as any).type, 'object');
    }
  });
});

describe('get_weather (open-meteo, network)', () => {
  test('returns weather for a real city', async () => {
    const r: any = await getWeather.execute({ city: 'Lisbon' });
    assert.equal(r.found, true);
    assert.equal(typeof r.current.temperatureC, 'number');
    assert.equal(r.forecast.length, 7);
  });

  test('weekday names are computed in code, not guessed', async () => {
    const r: any = await getWeather.execute({ city: 'Lisbon' });
    for (const day of r.forecast) {
      const expected = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'UTC' })
        .format(new Date(`${day.date}T12:00:00Z`));
      assert.equal(day.weekday, expected);
    }
  });

  test('reports a missing place instead of throwing', async () => {
    const r: any = await getWeather.execute({ city: 'Xyzqwv Nonexistent' });
    assert.equal(r.found, false);
  });
});

describe('get_place_details (Wikipedia, network)', () => {
  test('returns a place summary', async () => {
    const r: any = await getPlaceDetails.execute({ place: 'Lisbon' });
    assert.equal(r.found, true);
    assert.ok(r.summary.length > 50);
  });
});

describe('get_photos (Wikimedia Commons, network)', () => {
  test('returns nearby photos with attribution', async () => {
    const r: any = await getPhotos.execute({ place: 'Lisbon' });
    assert.equal(r.found, true);
    assert.ok(r.photos.length > 0);
    for (const p of r.photos) {
      assert.match(p.url, /^https:\/\/upload\.wikimedia\.org\//);
      assert.ok(p.author, 'missing author — the Commons licence requires it');
      assert.ok(p.license, 'missing licence');
    }
  });

  test('reports a missing place instead of throwing', async () => {
    const r: any = await getPhotos.execute({ place: 'Xyzqwv Nonexistent' });
    assert.equal(r.found, false);
  });
});
