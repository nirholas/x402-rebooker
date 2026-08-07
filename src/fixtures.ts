// Fixture data — used when AMADEUS_CLIENT_ID/AMADEUS_CLIENT_SECRET (flights,
// hotels) or RIDB_API_KEY (campsites) are unset, or when the live call fails.
//
// Everything here is deterministic: candidates are derived from the booking you
// posted via a seeded hash, so the same request always produces the same report.
// Fixture-backed responses are labeled `source: "fixture"` end to end.

import { createHash } from "node:crypto";
import type { FlightCandidate, HotelCandidate } from "./amadeus.js";
import type { CampsiteCandidate } from "./ridb.js";

/** Deterministic pseudo-random in [0,1) seeded by a string + index. */
function seeded(seed: string, index: number): number {
  const digest = createHash("sha256").update(`${seed}:${index}`).digest();
  return digest.readUInt32BE(0) / 0x1_0000_0000;
}

export function seedOf(input: unknown): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 16);
}

const CARRIERS = ["AA", "DL", "UA", "B6", "AS", "WN"];

function addHours(iso: string, hours: number): string {
  const base = new Date(iso);
  if (Number.isNaN(base.getTime())) return iso;
  return new Date(base.getTime() + hours * 3_600_000).toISOString();
}

export function fixtureFlights(args: {
  origin: string;
  destination: string;
  departureDate: string;
  pricePaidUsd: number;
  adults: number;
}): FlightCandidate[] {
  const seed = seedOf(args);
  const day = `${args.departureDate}T00:00:00Z`;
  return Array.from({ length: 5 }, (_, i) => {
    const r = seeded(seed, i);
    // Cluster around the price paid: some cheaper, some not — a scan that only
    // ever "finds savings" would be a sales pitch, not a tool.
    const factor = 0.62 + r * 0.75;
    const priceUsd = Math.round(args.pricePaidUsd * factor * 100) / 100;
    const departHour = 6 + Math.floor(seeded(seed, i + 100) * 14);
    const durationHours = 2 + Math.floor(seeded(seed, i + 200) * 6);
    const stops = seeded(seed, i + 300) > 0.65 ? 1 : 0;
    const carrier = CARRIERS[Math.floor(seeded(seed, i + 400) * CARRIERS.length)];
    const departureAt = addHours(day, departHour);
    const arrivalAt = addHours(departureAt, durationHours);
    return {
      id: `fixture_flight_${seed}_${i}`,
      priceUsd,
      currency: "USD",
      carrier,
      stops,
      departureAt,
      arrivalAt,
      durationIso: `PT${durationHours}H`,
      seatsRemaining: 1 + Math.floor(seeded(seed, i + 500) * 8),
      cabin: "ECONOMY",
      segments: [
        {
          from: args.origin,
          to: args.destination,
          departureAt,
          arrivalAt,
          carrier,
          number: String(100 + Math.floor(seeded(seed, i + 600) * 899)),
        },
      ],
    };
  });
}

const HOTEL_NAMES = [
  "Harbour View Inn",
  "The Old Print Works",
  "Cedar & Vine Hotel",
  "Riverside Lodge",
  "The Quiet Quarter",
  "Northgate Residence",
];

export function fixtureHotels(args: {
  cityCode: string;
  checkIn: string;
  checkOut: string;
  pricePaidUsd: number;
  adults: number;
}): HotelCandidate[] {
  const seed = seedOf(args);
  return Array.from({ length: 5 }, (_, i) => {
    const r = seeded(seed, i);
    const factor = 0.58 + r * 0.8;
    return {
      id: `fixture_hotel_${seed}_${i}`,
      hotelName: HOTEL_NAMES[Math.floor(seeded(seed, i + 50) * HOTEL_NAMES.length)],
      hotelId: `FX${args.cityCode}${i}`,
      priceUsd: Math.round(args.pricePaidUsd * factor * 100) / 100,
      currency: "USD",
      roomDescription: seeded(seed, i + 60) > 0.5 ? "King room, city view" : "Double room, courtyard",
      boardType: seeded(seed, i + 70) > 0.6 ? "BREAKFAST" : "ROOM_ONLY",
      refundable: seeded(seed, i + 80) > 0.35,
      checkIn: args.checkIn,
      checkOut: args.checkOut,
    };
  });
}

const CAMP_NAMES = [
  "Pine Hollow Campground",
  "Granite Flat",
  "Blackwater Creek",
  "Two Rivers Camp",
  "Lost Meadow",
  "Sawtooth Basin",
];

export function fixtureCampsites(args: {
  stateCode?: string;
  query?: string;
  pricePaidUsd: number;
}): CampsiteCandidate[] {
  const seed = seedOf(args);
  return Array.from({ length: 5 }, (_, i) => {
    const r = seeded(seed, i);
    const state = (args.stateCode ?? "CA").toUpperCase();
    return {
      id: `fixture_camp_${seed}_${i}`,
      facilityId: `FX${seed.slice(0, 6)}${i}`,
      name: CAMP_NAMES[Math.floor(seeded(seed, i + 40) * CAMP_NAMES.length)],
      priceUsd: Math.round(args.pricePaidUsd * (0.55 + r * 0.8) * 100) / 100,
      feeDescription: "Fixture fee — set RIDB_API_KEY for live facility fee data.",
      reservable: seeded(seed, i + 90) > 0.25,
      state,
      city: null,
      latitude: null,
      longitude: null,
      activities: ["CAMPING", seeded(seed, i + 110) > 0.5 ? "HIKING" : "FISHING"],
      phone: null,
      bookingUrl: "https://www.recreation.gov/",
    };
  });
}
