// The scan: take a booking you already hold, look at what the same trip costs
// right now, and return an actionable improvement report — candidates, the
// savings net of your cancellation fee, and the concrete steps to rebook.
//
// The report is honest by construction. It ranks every candidate, including the
// ones that are worse than what you hold, and the verdict is "hold" whenever
// the net gain fails to clear your threshold. A scan that always says "rebook"
// would be a sales pitch, not a tool.

import { randomBytes } from "node:crypto";
import {
  amadeusConfigured,
  searchFlights,
  searchHotels,
  type FlightCandidate,
  type HotelCandidate,
} from "./amadeus.js";
import { ridbConfigured, searchCampsites, type CampsiteCandidate } from "./ridb.js";
import { fixtureCampsites, fixtureFlights, fixtureHotels } from "./fixtures.js";
import { sign, type SignedArtifact } from "./sign.js";

export type Domain = "flight" | "hotel" | "campsite";
export type Source = "amadeus" | "ridb" | "fixture";

export interface ScanRequest {
  domain: Domain;
  current: Record<string, unknown>;
  /** What it costs you to walk away from the booking you hold. Default 0. */
  cancellationFeeUsd?: number;
  /** Don't recommend a rebook that nets less than this. Default $1. */
  minSavingsUsd?: number;
  /** Cap on how many ranked candidates come back. Default 5, max 20. */
  maxCandidates?: number;
}

export interface Candidate {
  id: string;
  label: string;
  priceUsd: number | null;
  /** Gross difference vs what you paid. Positive = cheaper. Null when unpriced. */
  savingsUsd: number | null;
  /** Savings after the cancellation fee. Null when unpriced. */
  netSavingsUsd: number | null;
  /** Non-price reasons this beats what you hold. */
  improvements: string[];
  /** Reasons it does not. Present so the report can be trusted. */
  tradeoffs: string[];
  details: Record<string, unknown>;
}

export interface RebookStep {
  step: number;
  action: string;
  detail: string;
}

export interface ScanReport {
  reportId: string;
  domain: Domain;
  source: Source;
  live: boolean;
  current: Record<string, unknown>;
  pricePaidUsd: number;
  cancellationFeeUsd: number;
  minSavingsUsd: number;
  scanned: number;
  candidates: Candidate[];
  best: Candidate | null;
  savings: {
    grossUsd: number | null;
    cancellationFeeUsd: number;
    netUsd: number | null;
    pct: number | null;
  };
  rebookSteps: RebookStep[];
  verdict: "rebook" | "hold";
  reason: string;
  notes: string[];
  scannedAt: string;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const DOMAINS: Domain[] = ["flight", "hotel", "campsite"];

const REQUIRED: Record<Domain, string[]> = {
  flight: ["origin", "destination", "departureDate", "pricePaidUsd"],
  hotel: ["cityCode", "checkIn", "checkOut", "pricePaidUsd"],
  campsite: ["pricePaidUsd"],
};

export function validateScanRequest(body: unknown): { error?: string; request?: ScanRequest } {
  const req = body as ScanRequest;
  if (!req || typeof req !== "object") return { error: "body must be a JSON object" };
  if (!DOMAINS.includes(req.domain)) {
    return { error: `domain must be one of ${DOMAINS.join(", ")}` };
  }
  if (!req.current || typeof req.current !== "object") {
    return { error: "current (your existing booking) is required" };
  }
  for (const field of REQUIRED[req.domain]) {
    if (req.current[field] === undefined || req.current[field] === null || req.current[field] === "") {
      return { error: `current.${field} is required for domain "${req.domain}"` };
    }
  }
  const paid = Number(req.current.pricePaidUsd);
  if (!Number.isFinite(paid) || paid <= 0) {
    return { error: "current.pricePaidUsd must be a positive number" };
  }
  if (req.domain === "campsite" && !req.current.stateCode && !req.current.query) {
    return { error: 'campsite scans need current.stateCode (e.g. "CA") or current.query (e.g. "Yosemite")' };
  }
  return { request: req };
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

const round2 = (n: number) => Math.round(n * 100) / 100;

function rank(candidates: Candidate[]): Candidate[] {
  return [...candidates].sort((a, b) => {
    // Priced candidates first, best net saving on top; unpriced ranked by how
    // many improvements they offer.
    if (a.netSavingsUsd !== null && b.netSavingsUsd !== null) return b.netSavingsUsd - a.netSavingsUsd;
    if (a.netSavingsUsd !== null) return -1;
    if (b.netSavingsUsd !== null) return 1;
    return b.improvements.length - a.improvements.length;
  });
}

function priceCandidate(
  base: Omit<Candidate, "savingsUsd" | "netSavingsUsd">,
  pricePaidUsd: number,
  cancellationFeeUsd: number,
): Candidate {
  if (base.priceUsd === null) {
    return { ...base, savingsUsd: null, netSavingsUsd: null };
  }
  const savingsUsd = round2(pricePaidUsd - base.priceUsd);
  return { ...base, savingsUsd, netSavingsUsd: round2(savingsUsd - cancellationFeeUsd) };
}

function flightCandidates(
  offers: FlightCandidate[],
  current: Record<string, unknown>,
  pricePaidUsd: number,
  cancellationFeeUsd: number,
): Candidate[] {
  const currentStops = Number(current.stops ?? 1);
  return offers.map((o) => {
    const improvements: string[] = [];
    const tradeoffs: string[] = [];
    if (o.priceUsd < pricePaidUsd) improvements.push(`$${round2(pricePaidUsd - o.priceUsd)} cheaper than what you paid`);
    else tradeoffs.push(`$${round2(o.priceUsd - pricePaidUsd)} more expensive`);
    if (Number.isFinite(currentStops)) {
      if (o.stops < currentStops) improvements.push(`${currentStops - o.stops} fewer stop(s)`);
      if (o.stops > currentStops) tradeoffs.push(`${o.stops - currentStops} more stop(s)`);
    }
    if (current.carrier && o.carrier !== current.carrier) {
      tradeoffs.push(`different carrier (${o.carrier} vs ${String(current.carrier)}) — loyalty status may not carry`);
    }
    if (o.seatsRemaining !== null && o.seatsRemaining <= 2) {
      tradeoffs.push(`only ${o.seatsRemaining} seat(s) left at this fare`);
    }
    return priceCandidate(
      {
        id: o.id,
        label: `${o.carrier} ${o.segments[0]?.number ?? ""} · ${o.stops === 0 ? "nonstop" : `${o.stops} stop`} · departs ${o.departureAt}`,
        priceUsd: o.priceUsd,
        improvements,
        tradeoffs,
        details: {
          carrier: o.carrier,
          stops: o.stops,
          departureAt: o.departureAt,
          arrivalAt: o.arrivalAt,
          duration: o.durationIso,
          cabin: o.cabin,
          seatsRemaining: o.seatsRemaining,
          segments: o.segments,
        },
      },
      pricePaidUsd,
      cancellationFeeUsd,
    );
  });
}

function hotelCandidates(
  offers: HotelCandidate[],
  current: Record<string, unknown>,
  pricePaidUsd: number,
  cancellationFeeUsd: number,
): Candidate[] {
  return offers.map((o) => {
    const improvements: string[] = [];
    const tradeoffs: string[] = [];
    if (o.priceUsd < pricePaidUsd) improvements.push(`$${round2(pricePaidUsd - o.priceUsd)} cheaper than what you paid`);
    else tradeoffs.push(`$${round2(o.priceUsd - pricePaidUsd)} more expensive`);
    if (o.refundable === true) improvements.push("free cancellation");
    if (o.refundable === false) tradeoffs.push("non-refundable rate");
    if (o.boardType === "BREAKFAST") improvements.push("breakfast included");
    if (current.hotelName && o.hotelName !== current.hotelName) {
      tradeoffs.push(`different property (${o.hotelName}) — check the location before switching`);
    }
    return priceCandidate(
      {
        id: o.id,
        label: `${o.hotelName} · ${o.roomDescription ?? "room"}`,
        priceUsd: o.priceUsd,
        improvements,
        tradeoffs,
        details: {
          hotelId: o.hotelId,
          hotelName: o.hotelName,
          room: o.roomDescription,
          boardType: o.boardType,
          refundable: o.refundable,
          checkIn: o.checkIn,
          checkOut: o.checkOut,
        },
      },
      pricePaidUsd,
      cancellationFeeUsd,
    );
  });
}

function campsiteCandidates(
  facilities: CampsiteCandidate[],
  current: Record<string, unknown>,
  pricePaidUsd: number,
  cancellationFeeUsd: number,
): Candidate[] {
  return facilities.map((f) => {
    const improvements: string[] = [];
    const tradeoffs: string[] = [];
    if (f.priceUsd !== null && f.priceUsd < pricePaidUsd) {
      improvements.push(`$${round2(pricePaidUsd - f.priceUsd)}/night cheaper than what you paid`);
    } else if (f.priceUsd !== null) {
      tradeoffs.push(`$${round2(f.priceUsd - pricePaidUsd)}/night more expensive`);
    } else {
      tradeoffs.push("no published fee — price it on recreation.gov before switching");
    }
    if (f.reservable) improvements.push("reservable online");
    else tradeoffs.push("first-come, first-served — no reservation to hold");
    if (f.activities.length > 1) improvements.push(`activities: ${f.activities.slice(0, 4).join(", ")}`);
    if (current.campgroundName && f.name !== current.campgroundName) {
      tradeoffs.push(`different campground (${f.name})`);
    }
    return priceCandidate(
      {
        id: f.id,
        label: `${f.name}${f.state ? ` (${f.state})` : ""}`,
        priceUsd: f.priceUsd,
        improvements,
        tradeoffs,
        details: {
          facilityId: f.facilityId,
          name: f.name,
          state: f.state,
          city: f.city,
          latitude: f.latitude,
          longitude: f.longitude,
          reservable: f.reservable,
          feeDescription: f.feeDescription,
          activities: f.activities,
          phone: f.phone,
          bookingUrl: f.bookingUrl,
        },
      },
      pricePaidUsd,
      cancellationFeeUsd,
    );
  });
}

function rebookSteps(domain: Domain, best: Candidate | null, current: Record<string, unknown>, verdict: string): RebookStep[] {
  if (verdict === "hold" || !best) {
    return [
      { step: 1, action: "hold", detail: "Keep the booking you have — nothing on the market clears your threshold right now." },
      { step: 2, action: "rescan", detail: "Scan again closer to the date; inventory and fares move. This service is priced per scan for exactly that reason." },
    ];
  }
  const ref = current.bookingRef ? String(current.bookingRef) : "your existing booking";
  const holdFirst: RebookStep = {
    step: 1,
    action: "book the replacement first",
    detail: `Secure ${best.label} at $${best.priceUsd} BEFORE cancelling. Inventory this good does not wait, and an unbooked cancellation is the one irreversible mistake here.`,
  };
  const verify: RebookStep = {
    step: 2,
    action: "verify the fine print",
    detail:
      domain === "flight"
        ? "Confirm baggage allowance, seat selection cost, and change policy on the new fare — a cheaper base fare with paid bags is not cheaper."
        : domain === "hotel"
          ? "Confirm the cancellation policy, taxes and resort fees on the new rate; the displayed total should already include them."
          : "Confirm the site type, vehicle limits, and whether the fee shown covers your party size and nights.",
  };
  const cancel: RebookStep = {
    step: 3,
    action: "cancel the old booking",
    detail: `Cancel ${ref}. You have already priced the $${best.netSavingsUsd !== null ? round2((best.savingsUsd ?? 0) - (best.netSavingsUsd ?? 0)) : 0} cancellation fee into the net saving below.`,
  };
  const record: RebookStep = {
    step: 4,
    action: "keep the report",
    detail: "This report is signed (HMAC-SHA256). Store it as your record of what the market looked like at the moment you decided — POST /verify re-checks it later for free.",
  };
  return [holdFirst, verify, cancel, record];
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function scan(request: ScanRequest): Promise<SignedArtifact<ScanReport>> {
  const current = request.current;
  const pricePaidUsd = Number(current.pricePaidUsd);
  const cancellationFeeUsd = Math.max(0, Number(request.cancellationFeeUsd ?? 0) || 0);
  const minSavingsUsd = Math.max(0, Number(request.minSavingsUsd ?? 1) || 0);
  const maxCandidates = Math.min(Math.max(Number(request.maxCandidates ?? 5) || 5, 1), 20);
  const notes: string[] = [];

  let candidates: Candidate[] = [];
  let source: Source = "fixture";
  let live = false;

  try {
    if (request.domain === "flight") {
      if (amadeusConfigured()) {
        const offers = await searchFlights({
          origin: String(current.origin).toUpperCase(),
          destination: String(current.destination).toUpperCase(),
          departureDate: String(current.departureDate),
          returnDate: current.returnDate ? String(current.returnDate) : undefined,
          adults: Number(current.adults ?? 1) || 1,
          cabin: current.cabin ? String(current.cabin) : undefined,
          max: maxCandidates * 3,
        });
        candidates = flightCandidates(offers, current, pricePaidUsd, cancellationFeeUsd);
        source = "amadeus";
        live = true;
      } else {
        notes.push("AMADEUS_CLIENT_ID/AMADEUS_CLIENT_SECRET unset — candidates are deterministic fixtures.");
        candidates = flightCandidates(
          fixtureFlights({
            origin: String(current.origin).toUpperCase(),
            destination: String(current.destination).toUpperCase(),
            departureDate: String(current.departureDate),
            pricePaidUsd,
            adults: Number(current.adults ?? 1) || 1,
          }),
          current,
          pricePaidUsd,
          cancellationFeeUsd,
        );
      }
    } else if (request.domain === "hotel") {
      if (amadeusConfigured()) {
        const offers = await searchHotels({
          cityCode: String(current.cityCode).toUpperCase(),
          checkIn: String(current.checkIn),
          checkOut: String(current.checkOut),
          adults: Number(current.adults ?? 1) || 1,
          max: maxCandidates * 3,
        });
        candidates = hotelCandidates(offers, current, pricePaidUsd, cancellationFeeUsd);
        source = "amadeus";
        live = true;
      } else {
        notes.push("AMADEUS_CLIENT_ID/AMADEUS_CLIENT_SECRET unset — candidates are deterministic fixtures.");
        candidates = hotelCandidates(
          fixtureHotels({
            cityCode: String(current.cityCode).toUpperCase(),
            checkIn: String(current.checkIn),
            checkOut: String(current.checkOut),
            pricePaidUsd,
            adults: Number(current.adults ?? 1) || 1,
          }),
          current,
          pricePaidUsd,
          cancellationFeeUsd,
        );
      }
    } else {
      if (ridbConfigured()) {
        const facilities = await searchCampsites({
          stateCode: current.stateCode ? String(current.stateCode) : undefined,
          query: current.query ? String(current.query) : undefined,
          latitude: current.latitude !== undefined ? Number(current.latitude) : undefined,
          longitude: current.longitude !== undefined ? Number(current.longitude) : undefined,
          radiusMiles: current.radiusMiles !== undefined ? Number(current.radiusMiles) : undefined,
          max: maxCandidates * 3,
        });
        candidates = campsiteCandidates(facilities, current, pricePaidUsd, cancellationFeeUsd);
        source = "ridb";
        live = true;
        notes.push(
          "RIDB publishes facility inventory and fees, not live nightly availability — confirm dates on recreation.gov before cancelling.",
        );
      } else {
        notes.push("RIDB_API_KEY unset — candidates are deterministic fixtures.");
        candidates = campsiteCandidates(
          fixtureCampsites({
            stateCode: current.stateCode ? String(current.stateCode) : undefined,
            query: current.query ? String(current.query) : undefined,
            pricePaidUsd,
          }),
          current,
          pricePaidUsd,
          cancellationFeeUsd,
        );
      }
    }
  } catch (err) {
    // A live-API failure degrades to fixtures rather than failing a paid call —
    // you always get a report for your money.
    notes.push(
      `Live inventory lookup failed (${err instanceof Error ? err.message : String(err)}) — fell back to deterministic fixtures.`,
    );
    source = "fixture";
    live = false;
    candidates =
      request.domain === "flight"
        ? flightCandidates(
            fixtureFlights({
              origin: String(current.origin ?? "???").toUpperCase(),
              destination: String(current.destination ?? "???").toUpperCase(),
              departureDate: String(current.departureDate ?? "2026-01-01"),
              pricePaidUsd,
              adults: Number(current.adults ?? 1) || 1,
            }),
            current,
            pricePaidUsd,
            cancellationFeeUsd,
          )
        : request.domain === "hotel"
          ? hotelCandidates(
              fixtureHotels({
                cityCode: String(current.cityCode ?? "XXX").toUpperCase(),
                checkIn: String(current.checkIn ?? "2026-01-01"),
                checkOut: String(current.checkOut ?? "2026-01-02"),
                pricePaidUsd,
                adults: Number(current.adults ?? 1) || 1,
              }),
              current,
              pricePaidUsd,
              cancellationFeeUsd,
            )
          : campsiteCandidates(
              fixtureCampsites({
                stateCode: current.stateCode ? String(current.stateCode) : undefined,
                query: current.query ? String(current.query) : undefined,
                pricePaidUsd,
              }),
              current,
              pricePaidUsd,
              cancellationFeeUsd,
            );
  }

  const scanned = candidates.length;
  const ranked = rank(candidates).slice(0, maxCandidates);
  const best = ranked.find((c) => c.netSavingsUsd !== null && c.netSavingsUsd > 0) ?? ranked[0] ?? null;
  const bestNet = best?.netSavingsUsd ?? null;
  const verdict: "rebook" | "hold" = bestNet !== null && bestNet >= minSavingsUsd ? "rebook" : "hold";

  const reason =
    scanned === 0
      ? "No comparable inventory came back for those parameters — widen the dates or check the location codes."
      : verdict === "rebook"
        ? `Best option nets $${bestNet} after a $${cancellationFeeUsd} cancellation fee, clearing your $${minSavingsUsd} threshold.`
        : bestNet === null
          ? "Nothing in the results carries a comparable published price, so no saving can be proven. Holding is the safe call."
          : `Best option nets only $${bestNet} after fees, under your $${minSavingsUsd} threshold. Not worth the churn.`;

  const report: ScanReport = {
    reportId: `scan_${randomBytes(8).toString("hex")}`,
    domain: request.domain,
    source,
    live,
    current,
    pricePaidUsd,
    cancellationFeeUsd,
    minSavingsUsd,
    scanned,
    candidates: ranked,
    best,
    savings: {
      grossUsd: best?.savingsUsd ?? null,
      cancellationFeeUsd,
      netUsd: bestNet,
      pct: bestNet !== null && pricePaidUsd > 0 ? Math.round((bestNet / pricePaidUsd) * 1000) / 10 : null,
    },
    rebookSteps: rebookSteps(request.domain, verdict === "rebook" ? best : null, current, verdict),
    verdict,
    reason,
    notes,
    scannedAt: new Date().toISOString(),
  };

  return sign(report);
}
