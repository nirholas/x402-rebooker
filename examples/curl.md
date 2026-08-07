# curl walkthrough — raw 402 → pay → 200

Start the server:

```bash
npm run dev        # boots with the suite's default receive addresses
```

Every paid route is **dual rail**: the 402 lists USDC on Base *and* USDC on Solana at the same price, and you pay with whichever wallet you have.

## 0. Will this scan be live? (free)

```bash
curl -s http://localhost:4021/sources | jq
```

```json
{
  "flight":   { "provider": "Amadeus Self-Service — /v2/shopping/flight-offers", "live": false,
                "unlock": "AMADEUS_CLIENT_ID + AMADEUS_CLIENT_SECRET (free at developers.amadeus.com)" },
  "campsite": { "provider": "RIDB — /facilities", "live": false,
                "unlock": "RIDB_API_KEY (free at ridb.recreation.gov/profile)" }
}
```

`live: false` means the scan will return deterministic fixtures. Useful for wiring up a client; never act on one.

## 1. Hit the paid route without payment → 402

```bash
curl -si -X POST http://localhost:4021/scan \
  -H 'content-type: application/json' \
  -d '{
    "domain": "flight",
    "current": { "origin":"JFK","destination":"LAX","departureDate":"2026-09-14","pricePaidUsd":412,"stops":1,"carrier":"AA","bookingRef":"ABC123" },
    "cancellationFeeUsd": 75,
    "minSavingsUsd": 25
  }'
```

Response (trimmed):

```
HTTP/1.1 402 Payment Required
Content-Type: application/json

{
  "x402Version": 1,
  "error": "X-PAYMENT header is required",
  "accepts": [
    {
      "scheme": "exact",
      "network": "base-sepolia",
      "maxAmountRequired": "10000",
      "resource": "http://localhost:4021/scan",
      "payTo": "0x40252CFDF8B20Ed757D61ff157719F33Ec332402",
      "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      "extra": { "name": "USDC", "version": "2" }
    },
    {
      "scheme": "exact",
      "network": "solana",
      "maxAmountRequired": "10000",
      "resource": "http://localhost:4021/scan",
      "payTo": "WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW",
      "asset": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      "extra": { "name": "USD Coin", "decimals": 6, "feePayer": "2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4" }
    }
  ]
}
```

The `accepts` array is the machine-readable price sheet, one entry per rail: `maxAmountRequired` is in USDC base units (6 decimals), `asset` is the USDC contract/mint on the named network. Pick one:

```bash
curl -s -X POST http://localhost:4021/scan -H 'content-type: application/json' \
  -d '{"domain":"flight","current":{"origin":"JFK","destination":"LAX","departureDate":"2026-09-14","pricePaidUsd":412}}' \
  | jq '.accepts[] | {network, payTo, asset, maxAmountRequired}'
```

## 2. Pay — on either rail

The `X-PAYMENT` header is a base64-encoded, wallet-signed authorization matching one of those entries. Hand-rolling it means EIP-712 (Base) or SPL transaction building (Solana) — use a client:

**Base / EVM**

```bash
PRIVATE_KEY=0x... npm run client       # examples/agent-client.ts does the full flow
```

Under the hood: parse the 402 → sign an EIP-3009 `transferWithAuthorization` for the exact amount → retry with `X-PAYMENT: <base64 payload>`.

**Solana**

Use any x402 Solana client, or `@three-ws/x402-payment-modal` in a browser. Under the hood: build a fee-sponsored SPL `transferChecked` for `maxAmountRequired` to the base58 `payTo`, have the wallet sign it, base64-encode the x402 envelope, retry with `X-PAYMENT`. `extra.feePayer` sponsors the SOL network fee, so your wallet needs only USDC.

The server reads `network` off your payload, picks the matching requirement, and settles on that rail.

## 3. Paid retry → 200 with the report in-body

```
HTTP/1.1 200 OK
X-PAYMENT-RESPONSE: <base64 of {"success":true,"rail":"solana","network":"solana","transaction":"5xY…","payer":"7hF…","amount":"10000","asset":"USDC"}>

{
  "report": {
    "payload": {
      "reportId": "scan_…",
      "source": "amadeus", "live": true, "scanned": 12,
      "candidates": [
        { "label": "B6 621 · nonstop · departs 2026-09-14T15:00", "priceUsd": 266.69,
          "savingsUsd": 145.31, "netSavingsUsd": 70.31,
          "improvements": ["$145.31 cheaper than what you paid", "1 fewer stop(s)"],
          "tradeoffs": ["different carrier (B6 vs AA) — loyalty status may not carry"] }
      ],
      "savings": { "grossUsd": 145.31, "cancellationFeeUsd": 75, "netUsd": 70.31, "pct": 17.1 },
      "rebookSteps": [ { "step": 1, "action": "book the replacement first", "detail": "…" } ],
      "verdict": "rebook",
      "reason": "Best option nets $70.31 after a $75 cancellation fee, clearing your $25 threshold."
    },
    "signature": "…"
  },
  "payment": { "success": true, "rail": "solana", "transaction": "5xY…" }
}
```

Decode the header to see which rail settled:

```bash
echo "<header value>" | base64 -d | jq
```

Pull just the decision:

```bash
curl -s … | jq '.report.payload | {verdict, reason, net: .savings.netUsd, live}'
```

## 4. Other domains

```bash
# Hotel stay
curl -X POST http://localhost:4021/scan -H 'content-type: application/json' -d '{
  "domain":"hotel",
  "current":{"cityCode":"PAR","checkIn":"2026-09-14","checkOut":"2026-09-16","adults":2,"pricePaidUsd":280,"hotelName":"Hotel Lumiere"},
  "minSavingsUsd":20
}'

# Campsite
curl -X POST http://localhost:4021/scan -H 'content-type: application/json' -d '{
  "domain":"campsite",
  "current":{"stateCode":"CA","query":"Yosemite","arrival":"2026-09-14","nights":2,"pricePaidUsd":35},
  "minSavingsUsd":5
}'
```

## 5. Free routes need no payment

```bash
curl -s http://localhost:4021/sources | jq
curl -s http://localhost:4021/healthz
curl -s http://localhost:4021/.well-known/x402 | jq
curl -s -X POST http://localhost:4021/verify \
  -H 'content-type: application/json' -d '{"payload":{…},"signature":"…"}'
```
