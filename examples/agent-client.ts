/**
 * Full x402 flow against x402-rebooker, EVM rail (primary).
 *
 * The paid route is DUAL RAIL: the 402 challenge lists USDC on Base and USDC on
 * Solana at the same price, and you pay with whichever you hold. This example
 * uses `x402-fetch` + `viem`, which handles the Base rail. See the "Solana rail"
 * note at the bottom of this file for the SVM path.
 *
 * Flow:
 *   1. GET /sources (free)  — is this deployment scanning live inventory?
 *   2. POST /scan  (paid, $0.01) — flight report
 *   3. POST /scan  (paid, $0.01) — campsite report
 *   4. POST /verify (free) — re-check the signature on what we bought
 *
 * Usage:
 *   PRIVATE_KEY=0x... BASE_URL=http://localhost:4043 npm run client
 *
 * PRIVATE_KEY must hold Base Sepolia USDC (faucet: https://faucet.circle.com).
 */
import { config } from "dotenv";
import { privateKeyToAccount } from "viem/accounts";
import { wrapFetchWithPayment, decodeXPaymentResponse } from "x402-fetch";

config();

const BASE_URL = process.env.BASE_URL ?? "http://localhost:4043";
const PRIVATE_KEY = process.env.PRIVATE_KEY;

if (!PRIVATE_KEY) {
  console.error("Set PRIVATE_KEY (0x… key of a wallet holding Base Sepolia USDC).");
  process.exit(1);
}

const account = privateKeyToAccount(PRIVATE_KEY as `0x${string}`);
const payFetch = wrapFetchWithPayment(fetch, account);

function printReceiptHeader(res: Response, label: string): void {
  const header = res.headers.get("x-payment-response");
  if (header) {
    console.log(`  ${label} X-PAYMENT-RESPONSE:`, JSON.stringify(decodeXPaymentResponse(header)));
  }
}

/** Print the parts of a report a human (or an agent) actually decides on. */
function summarize(report: any): void {
  const p = report.payload;
  console.log(`  source: ${p.source} (live: ${p.live}) · scanned ${p.scanned} option(s)`);
  console.log(`  verdict: ${p.verdict.toUpperCase()} — ${p.reason}`);
  console.log(
    `  savings: gross $${p.savings.grossUsd} − fee $${p.savings.cancellationFeeUsd} = net $${p.savings.netUsd}` +
      (p.savings.pct !== null ? ` (${p.savings.pct}%)` : ""),
  );
  if (p.best) {
    console.log(`  best: ${p.best.label} @ $${p.best.priceUsd}`);
    for (const i of p.best.improvements) console.log(`    + ${i}`);
    for (const t of p.best.tradeoffs) console.log(`    − ${t}`);
  }
  console.log("  steps:");
  for (const s of p.rebookSteps) console.log(`    ${s.step}. ${s.action} — ${s.detail}`);
  for (const n of p.notes) console.log(`  note: ${n}`);
}

async function verifySignature(report: unknown): Promise<void> {
  const res = await fetch(`${BASE_URL}/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(report),
  });
  console.log("  signature valid:", (await res.json()).valid);
}

async function main(): Promise<void> {
  console.log(`agent wallet: ${account.address}`);

  // 1. Free: will this scan be live or a deterministic fixture?
  const sources = await (await fetch(`${BASE_URL}/sources`)).json();
  console.log("\n1) inventory sources:");
  for (const [domain, info] of Object.entries<any>(sources)) {
    console.log(`  ${domain.padEnd(9)} ${info.live ? "LIVE" : "fixture"} — ${info.provider}`);
  }

  // 2. Paid: a flight you already booked, with a real cancellation fee.
  const flightRes = await payFetch(`${BASE_URL}/scan`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      domain: "flight",
      current: {
        origin: "JFK",
        destination: "LAX",
        departureDate: "2026-09-14",
        adults: 1,
        pricePaidUsd: 412,
        stops: 1,
        carrier: "AA",
        bookingRef: "ABC123",
      },
      cancellationFeeUsd: 75,
      minSavingsUsd: 25,
    }),
  });
  const flight = await flightRes.json();
  console.log("\n2) flight scan:");
  summarize(flight.report);
  printReceiptHeader(flightRes, "flight");
  await verifySignature(flight.report);

  // 3. Paid: a campsite booking. Note RIDB publishes fees, not live availability —
  //    unpriced candidates come back with priceUsd: null rather than a guess.
  const campRes = await payFetch(`${BASE_URL}/scan`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      domain: "campsite",
      current: { stateCode: "CA", query: "Yosemite", arrival: "2026-09-14", nights: 2, pricePaidUsd: 35 },
      minSavingsUsd: 5,
    }),
  });
  const camp = await campRes.json();
  console.log("\n3) campsite scan:");
  summarize(camp.report);
  printReceiptHeader(campRes, "campsite");
  await verifySignature(camp.report);

  console.log(
    "\nDone. Two scans, $0.02 total. Poll this on a schedule and act only when verdict flips to rebook.",
  );
}

main().catch((err) => {
  console.error("agent-client failed:", err);
  process.exit(1);
});

/* ---------------------------------------------------------------------------
 * Solana rail — the same route, paid with USDC on Solana.
 *
 * The 402 body's `accepts` array has a second entry with `network: "solana"`, a
 * base58 `payTo`, the USDC mint as `asset`, and `extra.feePayer` — the
 * facilitator account that sponsors the SOL network fee, so your wallet needs
 * only USDC. Build a fee-sponsored SPL `transferChecked` for
 * `maxAmountRequired`, sign it, and send it base64-encoded as `X-PAYMENT`:
 *
 *   const challenge = await (await fetch(`${BASE_URL}/scan`, {
 *     method: "POST", headers, body,
 *   })).json();
 *   const solana = challenge.accepts.find((a: any) => a.network.startsWith("solana"));
 *
 *   //   import { prepareSolanaCheckout, encodeX402Payment }
 *   //     from "@three-ws/x402-payment-modal/server";
 *   //   const { tx_base64 } = await prepareSolanaCheckout({ accept: solana, buyer: myPubkey });
 *   //   const signed = await wallet.signTransaction(tx_base64);
 *   //   const { x_payment } = encodeX402Payment({
 *   //     accept: solana, signedTxBase64: signed, resourceUrl: solana.resource,
 *   //   });
 *   //   await fetch(`${BASE_URL}/scan`, {
 *   //     method: "POST", headers: { ...headers, "X-PAYMENT": x_payment }, body,
 *   //   });
 *
 * And the raw dual-rail 402 body, for reference:
 *
 *   curl -s -X POST http://localhost:4043/scan -H 'content-type: application/json' \\
 *     -d '{"domain":"flight","current":{"origin":"JFK","destination":"LAX","departureDate":"2026-09-14","pricePaidUsd":412}}' \\
 *     | jq '.accepts[] | {network, payTo, maxAmountRequired}'
 *
 *   { "network": "base-sepolia", "payTo": "0x4025…2402", "maxAmountRequired": "10000" }
 *   { "network": "solana",       "payTo": "Wwwu…T3WwW", "maxAmountRequired": "10000" }
 * ------------------------------------------------------------------------- */
