---
name: scan-for-better-booking
description: Run the x402-rebooker HTTP service and post a flight, hotel or campsite booking you hold to get a signed improvement report with a rebook or hold verdict. Use when an agent should check whether a cheaper equivalent exists and can pay per scan in USDC over x402.
---

# x402-rebooker

x402-rebooker takes a booking you already hold and scans live inventory for the same trip. The signed report ranks candidates (worse ones too), gives the saving net of your cancellation fee, and ends with a `rebook` or `hold` verdict plus switch steps. It never books or cancels anything.

Paying is irreversible. Before any paid call, show the user the route, price, network and payTo address from the 402 response, and wait for an explicit yes.

## Run the service

From a clone (Node 18+):

```bash
git clone https://github.com/nirholas/x402-rebooker
cd x402-rebooker && npm install
npm run dev        # tsx src/server.ts, listens on :4043 (PORT overrides)
```

Environment (see `.env.example`): `SIGNING_SECRET` (HMAC key for reports, set it in production), `AMADEUS_CLIENT_ID`, `AMADEUS_CLIENT_SECRET`, `AMADEUS_BASE_URL` (sandbox by default) for flights and hotels, `RIDB_API_KEY`, `RIDB_BASE_URL` for campsites. Without keys, scans return fixtures labelled `source: "fixture"` and `live: false`. Payment settings: `PAY_TO_ADDRESS` (Base receive address), `SOLANA_PAY_TO_ADDRESS`, `NETWORK` (`base-sepolia` default, or `base`), `SOLANA_NETWORK`, `FACILITATOR_URL`, `PUBLIC_BASE_URL`. Set your own pay-to addresses to be paid yourself. `npm run build` then `npm start` runs the compiled server.

## Routes

| Route | Price | Body |
|---|---|---|
| `POST /scan` | $0.01 | `domain` (`flight`, `hotel` or `campsite`) and `current` (the booking you hold) required; `cancellationFeeUsd` (default 0), `minSavingsUsd` (default 1), `maxCandidates` (1-20, default 5) |
| `GET /sources` | free | which inventory providers are reachable live |
| `POST /verify` | free | `{payload, signature}` returns `{valid}` for a report this server signed |
| `GET /healthz`, `GET /skill.md` | free | status and capability sheet |

Required `current` keys: flight needs `origin`, `destination`, `departureDate`, `pricePaidUsd`. Hotel needs `cityCode`, `checkIn`, `checkOut`, `pricePaidUsd`. Campsite needs `pricePaidUsd` and one of `stateCode` or `query`. Optional extras include `returnDate`, `adults`, `cabin`, `bookingRef`, `hotelName`, `latitude`, `longitude`, `radiusMiles`, `campgroundName`.

## Paying

An unpaid request to a paid route returns 402 with an `accepts` array listing both rails (USDC on Base or Solana). Sign the entry your wallet supports and retry with the base64 `X-PAYMENT` header. The settlement receipt is in the `X-PAYMENT-RESPONSE` header. The reference client is `examples/agent-client.ts` (`npm run client`), which uses `x402-fetch` with `PRIVATE_KEY` for a Base Sepolia wallet and `BASE_URL` (default `http://localhost:4043`).

Reading the report: act on `savings.netUsd`, read each candidate's `improvements` and `tradeoffs`, and never cancel a real booking on a report with `live: false`. `rebookSteps` always says to book the replacement before cancelling the old booking, because cancelling first is the one irreversible mistake.

## Example

```bash
curl -i -X POST localhost:4043/scan -H 'content-type: application/json' \
  -d '{"domain":"flight","current":{"origin":"JFK","destination":"LAX","departureDate":"2026-09-14","pricePaidUsd":420},"cancellationFeeUsd":50}'
# 402 first. After approval and payment: verdict, savings.netUsd, candidates[], rebookSteps[].
```
