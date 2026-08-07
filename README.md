# x402-rebooker

> The cancel-worse-book-better move, automated — scans real inventory (Amadeus/RIDB) against your current booking, returns an actionable improvement report.

![License](https://img.shields.io/badge/license-Apache--2.0-blue)
![x402](https://img.shields.io/badge/payments-x402%20%2F%20USDC-0052ff)
![rails](https://img.shields.io/badge/rails-Base%20%2B%20Solana-9945ff)
![Node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen)

> **Pay in USDC on Base or Solana — your client picks the rail.** Every 402 challenge lists both.

You booked the flight. Three weeks later the same seat is $150 cheaper, but checking takes ten minutes and you'd need to know your cancellation fee to say whether it's worth it. `POST /scan` does all of that in one paid call: it takes the booking you hold, scans live inventory for the same trip, and returns a **signed improvement report** — ranked candidates with their tradeoffs, savings net of your cancellation fee, and the exact order to rebook in.

It is honest by construction. It ranks the worse options too, it subtracts your cancellation fee before claiming a win, and it returns `verdict: "hold"` whenever nothing clears the threshold you set.

## Why x402 for this

The value of a rebooking scan decays to nothing between checks, so subscriptions price it wrong in both directions: you pay for the weeks you don't travel, and you get rate-limited the week you do. Per-request payment matches the shape of the need — an agent watching a trip pays a cent when it looks, and nothing when it doesn't. And because there's no account to open, an agent can scan on behalf of a user it just met, with no key provisioning in between.

## Quickstart

```bash
git clone https://github.com/nirholas/x402-rebooker && cd x402-rebooker
npm install
cp .env.example .env        # pre-filled — runs with no edits
npm run dev                 # server on http://localhost:4043
```

Then run the full paid flow with a wallet holding [Base Sepolia USDC](https://faucet.circle.com):

```bash
PRIVATE_KEY=0x... npm run client
```

To receive the fees yourself, set `PAY_TO_ADDRESS` (Base) and `SOLANA_PAY_TO_ADDRESS` (Solana) in `.env` — the server logs a note while the suite defaults are in use.

## API

| Route | Price | What you get back |
|---|---|---|
| `POST /scan` | $0.01 | Signed report: `candidates`, `savings`, `rebookSteps`, `verdict` |
| `GET /sources` | free | Which inventory providers this deployment can reach live |
| `POST /verify` | free | Signature check for any report issued here |
| `GET /healthz` | free | Liveness + the rails this deployment accepts |

```bash
curl -X POST http://localhost:4043/scan -H 'content-type: application/json' -d '{
  "domain": "flight",
  "current": {
    "origin": "JFK", "destination": "LAX", "departureDate": "2026-09-14",
    "pricePaidUsd": 412, "stops": 1, "carrier": "AA", "bookingRef": "ABC123"
  },
  "cancellationFeeUsd": 75,
  "minSavingsUsd": 25
}'
```

Three domains: `flight` and `hotel` (Amadeus), `campsite` (RIDB). Full field reference in [skill.md](skill.md) and [docs/api.md](docs/api.md).

### Reading the report

```json
{
  "savings": { "grossUsd": 145.31, "cancellationFeeUsd": 75, "netUsd": 70.31, "pct": 17.1 },
  "verdict": "rebook",
  "reason": "Best option nets $70.31 after a $75 cancellation fee, clearing your $25 threshold.",
  "best": {
    "label": "B6 621 · nonstop · departs 2026-09-14T15:00",
    "improvements": ["$145.31 cheaper than what you paid", "1 fewer stop(s)"],
    "tradeoffs": ["different carrier (B6 vs AA) — loyalty status may not carry"]
  },
  "rebookSteps": [
    { "step": 1, "action": "book the replacement first", "detail": "…BEFORE cancelling." },
    { "step": 3, "action": "cancel the old booking", "detail": "Cancel ABC123…" }
  ]
}
```

`savings.netUsd` is the number to act on. `rebookSteps` always puts *book the replacement first* ahead of *cancel the old booking* — the one irreversible mistake in this move.

## How x402 works — two rails, one flow

1. Client calls a paid route → server responds `402 Payment Required` with an `accepts` array holding **both** payment requirements: USDC on Base (EVM) and USDC on Solana (SVM), same price, same resource.
2. Client picks the rail its wallet supports and authorizes exactly that amount — an EIP-3009 transfer authorization on Base, or a fee-sponsored SPL `transferChecked` on Solana — then retries with the `X-PAYMENT` header.
3. The server reads `network` off the payload, selects the matching requirement, and verifies + settles through that rail's facilitator (x402.org for Base, PayAI for Solana by default).
4. Server responds `200` with the report in-body and an `X-PAYMENT-RESPONSE` header carrying the settlement receipt (`rail`, `network`, `facilitator`, `transaction`, `payer`).

Solana buyers need no SOL: the facilitator's `feePayer` sponsors the network fee, so a USDC balance is enough. `x402-fetch` does steps 2–3 automatically — see [`examples/agent-client.ts`](examples/agent-client.ts) and [`examples/curl.md`](examples/curl.md).

## Real backend / API keys

| Domain | Provider | Live when | Otherwise |
|---|---|---|---|
| flight | [Amadeus Self-Service](https://developers.amadeus.com) `/v2/shopping/flight-offers` | `AMADEUS_CLIENT_ID` + `AMADEUS_CLIENT_SECRET` | deterministic fixtures, `source: "fixture"` |
| hotel | Amadeus `/v3/shopping/hotel-offers` | same | deterministic fixtures |
| campsite | [RIDB](https://ridb.recreation.gov/docs) `/facilities` | `RIDB_API_KEY` | deterministic fixtures |

Both keys are **free** and both are **optional**. Without them the service still runs, and every fixture-backed report is labeled in three places (`source`, `live`, `notes`) so you can never mistake one for a real scan. A live lookup that fails degrades to fixtures with a note rather than failing the paid call — a scan you paid for always returns a report.

One honest limitation: RIDB publishes facility inventory and published fees, not live nightly availability. Campsite candidates without a published fee come back with `priceUsd: null` and are ranked on non-price improvements. The report never invents a price.

Payment envs: `PAY_TO_ADDRESS`, `SOLANA_PAY_TO_ADDRESS`, `NETWORK`/`FACILITATOR_URL` (EVM rail), `SOLANA_NETWORK`/`SOLANA_FACILITATOR_URL` (Solana rail). A rail whose address is missing or malformed is dropped from `accepts` with a startup warning — the other rail keeps working. `SIGNING_SECRET` is the HMAC key for reports; a dev fallback (with console warning) keeps the demo keyless.

## For AI agents

- **[skill.md](skill.md)** — agent-facing skill file: endpoints, prices, schemas, payment instructions.
- **`GET /.well-known/x402`** — machine-readable manifest, both rails per resource, indexable by [x402scan.com](https://x402scan.com), the x402 Bazaar, and [agentic.market](https://agentic.market).
- **MCP**: [`examples/mcp-tool.md`](examples/mcp-tool.md) exposes `scan_booking` as a Claude tool that pays per call.

A travel agent holding a user's itinerary can poll this on a schedule for a cent a look, and act only when `verdict` flips to `rebook`.

## Docs

Full docs on GitHub Pages: **https://nirholas.github.io/x402-rebooker/** — [tutorial](https://nirholas.github.io/x402-rebooker/tutorial), [API reference](https://nirholas.github.io/x402-rebooker/api), [agents guide](https://nirholas.github.io/x402-rebooker/agents).

Part of the [x402 Suite](https://github.com/nirholas/x402-suite).

## Support

Questions, deployments, or a rail you want added: **nichxbt@gmail.com**

## License

[Apache-2.0](LICENSE)
