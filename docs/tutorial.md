# Tutorial — from clone to a signed rebooking report

This walkthrough takes you from `git clone` to a signed improvement report against a real booking.

Every paid route here accepts **USDC on Base or USDC on Solana** — the 402 challenge lists both and the client picks. The walkthrough uses the Base Sepolia testnet rail because it is the easiest to fund; step 7 covers the Solana rail and mainnet.

## 1. Install

```bash
git clone https://github.com/nirholas/x402-rebooker
cd x402-rebooker
npm install
```

Requires Node 18+.

## 2. Configure

```bash
cp .env.example .env
```

`.env.example` ships pre-filled with the x402 Suite's public receive addresses, so **the server runs with no edits**. To receive the money yourself, replace both:

```
# EVM (Base / Base Sepolia) USDC receive address
PAY_TO_ADDRESS=0xYourReceivingWallet
# Solana USDC receive address
SOLANA_PAY_TO_ADDRESS=YourBase58SolanaWallet
```

The server logs a note at startup while the suite defaults are still in use.

Two optional, free keys turn the scans from deterministic samples into live inventory:

| Var | Get it at | Unlocks |
|---|---|---|
| `AMADEUS_CLIENT_ID` + `AMADEUS_CLIENT_SECRET` | [developers.amadeus.com](https://developers.amadeus.com) | live flight and hotel offers |
| `RIDB_API_KEY` | [ridb.recreation.gov/profile](https://ridb.recreation.gov/profile) | live US campground inventory |

Neither is required. Skip them for now — the rest of the tutorial works either way, and step 6 shows how to tell a fixture report from a live one at a glance.

## 3. Run the server

```bash
npm run dev
```

The startup banner lists both payment rails and which inventory providers are live:

```
  Payment rails (client picks one):
    evm     base-sepolia   USDC → 0x40252CFDF8B20Ed757D61ff157719F33Ec332402
            facilitator: https://x402.org/facilitator
    solana  solana         USDC → WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW
            facilitator: https://facilitator.payai.network
  Inventory sources:
    amadeus (flights, hotels) fixture — set AMADEUS_CLIENT_ID/SECRET
    ridb    (campsites)       fixture — set RIDB_API_KEY
```

The same information is available over HTTP, for free:

```bash
curl -s http://localhost:4021/sources | jq
```

## 4. Your first 402

```bash
curl -si -X POST http://localhost:4021/scan \
  -H 'content-type: application/json' \
  -d '{"domain":"flight","current":{"origin":"JFK","destination":"LAX","departureDate":"2026-09-14","pricePaidUsd":412},"cancellationFeeUsd":75,"minSavingsUsd":25}'
```

You get `HTTP/1.1 402 Payment Required` and a JSON body whose `accepts[]` array holds **two** x402 `PaymentRequirements` — one per rail, same price:

```bash
curl -s -X POST http://localhost:4021/scan \
  -H 'content-type: application/json' \
  -d '{"domain":"flight","current":{"origin":"JFK","destination":"LAX","departureDate":"2026-09-14","pricePaidUsd":412}}' \
  | jq '.accepts[] | {network, payTo, asset, maxAmountRequired}'
```

```json
{ "network": "base-sepolia", "payTo": "0x4025…2402", "asset": "0x036C…CF7e", "maxAmountRequired": "10000" }
{ "network": "solana",       "payTo": "Wwwu…T3WwW", "asset": "EPjF…TDt1v", "maxAmountRequired": "10000" }
```

`maxAmountRequired` is USDC base units (6 decimals), so `"10000"` = $0.01. Nothing was charged; this is the price quote.

## 5. A paid call

Fund a wallet with Base Sepolia USDC from https://faucet.circle.com, then:

```bash
PRIVATE_KEY=0xThatWalletsKey npm run client
```

`examples/agent-client.ts` wraps `fetch` with `x402-fetch`, which intercepts the 402, picks the EVM entry from `accepts[]`, signs an EIP-3009 USDC transfer authorization for exactly $0.01, retries with the `X-PAYMENT` header, and hands you the 200. It runs a flight scan, a campsite scan, and verifies the signature on both.

## 6. Reading the report

Start at the bottom and work up. The verdict tells you what to do; the arithmetic behind it is one field away.

```json
{
  "verdict": "rebook",
  "reason": "Best option nets $70.31 after a $75 cancellation fee, clearing your $25 threshold.",
  "savings": { "grossUsd": 145.31, "cancellationFeeUsd": 75, "netUsd": 70.31, "pct": 17.1 }
}
```

**`savings.netUsd` is the number to act on** — gross saving minus what it costs you to walk away from the booking you hold. A $145 price drop against a $150 change fee is not a saving, and the report says so.

Then read the candidate:

```json
{
  "label": "B6 621 · nonstop · departs 2026-09-14T15:00",
  "priceUsd": 266.69,
  "improvements": ["$145.31 cheaper than what you paid", "1 fewer stop(s)"],
  "tradeoffs": ["different carrier (B6 vs AA) — loyalty status may not carry"]
}
```

Every candidate carries `tradeoffs` as well as `improvements`. Pass `carrier` and `stops` in `current` and the report can compare them; leave them out and it simply won't claim an improvement it can't prove.

Finally, `rebookSteps` is ordered deliberately:

```json
[
  { "step": 1, "action": "book the replacement first", "detail": "Secure … BEFORE cancelling." },
  { "step": 2, "action": "verify the fine print", "detail": "Confirm baggage allowance, seat selection cost…" },
  { "step": 3, "action": "cancel the old booking", "detail": "Cancel ABC123…" },
  { "step": 4, "action": "keep the report", "detail": "This report is signed…" }
]
```

Cancelling first is the one irreversible mistake in this move, so it is never step 1.

### Is this report real?

Three fields tell you, and they always agree:

```json
{ "source": "fixture", "live": false,
  "notes": ["AMADEUS_CLIENT_ID/AMADEUS_CLIENT_SECRET unset — candidates are deterministic fixtures."] }
```

Fixtures are seeded from the booking you posted, so the same request always returns the same report — handy for wiring up a client, useless for cancelling a real reservation. Set the Amadeus keys and the same call returns `source: "amadeus"`, `live: true`.

### Verify the signature

```bash
curl -s -X POST http://localhost:4021/verify \
  -H 'content-type: application/json' -d "$(jq -c '.report' report.json)"
# {"valid":true}
```

The report is HMAC-signed over canonical JSON, so it stands as a record of what the market looked like at the moment you decided — free to re-check, forever.

## 7. Paying on the Solana rail

The second `accepts[]` entry is the Solana rail. Its `extra.feePayer` is the facilitator account that sponsors the SOL network fee, so a payer needs **only USDC** — no SOL for gas.

Build a fee-sponsored SPL `transferChecked` for `maxAmountRequired` to the base58 `payTo`, sign it, and send the base64 x402 envelope as `X-PAYMENT`. The payment modal's server helpers do the building and encoding:

```ts
import { prepareSolanaCheckout, encodeX402Payment } from "@three-ws/x402-payment-modal/server";

const res = await fetch(`${BASE}/scan`, { method: "POST", headers, body });   // → 402
const accept = (await res.json()).accepts.find((a) => a.network.startsWith("solana"));

const { tx_base64 } = await prepareSolanaCheckout({ accept, buyer: myPublicKey });
const { x_payment } = encodeX402Payment({
  accept, signedTxBase64: await wallet.signTransaction(tx_base64), resourceUrl: accept.resource,
});
const paid = await fetch(`${BASE}/scan`, { method: "POST", headers: { ...headers, "X-PAYMENT": x_payment }, body });
```

To test on devnet instead of mainnet, set `SOLANA_NETWORK=devnet`.

## 8. Going live

1. **Get the free keys.** `AMADEUS_CLIENT_ID` / `AMADEUS_CLIENT_SECRET` for flights and hotels, `RIDB_API_KEY` for campsites. `test.api.amadeus.com` is the free sandbox; set `AMADEUS_BASE_URL=https://api.amadeus.com` for production inventory.
2. **EVM rail**: set `NETWORK=base` and point `FACILITATOR_URL` at a mainnet-capable facilitator (the default x402.org facilitator settles testnets).
3. **Solana rail**: already mainnet by default (`SOLANA_NETWORK=mainnet-beta`, PayAI facilitator). Nothing to change.
4. Set a strong `SIGNING_SECRET` and real receiving wallets for `PAY_TO_ADDRESS` / `SOLANA_PAY_TO_ADDRESS`.

Want a single rail? Unset the other rail's `payTo`; it is dropped from `accepts` with a startup warning and the remaining rail keeps working.

Prices stay in dollar strings (`$0.01`); the middleware converts to USDC base units per network, so both rails always quote the same price.
