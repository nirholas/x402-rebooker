// RIDB (Recreation Information Database) adapter — live campground inventory
// for US federal recreation areas. https://ridb.recreation.gov/docs
//
// Env-gated: set RIDB_API_KEY and campsite scans hit the real API. Without it
// the service falls back to deterministic fixtures, so the demo never requires
// a key. A key is free — register at https://ridb.recreation.gov/profile.
//
// Honest scope note: RIDB publishes facility *inventory* and attributes, not
// live nightly availability. Where a facility publishes a use fee we surface it
// as `priceUsd` and compute real savings; where it does not, `priceUsd` is null
// and the candidate is ranked on non-price improvements (reservable, closer to
// your dates' area, richer amenities). The report never invents a price.

const BASE_URL = (process.env.RIDB_BASE_URL ?? "https://ridb.recreation.gov/api/v1").replace(/\/$/, "");
const TIMEOUT_MS = 12_000;

export function ridbConfigured(): boolean {
  return Boolean(process.env.RIDB_API_KEY);
}

interface RidbFacility {
  FacilityID: string;
  FacilityName: string;
  FacilityTypeDescription?: string;
  FacilityUseFeeDescription?: string;
  FacilityDescription?: string;
  FacilityDirections?: string;
  FacilityPhone?: string;
  FacilityLatitude?: number;
  FacilityLongitude?: number;
  Reservable?: boolean;
  Enabled?: boolean;
  FACILITYADDRESS?: { AddressStateCode?: string; City?: string }[];
  ACTIVITY?: { ActivityName?: string }[];
}

export interface CampsiteCandidate {
  id: string;
  facilityId: string;
  name: string;
  /** Nightly fee in USD when the facility publishes one, else null. */
  priceUsd: number | null;
  feeDescription: string | null;
  reservable: boolean;
  state: string | null;
  city: string | null;
  latitude: number | null;
  longitude: number | null;
  activities: string[];
  phone: string | null;
  bookingUrl: string;
}

export interface CampsiteQuery {
  /** Two-letter state code, e.g. "CA". */
  stateCode?: string;
  /** Free-text search, e.g. "Yosemite". */
  query?: string;
  latitude?: number;
  longitude?: number;
  radiusMiles?: number;
  max?: number;
}

/**
 * Pull a nightly dollar amount out of RIDB's free-text fee description.
 * Returns null rather than guessing when no unambiguous figure is present.
 */
export function parseNightlyFee(description: string | undefined): number | null {
  if (!description) return null;
  const match = description.match(/\$\s?(\d+(?:\.\d{1,2})?)/);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 && value < 2000 ? value : null;
}

export async function searchCampsites(q: CampsiteQuery): Promise<CampsiteCandidate[]> {
  const params: Record<string, string> = {
    activity: "CAMPING",
    limit: String(Math.min(q.max ?? 20, 50)),
    offset: "0",
    full: "true",
  };
  if (q.query) params.query = q.query;
  if (q.stateCode) params.state = q.stateCode.toUpperCase();
  if (q.latitude !== undefined && q.longitude !== undefined) {
    params.latitude = String(q.latitude);
    params.longitude = String(q.longitude);
    params.radius = String(q.radiusMiles ?? 50);
  }

  const res = await fetch(`${BASE_URL}/facilities?${new URLSearchParams(params)}`, {
    headers: { apikey: process.env.RIDB_API_KEY ?? "", accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`RIDB /facilities returned ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
  }
  const body = (await res.json()) as { RECDATA?: RidbFacility[] };

  return (body.RECDATA ?? [])
    .filter((f) => f.Enabled !== false)
    .map((f) => ({
      id: `ridb_${f.FacilityID}`,
      facilityId: f.FacilityID,
      name: f.FacilityName,
      priceUsd: parseNightlyFee(f.FacilityUseFeeDescription),
      feeDescription: f.FacilityUseFeeDescription?.slice(0, 400) ?? null,
      reservable: Boolean(f.Reservable),
      state: f.FACILITYADDRESS?.[0]?.AddressStateCode ?? null,
      city: f.FACILITYADDRESS?.[0]?.City ?? null,
      latitude: f.FacilityLatitude ?? null,
      longitude: f.FacilityLongitude ?? null,
      activities: (f.ACTIVITY ?? []).map((a) => a.ActivityName ?? "").filter(Boolean).slice(0, 8),
      phone: f.FacilityPhone ?? null,
      bookingUrl: `https://www.recreation.gov/camping/campgrounds/${f.FacilityID}`,
    }));
}
