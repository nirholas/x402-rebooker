// GENERATED from openapi.json — do not edit by hand.
//
// Per-route invocation contracts published inside the x402 402 challenge as
// `accepts[].outputSchema`. `input` tells an agent how to build the request
// (method, query/path params, JSON body fields); `output` is the JSON Schema of
// the 200 body it gets back once payment settles.
//
// Deriving these from `openapi.json` keeps the runtime challenge — which the
// x402scan discovery spec treats as authoritative — from ever contradicting the
// published spec. Regenerate whenever a paid route's parameters or response
// schema change.
//
// Keys match the paywall route map in `server.ts` exactly (`"<METHOD> <path>"`,
// with `:param` for path segments).

import type { RouteSchema } from "./payments.js";

export const ROUTE_SCHEMAS: Record<string, RouteSchema> = {
  "POST /scan": {
    "input": {
      "type": "http",
      "method": "POST",
      "bodyType": "json",
      "bodyFields": {
        "domain": {
          "type": "string",
          "enum": [
            "flight",
            "hotel",
            "campsite"
          ],
          "x-required": true
        },
        "current": {
          "type": "object",
          "description": "The booking you already hold. flight: origin, destination, departureDate, pricePaidUsd. hotel: cityCode, checkIn, checkOut, pricePaidUsd. campsite: pricePaidUsd plus stateCode or query.",
          "properties": {
            "pricePaidUsd": {
              "type": "number",
              "description": "What you paid. Required in every domain."
            },
            "origin": {
              "type": "string"
            },
            "destination": {
              "type": "string"
            },
            "departureDate": {
              "type": "string"
            },
            "returnDate": {
              "type": "string"
            },
            "adults": {
              "type": "integer"
            },
            "cabin": {
              "type": "string"
            },
            "stops": {
              "type": "integer"
            },
            "carrier": {
              "type": "string"
            },
            "cityCode": {
              "type": "string"
            },
            "checkIn": {
              "type": "string"
            },
            "checkOut": {
              "type": "string"
            },
            "hotelName": {
              "type": "string"
            },
            "stateCode": {
              "type": "string"
            },
            "query": {
              "type": "string"
            },
            "latitude": {
              "type": "number"
            },
            "longitude": {
              "type": "number"
            },
            "radiusMiles": {
              "type": "number"
            },
            "campgroundName": {
              "type": "string"
            },
            "bookingRef": {
              "type": "string"
            }
          },
          "required": [
            "pricePaidUsd"
          ],
          "x-required": true
        },
        "cancellationFeeUsd": {
          "type": "number",
          "default": 0,
          "description": "What it costs to walk away from the booking you hold."
        },
        "minSavingsUsd": {
          "type": "number",
          "default": 1,
          "description": "Don't recommend a switch that nets less than this."
        },
        "maxCandidates": {
          "type": "integer",
          "default": 5,
          "minimum": 1,
          "maximum": 20
        }
      }
    },
    "output": {
      "type": "object",
      "properties": {
        "report": {
          "type": "object",
          "properties": {
            "payload": {
              "type": "object",
              "properties": {
                "reportId": {
                  "type": "string"
                },
                "domain": {
                  "type": "string",
                  "enum": [
                    "flight",
                    "hotel",
                    "campsite"
                  ]
                },
                "source": {
                  "type": "string",
                  "enum": [
                    "amadeus",
                    "ridb",
                    "fixture"
                  ]
                },
                "live": {
                  "type": "boolean"
                },
                "pricePaidUsd": {
                  "type": "number"
                },
                "cancellationFeeUsd": {
                  "type": "number"
                },
                "minSavingsUsd": {
                  "type": "number"
                },
                "scanned": {
                  "type": "integer"
                },
                "candidates": {
                  "type": "array",
                  "items": {
                    "type": "object",
                    "properties": {
                      "id": {
                        "type": "string"
                      },
                      "label": {
                        "type": "string"
                      },
                      "priceUsd": {
                        "type": [
                          "number",
                          "null"
                        ]
                      },
                      "savingsUsd": {
                        "type": [
                          "number",
                          "null"
                        ]
                      },
                      "netSavingsUsd": {
                        "type": [
                          "number",
                          "null"
                        ]
                      },
                      "improvements": {
                        "type": "array",
                        "items": {
                          "type": "string"
                        }
                      },
                      "tradeoffs": {
                        "type": "array",
                        "items": {
                          "type": "string"
                        }
                      },
                      "details": {
                        "type": "object"
                      }
                    }
                  }
                },
                "best": {
                  "type": [
                    "object",
                    "null"
                  ]
                },
                "savings": {
                  "type": "object",
                  "properties": {
                    "grossUsd": {
                      "type": [
                        "number",
                        "null"
                      ]
                    },
                    "cancellationFeeUsd": {
                      "type": "number"
                    },
                    "netUsd": {
                      "type": [
                        "number",
                        "null"
                      ]
                    },
                    "pct": {
                      "type": [
                        "number",
                        "null"
                      ]
                    }
                  }
                },
                "rebookSteps": {
                  "type": "array",
                  "items": {
                    "type": "object",
                    "properties": {
                      "step": {
                        "type": "integer"
                      },
                      "action": {
                        "type": "string"
                      },
                      "detail": {
                        "type": "string"
                      }
                    }
                  }
                },
                "verdict": {
                  "type": "string",
                  "enum": [
                    "rebook",
                    "hold"
                  ]
                },
                "reason": {
                  "type": "string"
                },
                "notes": {
                  "type": "array",
                  "items": {
                    "type": "string"
                  }
                },
                "scannedAt": {
                  "type": "string"
                }
              }
            },
            "signature": {
              "type": "string"
            },
            "algorithm": {
              "type": "string",
              "const": "HMAC-SHA256"
            },
            "canonicalization": {
              "type": "string",
              "const": "sorted-json"
            }
          }
        },
        "payment": {
          "type": "object",
          "description": "Settlement receipt, base64-JSON in the X-PAYMENT-RESPONSE header of every paid 200.",
          "properties": {
            "success": {
              "type": "boolean"
            },
            "rail": {
              "type": "string",
              "enum": [
                "evm",
                "solana"
              ]
            },
            "network": {
              "type": "string"
            },
            "transaction": {
              "type": [
                "string",
                "null"
              ]
            },
            "payer": {
              "type": [
                "string",
                "null"
              ]
            },
            "amount": {
              "type": "string"
            },
            "asset": {
              "type": "string",
              "const": "USDC"
            }
          }
        }
      }
    }
  },
};
