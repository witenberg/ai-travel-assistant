import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { duffelGet, hasCredentials } from '../src/tools/duffel/client.js';
import { searchFlights } from '../src/tools/searchFlights.js';
import { ToolError } from '../src/tools/types.js';

const realFetch = globalThis.fetch;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Records every outgoing request so we can assert on headers and payloads. */
function stubFetch(handler: (url: string, init: RequestInit) => Response) {
  const seen: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (input: any, init: any = {}) => {
    seen.push({ url: String(input), init });
    return handler(String(input), init);
  }) as typeof fetch;
  return seen;
}

describe('Duffel client', () => {
  beforeEach(() => { process.env.DUFFEL_ACCESS_TOKEN = 'test_token_secret'; });
  afterEach(() => { globalThis.fetch = realFetch; delete process.env.DUFFEL_ACCESS_TOKEN; });

  test('sends the bearer token and the API version header', async () => {
    const seen = stubFetch(() => json({ data: [] }));
    await duffelGet('/places/suggestions', { query: 'Lisbon' });

    const headers = seen[0]!.init.headers as Record<string, string>;
    assert.equal(headers.authorization, 'Bearer test_token_secret');
    assert.equal(headers['Duffel-Version'], 'v2', 'Duffel requires an explicit API version');
  });

  test('a 401 error message does not leak the response body', async () => {
    stubFetch(() => json({ errors: [{ title: 'token test_token_secret is invalid' }] }, 401));
    await assert.rejects(
      () => duffelGet('/places/suggestions'),
      (err: Error) => {
        assert.ok(err instanceof ToolError);
        assert.doesNotMatch(err.message, /test_token_secret/, 'the credential must not appear in the error');
        return true;
      },
    );
  });

  test('reports a missing token without throwing on the check', () => {
    delete process.env.DUFFEL_ACCESS_TOKEN;
    assert.equal(hasCredentials(), false);
  });

  test('a missing token produces an actionable message', async () => {
    delete process.env.DUFFEL_ACCESS_TOKEN;
    await assert.rejects(() => duffelGet('/x'), /DUFFEL_ACCESS_TOKEN/);
  });
});

describe('search_flights', () => {
  beforeEach(() => { process.env.DUFFEL_ACCESS_TOKEN = 'test_token'; });
  afterEach(() => { globalThis.fetch = realFetch; delete process.env.DUFFEL_ACCESS_TOKEN; });

  test('rejects a malformed date before making any call', async () => {
    const seen = stubFetch(() => json({ data: [] }));
    await assert.rejects(
      () => searchFlights.execute({ origin: 'Warsaw', destination: 'Lisbon', departureDate: '01/09/2026' }),
      /YYYY-MM-DD/,
    );
    assert.equal(seen.length, 0, 'validation must happen before any network call');
  });

  test('reports a past date instead of calling the API', async () => {
    const seen = stubFetch(() => json({ data: [] }));
    const r: any = await searchFlights.execute({
      origin: 'Warsaw', destination: 'Lisbon', departureDate: '2020-01-01',
    });
    assert.equal(r.found, false);
    assert.match(r.message, /in the past/);
    assert.equal(seen.length, 0);
  });

  test('prefers a city code over a single airport code', async () => {
    const seen = stubFetch((url) => {
      if (url.includes('/places/suggestions')) {
        return json({ data: [
          { iata_code: 'WMI', name: 'Modlin', type: 'airport', iata_country_code: 'PL' },
          { iata_code: 'WAW', name: 'Warsaw', type: 'city', iata_country_code: 'PL' },
        ] });
      }
      return json({ data: { offers: [] } });
    });

    await searchFlights.execute({ origin: 'Warsaw', destination: 'Warsaw', departureDate: '2099-01-01' });

    const offerRequest = seen.find((s) => s.url.includes('/air/offer_requests'))!;
    const body = JSON.parse(offerRequest.init.body as string);
    // A city code searches every airport in the metro area; an airport code searches one.
    assert.equal(body.data.slices[0].origin, 'WAW');
  });

  test('maps offers into a flat shape with a readable duration', async () => {
    stubFetch((url) => {
      if (url.includes('/places/suggestions')) {
        return json({ data: [{ iata_code: 'LIS', name: 'Lisbon', type: 'city', iata_country_code: 'PT' }] });
      }
      return json({ data: { offers: [{
        total_amount: '199.99',
        total_currency: 'EUR',
        owner: { name: 'TAP Air Portugal' },
        slices: [{ duration: 'PT4H35M', segments: [
          { departing_at: '2099-01-01T10:00', origin: { iata_code: 'WAW' } },
          { arriving_at: '2099-01-01T14:35', destination: { iata_code: 'LIS' } },
        ] }],
      }] } });
    });

    const r: any = await searchFlights.execute({
      origin: 'Warsaw', destination: 'Lisbon', departureDate: '2099-01-01',
    });

    assert.equal(r.found, true);
    assert.equal(r.offers[0].price, '199.99');
    assert.equal(r.offers[0].airline, 'TAP Air Portugal');
    assert.equal(r.offers[0].duration, '4h 35m', 'ISO-8601 duration should be parsed for the model');
    assert.equal(r.offers[0].stops, 1);
  });

  test('an empty result explains the test-mode limitation', async () => {
    stubFetch((url) =>
      url.includes('/places/suggestions')
        ? json({ data: [{ iata_code: 'LIS', name: 'Lisbon', type: 'city' }] })
        : json({ data: { offers: [] } }),
    );

    const r: any = await searchFlights.execute({
      origin: 'Warsaw', destination: 'Lisbon', departureDate: '2099-01-01',
    });
    assert.equal(r.found, false);
    assert.match(r.message, /test mode/);
  });
});
