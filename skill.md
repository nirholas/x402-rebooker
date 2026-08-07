# x402-rebooker — agent skill

The cancel-worse-book-better move, automated. Post a booking you already hold — a flight, a hotel stay, a campsite — and one paid call scans live inventory for the same trip and returns a **signed improvement report**: ranked candidates, the saving net of your cancellation fee, and the exact steps to switch. The report is honest by construction: it ranks worse options too, and its verdict is `hold` whenever the net gain fails to clear your threshold.

**Pay in USDC on Base or Solana — your client picks the rail.** Every 402 challenge lists both.

**Base URL**: `{BASE_URL}` (self-hosted; default `http://localhost:4043`)

## Endpoints

### POST /scan — $0.01

Scan current inventory against a booking you hold.

Request body:

```json
{
  "domain": "flight",
  "current": {
    "origin": "JFK",
    "destination": "LAX",
    "departureDate": "2026-09-14",
    "adults": 1,
    "pricePaidUsd": 412,
    "stops": 1,
    "carrier": "AA",
    "bookingRef": "ABC123"
  },
  "cancellationFeeUsd": 75,
  "minSavingsUsd": 25,
  "maxCandidates": 5
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `domain` | string | yes | `flight` \| `hotel` \| `campsite` |
| `current` | object | yes | The booking you hold. Required keys per domain below |
| `cancellationFeeUsd` | number | no | What it costs to walk away. Default `0` |
| `minSavingsUsd` | number | no | Don't recommend a switch below this net gain. Default `1` |
| `maxCandidates` | number | no | 1–20, default `5` |

Required `current` keys:

| Domain | Required | Useful extras |
|---|---|---|
| `flight` | `origin`, `destination`, `departureDate`, `pricePaidUsd` | `returnDate`, `adults`, `cabin`, `stops`, `carrier`, `bookingRef` |
| `hotel` | `cityCode`, `checkIn`, `checkOut`, `pricePaidUsd` | `adults`, `hotelName`, `bookingRef` |
| `campsite` | `pricePaidUsd` **and** one of `stateCode` / `query` | `latitude`, `longitude`, `radiusMiles`, `campgroundName`, `bookingRef` |

Response 200:

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
          "details": { "carrier": "B6", "stops": 0, "departureAt": "…", "arrivalAt": "…", "seatsRemaining": 4, "segments": [] }
        }
      ],
      "best": { "id": "amadeus_flight_3", "netSavingsUsd": 70.31 },
      "savings": { "grossUsd": 145.31, "cancellationFeeUsd": 75, "netUsd": 70.31, "pct": 17.1 },
      "rebookSteps": [
        { "step": 1, "action": "book the replacement first", "detail": "Secure … BEFORE cancelling." },
        { "step": 2, "action": "verify the fine print", "detail": "Confirm baggage allowance, seat selection cost…" },
        { "step": 3, "action": "cancel the old booking", "detail": "Cancel ABC123…" },
        { "step": 4, "action": "keep the report", "detail": "This report is signed…" }
      ],
      "verdict": "rebook",
      "reason": "Best option nets $70.31 after a $75 cancellation fee, clearing your $25 threshold.",
      "notes": [],
      "scannedAt": "2026-08-07T12:00:00.000Z"
    },
    "signature": "hex-hmac-sha256",
    "algorithm": "HMAC-SHA256",
    "canonicalization": "sorted-json"
  },
  "payment": { "success": true, "rail": "solana", "network": "solana", "transaction": "5xY…", "amount": "10000", "asset": "USDC" }
}
```

**How to read it**

- `verdict` is `rebook` or `hold`. `hold` is a real, common answer — the service charges per scan, not per recommendation.
- `savings.netUsd` is gross saving minus your `cancellationFeeUsd`. That is the number to act on.
- Every candidate carries `improvements` **and** `tradeoffs`. Read both before switching.
- `source` is `amadeus` / `ridb` (live) or `fixture`. `live: false` means the report is deterministic sample data — useful for wiring up, never for cancelling a real booking.
- `rebookSteps` always puts "book the replacement first" before "cancel the old booking". Cancelling first is the one irreversible mistake here.

### GET /sources — free
Which inventory providers this deployment can reach live, and what unlocks each.

### POST /verify — free
Body `{payload, signature}` → `{valid: true|false}` for any report this server signed.

### GET /healthz — free

## Payment — dual rail

Protocol: **x402** (HTTP 402). Asset: **USDC** on both rails. A 402 response carries an `accepts` array with two entries; send `X-PAYMENT` for whichever you can pay.

| Rail | `network` | Asset address | payTo | Facilitator |
|---|---|---|---|---|
| EVM | `base-sepolia` (`base` via `NETWORK`) | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` | `0x40252CFDF8B20Ed757D61ff157719F33Ec332402` | `https://x402.org/facilitator` |
| Solana | `solana` (`solana-devnet` via `SOLANA_NETWORK`) | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | `WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW` | `https://facilitator.payai.network` |

Flow: request → `402` with `accepts[]` → pick your rail → sign the USDC authorization (EIP-3009 on Base, fee-sponsored SPL `transferChecked` on Solana; `extra.feePayer` sponsors the SOL fee so you need no SOL) → retry with `X-PAYMENT` → `200` with the report in-body plus an `X-PAYMENT-RESPONSE` header, echoed in the body as `payment`.

## Data sources

| Domain | Provider | Live when | Otherwise |
|---|---|---|---|
| flight | Amadeus Self-Service `/v2/shopping/flight-offers` | `AMADEUS_CLIENT_ID` + `AMADEUS_CLIENT_SECRET` | deterministic fixtures, `source: "fixture"` |
| hotel | Amadeus Self-Service `/v3/shopping/hotel-offers` | same | deterministic fixtures |
| campsite | RIDB `/facilities` | `RIDB_API_KEY` | deterministic fixtures |

RIDB publishes facility inventory and published fees, not live nightly availability — campsite candidates without a published fee come back with `priceUsd: null` and are ranked on non-price improvements. The report never invents a price.

A live lookup that fails degrades to fixtures with a `notes` entry rather than failing your paid call.

## Error codes

| Status | Meaning |
|---|---|
| 400 | Invalid body — response names the missing field and includes a worked example |
| 402 | Payment required, or the payment failed verification/settlement. Body carries the dual-rail `accepts[]` |
| 500 | `scan_failed`, or `no_payment_rail` when neither rail is configured |
| 502 | `facilitator_unreachable` / `settlement_error` — the rail's facilitator failed; nothing was charged |

Machine-readable manifest (lists both rails per resource): `{BASE_URL}/.well-known/x402`

Contact: **nichxbt@gmail.com**
