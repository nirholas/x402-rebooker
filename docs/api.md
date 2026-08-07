# API reference

Base URL: your deployment (default `http://localhost:4043`). Machine-readable: [`openapi.json`](https://github.com/nirholas/x402-rebooker/blob/main/openapi.json) · [`/.well-known/x402`](https://github.com/nirholas/x402-rebooker/blob/main/public/.well-known/x402).

All paid routes follow x402: unpaid request → `402` + `PaymentRequirements`; request with a valid `X-PAYMENT` header → `200` + artifact + `X-PAYMENT-RESPONSE`.

## Payment rails

Every paid route is **dual rail** — the 402 body's `accepts[]` holds one entry per rail at the same price, and the server settles whichever one your `X-PAYMENT` payload names in its `network` field.

| Rail | `network` | Asset | payTo | Facilitator |
|---|---|---|---|---|
| EVM | `base-sepolia` (default), `base` | USDC `0x036CbD53842c5426634e7929541eC2318f3dCF7e` | `0x40252CFDF8B20Ed757D61ff157719F33Ec332402` | `https://x402.org/facilitator` |
| Solana | `solana` (default), `solana-devnet` | USDC `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | `WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW` | `https://facilitator.payai.network` |

The Solana entry carries `extra.feePayer` — the facilitator account that sponsors the SOL network fee, so payers need only USDC.

**402 body**

```json
{
  "x402Version": 1,
  "error": "X-PAYMENT header is required",
  "accepts": [
    { "scheme": "exact", "network": "base-sepolia", "maxAmountRequired": "10000",
      "resource": "https://host/scan", "description": "…", "mimeType": "application/json",
      "payTo": "0x40252CFDF8B20Ed757D61ff157719F33Ec332402", "maxTimeoutSeconds": 60,
      "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      "extra": { "name": "USDC", "version": "2" } },
    { "scheme": "exact", "network": "solana", "maxAmountRequired": "10000",
      "resource": "https://host/scan", "description": "…", "mimeType": "application/json",
      "payTo": "WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW", "maxTimeoutSeconds": 60,
      "asset": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      "extra": { "name": "USD Coin", "decimals": 6, "feePayer": "2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4" } }
  ]
}
```

**`X-PAYMENT-RESPONSE`** (on every paid `200`) is base64 JSON, also echoed in the body as `payment`:

```json
{ "success": true, "rail": "solana", "network": "solana",
  "facilitator": "https://facilitator.payai.network",
  "transaction": "5xY…", "payer": "7hF…", "amount": "10000", "asset": "USDC" }
```

---

## POST /scan — $0.01

Scan current inventory against a booking you already hold.

**Body**

| Field | Type | Required | Notes |
|---|---|---|---|
| `domain` | string | yes | `flight` \| `hotel` \| `campsite` |
| `current` | object | yes | The booking you hold — see per-domain fields below |
| `cancellationFeeUsd` | number | no | What it costs to walk away. Default `0` |
| `minSavingsUsd` | number | no | Don't recommend a switch below this net gain. Default `1` |
| `maxCandidates` | number | no | 1–20, default `5` |

**`current` per domain**

| Domain | Required | Useful extras | Extras are used for |
|---|---|---|---|
| `flight` | `origin`, `destination`, `departureDate`, `pricePaidUsd` | `returnDate`, `adults`, `cabin`, `stops`, `carrier`, `bookingRef` | `stops` and `carrier` let the report compute stop-count improvements and flag loyalty-programme tradeoffs |
| `hotel` | `cityCode`, `checkIn`, `checkOut`, `pricePaidUsd` | `adults`, `hotelName`, `bookingRef` | `hotelName` flags "different property" tradeoffs |
| `campsite` | `pricePaidUsd` **and** one of `stateCode` / `query` | `latitude`, `longitude`, `radiusMiles`, `campgroundName`, `bookingRef` | coordinates narrow the RIDB search radius |

`origin`/`destination` are IATA airport codes; `cityCode` is an IATA city code (`PAR`, `NYC`, `LON`). `bookingRef` is echoed into the rebook steps so the instructions name your actual reservation.

**200**

```json
{
  "report": {
    "payload": {
      "reportId": "scan_1a2b3c4d5e6f7a8b",
      "domain": "flight",
      "source": "amadeus",
      "live": true,
      "current": { "origin": "JFK", "destination": "LAX", "pricePaidUsd": 412 },
      "pricePaidUsd": 412,
      "cancellationFeeUsd": 75,
      "minSavingsUsd": 25,
      "scanned": 12,
      "candidates": [
        {
          "id": "amadeus_flight_3",
          "label": "B6 621 · nonstop · departs 2026-09-14T15:00:00",
          "priceUsd": 266.69,
          "savingsUsd": 145.31,
          "netSavingsUsd": 70.31,
          "improvements": ["$145.31 cheaper than what you paid", "1 fewer stop(s)"],
          "tradeoffs": ["different carrier (B6 vs AA) — loyalty status may not carry"],
          "details": {
            "carrier": "B6", "stops": 0, "departureAt": "…", "arrivalAt": "…",
            "duration": "PT6H15M", "cabin": "ECONOMY", "seatsRemaining": 4, "segments": []
          }
        }
      ],
      "best": { "id": "amadeus_flight_3", "netSavingsUsd": 70.31 },
      "savings": { "grossUsd": 145.31, "cancellationFeeUsd": 75, "netUsd": 70.31, "pct": 17.1 },
      "rebookSteps": [
        { "step": 1, "action": "book the replacement first", "detail": "Secure … BEFORE cancelling." },
        { "step": 2, "action": "verify the fine print", "detail": "Confirm baggage allowance…" },
        { "step": 3, "action": "cancel the old booking", "detail": "Cancel ABC123…" },
        { "step": 4, "action": "keep the report", "detail": "This report is signed…" }
      ],
      "verdict": "rebook",
      "reason": "Best option nets $70.31 after a $75 cancellation fee, clearing your $25 threshold.",
      "notes": [],
      "scannedAt": "2026-08-07T12:00:00.000Z"
    },
    "signature": "hex", "algorithm": "HMAC-SHA256", "canonicalization": "sorted-json"
  },
  "payment": { "success": true, "rail": "solana", "network": "solana",
               "facilitator": "https://facilitator.payai.network",
               "transaction": "5xY…", "amount": "10000", "asset": "USDC" }
}
```

### Field semantics

| Field | Meaning |
|---|---|
| `source` | `amadeus` / `ridb` when the live API answered, `fixture` otherwise |
| `live` | `true` only when the candidates came from a real inventory call |
| `scanned` | How many offers were examined before ranking (may exceed `candidates.length`) |
| `candidates[].priceUsd` | `null` when the provider publishes no comparable price — savings are then `null` too |
| `candidates[].savingsUsd` | Gross difference vs `pricePaidUsd`. Positive means cheaper |
| `candidates[].netSavingsUsd` | `savingsUsd` minus `cancellationFeeUsd`. **This is the number to act on** |
| `candidates[].tradeoffs` | Why this option might be worse. Always populated when there is a reason |
| `best` | Highest net saving, or the top-ranked candidate when nothing saves money |
| `verdict` | `rebook` when `savings.netUsd >= minSavingsUsd`, else `hold` |
| `reason` | One sentence explaining the verdict, with the arithmetic in it |
| `notes` | Why a fallback happened, and provider caveats |

### Ranking

Priced candidates sort by `netSavingsUsd` descending. Unpriced candidates sort after them by number of `improvements`. `maxCandidates` trims the list after ranking, so you always see the best options rather than the first ones the provider returned.

### Why `hold` is a real answer

The service charges per scan, not per recommendation, so it has no incentive to manufacture a switch. It returns `hold` when the best net saving is under your threshold, when nothing carries a comparable price, and when the provider returned no inventory — with `rebookSteps` telling you to keep what you have and rescan later.

**Errors**: `400` invalid body (names the missing field and includes a worked example), `402` unpaid, `500` `scan_failed`.

---

## GET /sources — free

```json
{
  "flight": {
    "provider": "Amadeus Self-Service — /v2/shopping/flight-offers",
    "live": false,
    "unlock": "AMADEUS_CLIENT_ID + AMADEUS_CLIENT_SECRET (free at developers.amadeus.com)",
    "fallback": "deterministic fixtures, labeled source: \"fixture\""
  },
  "hotel": { "provider": "Amadeus Self-Service — /v3/shopping/hotel-offers", "live": false, "…": "…" },
  "campsite": {
    "provider": "RIDB (Recreation Information Database) — /facilities",
    "live": false,
    "unlock": "RIDB_API_KEY (free at ridb.recreation.gov/profile)",
    "note": "RIDB publishes facility inventory and fees, not live nightly availability."
  }
}
```

Call this before paying if it matters to you whether the scan will be live.

---

## POST /verify — free

Body: `{"payload": …, "signature": "hex"}` → `{"valid": true|false}`. Works on any report this server signed.

## GET /healthz — free

```json
{ "ok": true, "service": "x402-rebooker",
  "rails": [{ "rail": "evm", "network": "base-sepolia" }, { "rail": "solana", "network": "solana" }],
  "live": { "amadeus": false, "ridb": false } }
```

## Signature scheme

`signature = HMAC-SHA256(SIGNING_SECRET, canonicalJson(payload))` where `canonicalJson` recursively sorts object keys and strips `undefined`. See `src/sign.ts` (`sign`, `verify`, `canonicalize`).

## Error codes

| Status | Meaning |
|---|---|
| 400 | Invalid body — names the missing field and includes a worked example |
| 402 | Payment required, or the payment failed verification/settlement. Body carries the dual-rail `accepts[]` and an `error` reason |
| 500 | `scan_failed`, or `no_payment_rail` when neither rail is configured |
| 502 | `facilitator_unreachable` / `settlement_error` — the rail's facilitator failed; nothing was charged |
