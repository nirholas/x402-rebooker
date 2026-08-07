# For AI agents

x402-rebooker is built for the polling case: an agent holding a user's itinerary checks it for a cent, and acts only when the answer changes. Discovery, payment, and verification all happen over plain HTTP with no accounts.

**Pay in USDC on Base or Solana — your client picks the rail.** Every 402 challenge carries both requirements at the same price; send `X-PAYMENT` for whichever wallet you hold.

## Discovery

Two machine-readable entry points, served by every deployment:

1. **`/skill.md`** (also at the repo root) — a human-and-agent-readable skill file describing every endpoint, price, parameter, and response schema, following the agentres.dev skill.md pattern. Feed it to your agent as context and it knows how to use the service.
2. **`GET /.well-known/x402`** — a JSON manifest (`x402Version`, `payment.rails[]`, and `resources[]` with prices, both networks, per-rail `accepts`, and output schemas) in the discovery format indexed by [x402scan.com](https://x402scan.com), the x402 Bazaar, and [agentic.market](https://agentic.market).

Also call **`GET /sources`** (free) to learn whether a given deployment can reach live inventory, before you spend anything.

**Operators:** after deploying, submit your base URL to those indexes so agents can find you — x402scan crawls `/.well-known/x402` automatically once listed.

## Paying

Any x402-compatible client works. With `x402-fetch`:

```ts
import { wrapFetchWithPayment } from "x402-fetch";
import { privateKeyToAccount } from "viem/accounts";

const payFetch = wrapFetchWithPayment(fetch, privateKeyToAccount(process.env.PRIVATE_KEY));
const res = await payFetch("https://rebooker.example/scan", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    domain: "flight",
    current: { origin: "JFK", destination: "LAX", departureDate: "2026-09-14", pricePaidUsd: 412, stops: 1, carrier: "AA" },
    cancellationFeeUsd: 75,
    minSavingsUsd: 25,
  }),
});
const { report } = await res.json();
if (report.payload.verdict === "rebook") { /* act */ }
```

The wrapper handles the 402 → sign → retry loop and enforces a max payment cap (default 0.10 USDC) so a misconfigured server can't drain the wallet. It selects the EVM entry from `accepts[]`.

### Solana rail

Read the entry whose `network` starts with `solana`, build a fee-sponsored SPL `transferChecked` for `maxAmountRequired` to the base58 `payTo`, sign it, and send the base64 x402 envelope as `X-PAYMENT`. `extra.feePayer` sponsors the SOL network fee, so a USDC balance is sufficient — no SOL required.

```ts
import { prepareSolanaCheckout, encodeX402Payment } from "@three-ws/x402-payment-modal/server";

const res = await fetch(url, { method: "POST", headers, body });   // → 402
const accept = (await res.json()).accepts.find((a) => a.network.startsWith("solana"));
const { tx_base64 } = await prepareSolanaCheckout({ accept, buyer: myPublicKey });
const { x_payment } = encodeX402Payment({
  accept, signedTxBase64: await wallet.signTransaction(tx_base64), resourceUrl: accept.resource,
});
const paid = await fetch(url, { method: "POST", headers: { ...headers, "X-PAYMENT": x_payment }, body });
```

### Reading the settlement receipt

Every paid `200` carries `X-PAYMENT-RESPONSE`, base64 JSON: `{success, rail, network, facilitator, transaction, payer, amount, asset}` — also echoed in the body as `payment`. Use `rail` to record which chain your budget was drawn on.

## What you get back

A signed report. The three fields an agent should branch on:

| Field | Use it for |
|---|---|
| `verdict` | `rebook` or `hold`. The entire decision, already made against *your* threshold |
| `savings.netUsd` | The gain after the cancellation fee you declared. Never present a gross saving to a user |
| `live` | `false` means fixtures. **Never act on a fixture report** — surface it as a dry run |

Then, before acting, read `best.tradeoffs`. A cheaper fare with a different carrier, one seat left, or a non-refundable rate is not automatically better, and the report names those costs rather than burying them.

`rebookSteps` is ordered for execution: book the replacement, verify the fine print, cancel the old booking, keep the report. An agent that follows that order cannot strand its user with nothing booked.

Because a failing live lookup degrades to labeled fixtures instead of erroring, a paid call always returns a usable report — payment never disappears into a side effect.

## Polling pattern

This service is priced per scan precisely so that watching is cheap:

```ts
// Once a day until the trip, ~$0.01 a look.
const report = await scanBooking(itinerary);
if (report.payload.verdict === "rebook" && report.payload.live) {
  await notifyUser(report.payload.reason, report.payload.rebookSteps);
}
```

Set `minSavingsUsd` to the smallest gain your user actually cares about — it moves the decision into the report instead of into your prompt. Set `cancellationFeeUsd` honestly; it is the difference between a real recommendation and a expensive mistake.

For hard budget ceilings across many polls, wrap your fetch with [`x402-agent-wallet`](https://github.com/nirholas/x402-agent-wallet)'s policy checks.

## MCP integration

To give Claude this capability as a tool, see [`examples/mcp-tool.md`](https://github.com/nirholas/x402-rebooker/blob/main/examples/mcp-tool.md) — a minimal MCP server exposing `scan_booking` and `rebooker_sources`, paying its own way via `x402-fetch`.

## Composing with the suite

- `x402-flight-search` finds the original booking; `x402-rebooker` watches it afterwards.
- `x402-confirmations` normalizes booking confirmations into the `current` object this service expects.
- `x402-concierge` can run a scan as one step of a larger plan and hand you the report inline with its own receipt.
- `x402-price-watch` is the sibling for pure price polling with cursors and deltas; the rebooker is the one that turns a price move into an ordered set of actions.

Questions or integration help: **nichxbt@gmail.com**
