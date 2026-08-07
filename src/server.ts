import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { activeRails, paymentReceipt, paywall, usingSuiteDefaultPayTo } from "./payments.js";
import { ROUTE_SCHEMAS } from "./schemas.js";
import { amadeusConfigured } from "./amadeus.js";
import { ridbConfigured } from "./ridb.js";
import { scan, validateScanRequest } from "./service.js";
import { usingDevSecret, verify } from "./sign.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, "..", "public");

const PORT = Number(process.env.PORT ?? 4043);

const PRICES: Record<string, string> = {
  "POST /scan": "$0.01",
};

const DESCRIPTIONS: Record<string, string> = {
  "POST /scan":
    "Scan live inventory against a booking you already hold; returns a signed better-option report with candidates, net savings and rebook steps",
};

const rails = activeRails();

const app = express();
app.use(express.json({ limit: "256kb" }));
app.use(paywall(PRICES, { service: "x402-rebooker", descriptions: DESCRIPTIONS, schemas: ROUTE_SCHEMAS }));

// ---------- paid routes ----------

app.post("/scan", async (req, res) => {
  const { error, request } = validateScanRequest(req.body);
  if (error || !request) {
    res.status(400).json({
      error,
      hint: 'POST body: {"domain":"flight","current":{"origin":"JFK","destination":"LAX","departureDate":"2026-09-14","pricePaidUsd":412},"cancellationFeeUsd":75,"minSavingsUsd":25}',
    });
    return;
  }
  try {
    const report = await scan(request);
    res.status(200).json({ report, payment: paymentReceipt(res) });
  } catch (err) {
    res.status(500).json({
      error: "scan_failed",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
});

// ---------- free routes ----------

app.get("/sources", (_req, res) => {
  res.json({
    flight: {
      provider: "Amadeus Self-Service — /v2/shopping/flight-offers",
      live: amadeusConfigured(),
      unlock: "AMADEUS_CLIENT_ID + AMADEUS_CLIENT_SECRET (free at developers.amadeus.com)",
      fallback: "deterministic fixtures, labeled source: \"fixture\"",
    },
    hotel: {
      provider: "Amadeus Self-Service — /v3/shopping/hotel-offers",
      live: amadeusConfigured(),
      unlock: "AMADEUS_CLIENT_ID + AMADEUS_CLIENT_SECRET",
      fallback: "deterministic fixtures, labeled source: \"fixture\"",
    },
    campsite: {
      provider: "RIDB (Recreation Information Database) — /facilities",
      live: ridbConfigured(),
      unlock: "RIDB_API_KEY (free at ridb.recreation.gov/profile)",
      fallback: "deterministic fixtures, labeled source: \"fixture\"",
      note: "RIDB publishes facility inventory and fees, not live nightly availability.",
    },
  });
});

app.post("/verify", (req, res) => {
  const { payload, signature } = req.body ?? {};
  if (payload === undefined || typeof signature !== "string") {
    res.status(400).json({ error: "body must be {payload, signature}" });
    return;
  }
  res.json({ valid: verify({ payload, signature }) });
});

app.get("/healthz", (_req, res) => {
  res.json({
    ok: true,
    service: "x402-rebooker",
    rails: rails.map((r) => ({ rail: r.rail, network: r.network })),
    live: { amadeus: amadeusConfigured(), ridb: ridbConfigured() },
  });
});

app.get("/.well-known/x402", (_req, res) => {
  res.type("application/json");
  res.sendFile(path.join(PUBLIC_DIR, ".well-known", "x402"));
});

// Agent-facing skill file lives at the repo root; serve it alongside the manifest.
app.get("/skill.md", (_req, res) => {
  res.type("text/markdown");
  res.sendFile(path.resolve(__dirname, "..", "skill.md"));
});

app.use(express.static(PUBLIC_DIR));

app.listen(PORT, () => {
  console.log(`x402-rebooker listening on http://localhost:${PORT}`);
  console.log("  Payment rails (client picks one):");
  for (const rail of rails) {
    console.log(`    ${rail.rail.padEnd(7)} ${rail.network.padEnd(14)} USDC → ${rail.payTo}`);
    console.log(`            facilitator: ${rail.facilitator}`);
  }
  if (usingSuiteDefaultPayTo()) {
    console.log(
      "  NOTE: using suite default payTo — set PAY_TO_ADDRESS / SOLANA_PAY_TO_ADDRESS to receive funds yourself.",
    );
  }
  console.log("  Inventory sources:");
  console.log(`    amadeus (flights, hotels) ${amadeusConfigured() ? "LIVE" : "fixture — set AMADEUS_CLIENT_ID/SECRET"}`);
  console.log(`    ridb    (campsites)       ${ridbConfigured() ? "LIVE" : "fixture — set RIDB_API_KEY"}`);
  if (usingDevSecret()) {
    console.log("  WARNING: using built-in dev SIGNING_SECRET — set SIGNING_SECRET in production.");
  }
  console.log("  Paid routes:");
  for (const [route, price] of Object.entries(PRICES)) {
    console.log(`    ${route.padEnd(26)} ${price}`);
  }
  console.log("  Free routes: GET /sources, POST /verify, GET /healthz, GET /.well-known/x402");
});
