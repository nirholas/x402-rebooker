// Dual-rail x402 paywall — USDC on Base (EVM) *and* USDC on Solana (SVM).
//
// Identical in shape across every repo in the x402 Suite. One middleware,
// `paywall(routePrices, opts)`, that:
//
//   1. Answers an unpaid request with `402` + an `accepts` array holding BOTH
//      rails, so the client pays with whichever wallet it has.
//   2. On a retry carrying `X-PAYMENT`, detects the rail from the payload's
//      `network`, then verifies + settles through that rail's facilitator.
//   3. Sets `X-PAYMENT-RESPONSE` (base64 JSON settlement receipt: tx hash /
//      signature + rail) and calls `next()` so the route handler can return the
//      purchased artifact in the 200 body.
//
// Why not `paymentMiddleware` from `x402-express`? It takes a single `payTo`
// address and therefore advertises a single rail. We still use the official
// `x402` core for pricing, schema validation and the facilitator client — this
// file only adds the second rail on top.
//
// If a rail is misconfigured (bad or missing payTo) it is omitted from
// `accepts` and logged, rather than crashing the server.

import type { NextFunction, Request, RequestHandler, Response } from "express";
import { processPriceToAtomicAmount, safeBase64Decode, safeBase64Encode } from "x402/shared";
import type { Network, PaymentPayload, PaymentRequirements } from "x402/types";
import { PaymentPayloadSchema } from "x402/types";
import { useFacilitator } from "x402/verify";

/** Suite default receive addresses. Override with env to get paid yourself. */
export const DEFAULT_EVM_PAY_TO = "0x40252CFDF8B20Ed757D61ff157719F33Ec332402";
export const DEFAULT_SOLANA_PAY_TO = "WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW";

/** USDC SPL mint on Solana mainnet / devnet. */
const USDC_MINT_SOLANA = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDC_MINT_SOLANA_DEVNET = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

/**
 * The facilitator's sponsor account: it co-signs Solana settlements as fee
 * payer so the buyer needs only USDC and no SOL for gas. A PUBLIC key — not a
 * secret, and not a payout address.
 */
const DEFAULT_SOLANA_FEE_PAYER = "2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4";

export interface PaywallOptions {
  /** Human name of this service, used in the 402 `description`. */
  service: string;
  /** Absolute base URL used to build the `resource` field. */
  baseUrl?: string;
  /** Optional per-route descriptions, keyed exactly like `routePrices`. */
  descriptions?: Record<string, string>;
  /**
   * Optional per-route input/output schemas, keyed exactly like `routePrices`.
   * Each is copied verbatim into `accepts[].outputSchema` on every rail.
   */
  schemas?: Record<string, RouteSchema>;
}

export interface RailInfo {
  rail: "evm" | "solana";
  network: string;
  payTo: string;
  facilitator: string;
}

/**
 * `"GET /products"` → `"$0.002"`. Keys are `<METHOD> <path>`; a path segment of
 * `*` or `:name` matches any single segment, so `"POST /pools/:id/pay"` covers
 * `POST /pools/pool_abc/pay`.
 */
export type RoutePrices = Record<string, string>;

/**
 * The x402 Bazaar `outputSchema` for one paid route: how to call it, and what
 * the 200 body looks like. Published inside every `accepts` entry so an agent
 * can construct a valid request straight from the 402 challenge, without
 * fetching `openapi.json` first. Generated into `schemas.ts` from the OpenAPI
 * document so spec and runtime cannot drift.
 */
export interface RouteSchema {
  /** `{type:"http", method, queryParams|bodyType+bodyFields, pathParams?}`. */
  input: Record<string, unknown>;
  /** JSON Schema of the 200 response body. */
  output: Record<string, unknown>;
}

const EVM_NETWORK = (process.env.NETWORK === "base" ? "base" : "base-sepolia") as Network;
const EVM_PAY_TO = process.env.PAY_TO_ADDRESS ?? DEFAULT_EVM_PAY_TO;
const EVM_FACILITATOR = process.env.FACILITATOR_URL ?? "https://x402.org/facilitator";

const SOLANA_DEVNET = process.env.SOLANA_NETWORK === "devnet";
const SOLANA_NETWORK = (SOLANA_DEVNET ? "solana-devnet" : "solana") as Network;
const SOLANA_PAY_TO = process.env.SOLANA_PAY_TO_ADDRESS ?? DEFAULT_SOLANA_PAY_TO;
const SOLANA_FEE_PAYER = process.env.SOLANA_FEE_PAYER ?? DEFAULT_SOLANA_FEE_PAYER;
// The reference x402.org facilitator settles base-sepolia and solana-devnet, so
// the Solana rail defaults to PayAI's public facilitator, which settles Solana
// mainnet too. No API key required for either.
const SOLANA_FACILITATOR = process.env.SOLANA_FACILITATOR_URL ?? "https://facilitator.payai.network";

const usingDefaultPayTo = !process.env.PAY_TO_ADDRESS || !process.env.SOLANA_PAY_TO_ADDRESS;

/** Which rails this process will advertise. Used for the startup banner. */
export function activeRails(): RailInfo[] {
  const rails: RailInfo[] = [];
  if (/^0x[0-9a-fA-F]{40}$/.test(EVM_PAY_TO)) {
    rails.push({ rail: "evm", network: EVM_NETWORK, payTo: EVM_PAY_TO, facilitator: EVM_FACILITATOR });
  } else {
    console.warn(`[x402] EVM rail disabled: PAY_TO_ADDRESS "${EVM_PAY_TO}" is not a valid address`);
  }
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(SOLANA_PAY_TO)) {
    rails.push({
      rail: "solana",
      network: SOLANA_NETWORK,
      payTo: SOLANA_PAY_TO,
      facilitator: SOLANA_FACILITATOR,
    });
  } else {
    console.warn(
      `[x402] Solana rail disabled: SOLANA_PAY_TO_ADDRESS "${SOLANA_PAY_TO}" is not a valid base58 address`,
    );
  }
  return rails;
}

export function usingSuiteDefaultPayTo(): boolean {
  return usingDefaultPayTo;
}

/** The settlement receipt echoed in `X-PAYMENT-RESPONSE`. */
export interface PaymentReceipt {
  success: true;
  rail: "evm" | "solana";
  network: string;
  /** The facilitator that verified + settled this payment. Differs per rail. */
  facilitator: string;
  transaction: string | null;
  payer: string | null;
  amount: string;
  asset: "USDC";
}

/**
 * The settlement receipt for the request currently being handled, so a route
 * can fold the rail + tx into the artifact it returns. `null` on free routes.
 */
export function paymentReceipt(res: Response): PaymentReceipt | null {
  return (res.locals?.x402 as PaymentReceipt | undefined) ?? null;
}

/**
 * Match a `<METHOD> <path>` route key against a live request. `*` and `:name`
 * segments are wildcards; everything else must match literally.
 */
function routeMatches(pattern: string, method: string, path: string): boolean {
  const space = pattern.indexOf(" ");
  if (space === -1) return false;
  const patMethod = pattern.slice(0, space).toUpperCase();
  const patPath = pattern.slice(space + 1).trim();
  if (patMethod !== "*" && patMethod !== method.toUpperCase()) return false;

  const want = patPath.split("/").filter(Boolean);
  const got = path.split("/").filter(Boolean);
  if (want.length !== got.length) return false;
  return want.every((seg, i) => seg === "*" || seg.startsWith(":") || seg === got[i]);
}

/** The route key covering this request, or undefined when the route is free. */
function matchRoute(routePrices: RoutePrices, method: string, path: string): string | undefined {
  const exact = `${method.toUpperCase()} ${path}`;
  if (routePrices[exact]) return exact;
  return Object.keys(routePrices).find((k) => routeMatches(k, method, path));
}

function resourceUrl(req: Request, baseUrl?: string): string {
  if (baseUrl) return `${baseUrl.replace(/\/+$/, "")}${req.path}`;
  const proto = (req.headers["x-forwarded-proto"] as string) ?? req.protocol ?? "http";
  return `${proto}://${req.headers.host ?? "localhost"}${req.path}`;
}

/**
 * Build the `accepts` array: one canonical x402 `PaymentRequirements` per rail.
 * Amounts are USDC atomic units (6 decimals) — `$0.002` → `"2000"`.
 */
function buildAccepts(
  price: string,
  resource: string,
  description: string,
  outputSchema?: RouteSchema,
): PaymentRequirements[] {
  const accepts: PaymentRequirements[] = [];

  for (const rail of activeRails()) {
    if (rail.rail === "evm") {
      const priced = processPriceToAtomicAmount(price, EVM_NETWORK);
      if ("error" in priced) {
        console.warn(`[x402] EVM rail skipped for ${resource}: ${priced.error}`);
        continue;
      }
      accepts.push({
        scheme: "exact",
        network: EVM_NETWORK,
        maxAmountRequired: priced.maxAmountRequired,
        resource: resource as `${string}://${string}`,
        description,
        mimeType: "application/json",
        payTo: rail.payTo,
        maxTimeoutSeconds: 60,
        asset: priced.asset.address,
        outputSchema,
        extra: "eip712" in priced.asset ? priced.asset.eip712 : undefined,
      });
    } else {
      // Solana: USDC SPL transfer. `extra.feePayer` is the facilitator sponsor
      // that pays the SOL network fee, so the buyer needs only USDC.
      const priced = processPriceToAtomicAmount(price, SOLANA_NETWORK);
      if ("error" in priced) {
        console.warn(`[x402] Solana rail skipped for ${resource}: ${priced.error}`);
        continue;
      }
      accepts.push({
        scheme: "exact",
        network: SOLANA_NETWORK,
        maxAmountRequired: priced.maxAmountRequired,
        resource: resource as `${string}://${string}`,
        description,
        mimeType: "application/json",
        payTo: rail.payTo,
        maxTimeoutSeconds: 60,
        asset: SOLANA_DEVNET ? USDC_MINT_SOLANA_DEVNET : USDC_MINT_SOLANA,
        outputSchema,
        extra: {
          name: "USD Coin",
          decimals: 6,
          feePayer: SOLANA_FEE_PAYER,
          // `amount` mirrors `maxAmountRequired` for x402 v2 / Solana clients
          // (e.g. @three-ws/x402-payment-modal) that read the v2 field name.
          amount: priced.maxAmountRequired,
        },
      });
    }
  }

  return accepts;
}

function facilitatorFor(network: string): `${string}://${string}` {
  return (network.startsWith("solana") ? SOLANA_FACILITATOR : EVM_FACILITATOR) as `${string}://${string}`;
}

function challenge(res: Response, accepts: PaymentRequirements[], error?: string): void {
  res
    .status(402)
    .type("application/json")
    .json({
      x402Version: 1,
      error: error ?? "X-PAYMENT header is required",
      accepts,
    });
}

/**
 * Express middleware. Routes absent from `routePrices` stay free.
 *
 *   app.use(paywall({ "GET /check": "$0.002" }, { service: "x402-price-watch" }));
 */
export function paywall(routePrices: RoutePrices, opts: PaywallOptions): RequestHandler {
  const describe = (key: string) => opts.descriptions?.[key] ?? `${opts.service}: ${key}`;

  return async function paywallMiddleware(req: Request, res: Response, next: NextFunction) {
    const key = matchRoute(routePrices, req.method, req.path);
    if (!key) return next(); // free route
    const price = routePrices[key];

    const resource = resourceUrl(req, opts.baseUrl ?? process.env.PUBLIC_BASE_URL);
    const accepts = buildAccepts(price, resource, describe(key), opts.schemas?.[key]);

    if (accepts.length === 0) {
      res.status(500).json({
        error: "no_payment_rail",
        message: "No payment rail is configured. Set PAY_TO_ADDRESS and/or SOLANA_PAY_TO_ADDRESS.",
      });
      return;
    }

    const header = req.header("X-PAYMENT");
    if (!header) return challenge(res, accepts);

    // ---- Decode the payment payload ----
    let payload: PaymentPayload;
    try {
      payload = PaymentPayloadSchema.parse(JSON.parse(safeBase64Decode(header)));
    } catch (err) {
      return challenge(res, accepts, `invalid X-PAYMENT header: ${(err as Error).message}`);
    }

    // ---- Pick the requirement matching the rail the client chose ----
    const requirement = accepts.find(
      (a) => a.network === payload.network && a.scheme === payload.scheme,
    );
    if (!requirement) {
      return challenge(
        res,
        accepts,
        `unsupported rail: this endpoint does not accept ${payload.scheme} on ${payload.network}`,
      );
    }

    const facilitator = useFacilitator({ url: facilitatorFor(requirement.network) });

    // ---- Verify ----
    try {
      const verification = await facilitator.verify(payload, requirement);
      if (!verification.isValid) {
        return challenge(res, accepts, `payment rejected: ${verification.invalidReason ?? "unknown reason"}`);
      }
    } catch (err) {
      res.status(502).json({
        error: "facilitator_unreachable",
        message: `could not verify payment: ${(err as Error).message}`,
      });
      return;
    }

    // ---- Settle, then hand off to the route so it can return the artifact ----
    try {
      const settlement = await facilitator.settle(payload, requirement);
      if (!settlement.success) {
        return challenge(res, accepts, `settlement failed: ${settlement.errorReason ?? "unknown reason"}`);
      }
      const receipt: PaymentReceipt = {
        success: true,
        rail: requirement.network.startsWith("solana") ? "solana" : "evm",
        network: settlement.network ?? requirement.network,
        facilitator: facilitatorFor(requirement.network),
        transaction: settlement.transaction ?? null,
        payer: settlement.payer ?? null,
        amount: requirement.maxAmountRequired,
        asset: "USDC",
      };
      res.locals.x402 = receipt;
      res.setHeader("X-PAYMENT-RESPONSE", safeBase64Encode(JSON.stringify(receipt)));
      res.setHeader("Access-Control-Expose-Headers", "X-PAYMENT-RESPONSE");
    } catch (err) {
      res.status(502).json({
        error: "settlement_error",
        message: `could not settle payment: ${(err as Error).message}`,
      });
      return;
    }

    next();
  };
}
