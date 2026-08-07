// Amadeus Self-Service adapter — live flight and hotel inventory.
//
// Env-gated: set AMADEUS_CLIENT_ID + AMADEUS_CLIENT_SECRET and every scan hits
// the real API. Without them the service falls back to deterministic fixtures
// (see fixtures.ts), so the demo never requires a paid key.
//
// Free test credentials: https://developers.amadeus.com (test.api.amadeus.com
// serves a cached subset of production inventory — good enough to see real
// offer shapes; set AMADEUS_BASE_URL=https://api.amadeus.com for production.)

const BASE_URL = (process.env.AMADEUS_BASE_URL ?? "https://test.api.amadeus.com").replace(/\/$/, "");
const TIMEOUT_MS = 12_000;

export function amadeusConfigured(): boolean {
  return Boolean(process.env.AMADEUS_CLIENT_ID && process.env.AMADEUS_CLIENT_SECRET);
}

let token: { value: string; expiresAt: number } | null = null;

/** OAuth2 client_credentials token, cached until 30s before expiry. */
async function getToken(): Promise<string> {
  if (token && token.expiresAt > Date.now()) return token.value;
  const res = await fetch(`${BASE_URL}/v1/security/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: process.env.AMADEUS_CLIENT_ID ?? "",
      client_secret: process.env.AMADEUS_CLIENT_SECRET ?? "",
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Amadeus auth failed (${res.status})`);
  const body = (await res.json()) as { access_token: string; expires_in: number };
  token = { value: body.access_token, expiresAt: Date.now() + (body.expires_in - 30) * 1000 };
  return token.value;
}

async function amadeusGet<T>(path: string, params: Record<string, string>): Promise<T> {
  const url = `${BASE_URL}${path}?${new URLSearchParams(params)}`;
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${await getToken()}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Amadeus ${path} returned ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
  }
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Flights
// ---------------------------------------------------------------------------

export interface FlightCandidate {
  id: string;
  priceUsd: number;
  currency: string;
  carrier: string;
  stops: number;
  departureAt: string;
  arrivalAt: string;
  durationIso: string;
  seatsRemaining: number | null;
  cabin: string | null;
  segments: { from: string; to: string; departureAt: string; arrivalAt: string; carrier: string; number: string }[];
}

interface AmadeusFlightOffer {
  id: string;
  price: { total: string; currency: string };
  numberOfBookableSeats?: number;
  validatingAirlineCodes?: string[];
  travelerPricings?: { fareDetailsBySegment?: { cabin?: string }[] }[];
  itineraries: {
    duration: string;
    segments: {
      departure: { iataCode: string; at: string };
      arrival: { iataCode: string; at: string };
      carrierCode: string;
      number: string;
    }[];
  }[];
}

export interface FlightQuery {
  origin: string;
  destination: string;
  departureDate: string;
  returnDate?: string;
  adults: number;
  cabin?: string;
  nonStop?: boolean;
  max?: number;
}

export async function searchFlights(q: FlightQuery): Promise<FlightCandidate[]> {
  const params: Record<string, string> = {
    originLocationCode: q.origin,
    destinationLocationCode: q.destination,
    departureDate: q.departureDate,
    adults: String(q.adults),
    currencyCode: "USD",
    max: String(Math.min(q.max ?? 12, 20)),
  };
  if (q.returnDate) params.returnDate = q.returnDate;
  if (q.cabin) params.travelClass = q.cabin.toUpperCase();
  if (q.nonStop) params.nonStop = "true";

  const body = await amadeusGet<{ data?: AmadeusFlightOffer[] }>("/v2/shopping/flight-offers", params);
  return (body.data ?? []).map((offer) => {
    const outbound = offer.itineraries[0];
    const segments = outbound.segments.map((s) => ({
      from: s.departure.iataCode,
      to: s.arrival.iataCode,
      departureAt: s.departure.at,
      arrivalAt: s.arrival.at,
      carrier: s.carrierCode,
      number: s.number,
    }));
    return {
      id: `amadeus_flight_${offer.id}`,
      priceUsd: Number(offer.price.total),
      currency: offer.price.currency,
      carrier: offer.validatingAirlineCodes?.[0] ?? segments[0]?.carrier ?? "??",
      stops: Math.max(0, segments.length - 1),
      departureAt: segments[0]?.departureAt ?? q.departureDate,
      arrivalAt: segments[segments.length - 1]?.arrivalAt ?? q.departureDate,
      durationIso: outbound.duration,
      seatsRemaining: offer.numberOfBookableSeats ?? null,
      cabin: offer.travelerPricings?.[0]?.fareDetailsBySegment?.[0]?.cabin ?? null,
      segments,
    };
  });
}

// ---------------------------------------------------------------------------
// Hotels
// ---------------------------------------------------------------------------

export interface HotelCandidate {
  id: string;
  hotelName: string;
  hotelId: string;
  priceUsd: number;
  currency: string;
  roomDescription: string | null;
  boardType: string | null;
  refundable: boolean | null;
  checkIn: string;
  checkOut: string;
}

interface AmadeusHotelOffers {
  data?: {
    hotel: { hotelId: string; name: string };
    offers?: {
      id: string;
      checkInDate: string;
      checkOutDate: string;
      boardType?: string;
      room?: { description?: { text?: string } };
      price: { total: string; currency: string };
      policies?: { refundable?: { cancellationRefund?: string } };
    }[];
  }[];
}

export interface HotelQuery {
  cityCode: string;
  checkIn: string;
  checkOut: string;
  adults: number;
  max?: number;
}

export async function searchHotels(q: HotelQuery): Promise<HotelCandidate[]> {
  const list = await amadeusGet<{ data?: { hotelId: string }[] }>(
    "/v1/reference-data/locations/hotels/by-city",
    { cityCode: q.cityCode, radius: "20", radiusUnit: "KM", hotelSource: "ALL" },
  );
  const hotelIds = (list.data ?? []).slice(0, Math.min(q.max ?? 15, 25)).map((h) => h.hotelId);
  if (hotelIds.length === 0) return [];

  const offers = await amadeusGet<AmadeusHotelOffers>("/v3/shopping/hotel-offers", {
    hotelIds: hotelIds.join(","),
    checkInDate: q.checkIn,
    checkOutDate: q.checkOut,
    adults: String(q.adults),
    currency: "USD",
    bestRateOnly: "true",
  });

  const out: HotelCandidate[] = [];
  for (const entry of offers.data ?? []) {
    for (const offer of entry.offers ?? []) {
      const refund = offer.policies?.refundable?.cancellationRefund;
      out.push({
        id: `amadeus_hotel_${offer.id}`,
        hotelName: entry.hotel.name,
        hotelId: entry.hotel.hotelId,
        priceUsd: Number(offer.price.total),
        currency: offer.price.currency,
        roomDescription: offer.room?.description?.text ?? null,
        boardType: offer.boardType ?? null,
        refundable: refund ? refund !== "NON_REFUNDABLE" : null,
        checkIn: offer.checkInDate,
        checkOut: offer.checkOutDate,
      });
    }
  }
  return out;
}
