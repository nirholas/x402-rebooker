# Expose x402-rebooker as an MCP tool for Claude

[MCP](https://modelcontextprotocol.io) lets Claude call your services as tools. This implementation wraps `x402-fetch`, so every call pays its own way with USDC.

The service is **dual rail** — its 402 challenges accept USDC on Base *and* USDC on Solana. `x402-fetch` pays the Base rail; to pay from a Solana wallet instead, swap the fetch wrapper for an x402 Solana client (see [`docs/agents.md`](../docs/agents.md#solana-rail)). Everything below is otherwise identical.

## The server

```ts
// rebooker-mcp.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { wrapFetchWithPayment } from "x402-fetch";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";

const BASE = process.env.REBOOKER_URL ?? "http://localhost:4021";
const payFetch = wrapFetchWithPayment(
  fetch,
  privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`),
);

const server = new McpServer({ name: "x402-rebooker", version: "0.1.0" });

server.tool(
  "rebooker_sources",
  "Check whether this rebooker deployment can reach live inventory (Amadeus flights/hotels, RIDB campsites) or will return deterministic fixtures. Free — call before scanning.",
  {},
  async () => {
    const res = await fetch(`${BASE}/sources`);
    return { content: [{ type: "text", text: JSON.stringify(await res.json(), null, 2) }] };
  },
);

server.tool(
  "scan_booking",
  "Scan live inventory against a booking the user already holds ($0.01). Returns ranked candidates with improvements AND tradeoffs, savings net of the cancellation fee, ordered rebook steps, and a rebook/hold verdict. 'hold' is a normal answer.",
  {
    domain: z.enum(["flight", "hotel", "campsite"]),
    current: z
      .object({
        pricePaidUsd: z.number().describe("What the user actually paid. Required."),
        // flight
        origin: z.string().optional().describe("IATA airport code, e.g. JFK"),
        destination: z.string().optional(),
        departureDate: z.string().optional().describe("YYYY-MM-DD"),
        returnDate: z.string().optional(),
        adults: z.number().optional(),
        cabin: z.string().optional(),
        stops: z.number().optional().describe("Stops on the booking they hold — enables stop-count comparison"),
        carrier: z.string().optional().describe("Carrier they hold — enables loyalty tradeoff flagging"),
        // hotel
        cityCode: z.string().optional().describe("IATA city code, e.g. PAR"),
        checkIn: z.string().optional(),
        checkOut: z.string().optional(),
        hotelName: z.string().optional(),
        // campsite
        stateCode: z.string().optional().describe("Two-letter US state, e.g. CA"),
        query: z.string().optional().describe("Free text, e.g. Yosemite"),
        bookingRef: z.string().optional().describe("Echoed into the rebook steps"),
      })
      .passthrough(),
    cancellationFeeUsd: z.number().optional().describe("What it costs to walk away. Be honest — it decides the verdict."),
    minSavingsUsd: z.number().optional().describe("Smallest net gain worth acting on. Default 1."),
  },
  async (args) => {
    const res = await payFetch(`${BASE}/scan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args),
    });
    const body = await res.json();
    return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
  },
);

await server.connect(new StdioServerTransport());
```

```bash
npm install @modelcontextprotocol/sdk x402-fetch viem zod tsx
```

## Wire it into Claude Desktop

`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "x402-rebooker": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/rebooker-mcp.ts"],
      "env": {
        "REBOOKER_URL": "http://localhost:4021",
        "PRIVATE_KEY": "0x…wallet with Base Sepolia USDC…"
      }
    }
  }
}
```

Give the wallet a small, capped balance — every `scan_booking` call spends real (testnet) USDC. The tool result includes `payment.rail` and `payment.transaction`, so the agent can report exactly what it spent and on which chain.

## Prompting notes

- Tell the agent to pass `cancellationFeeUsd` from the user's actual booking terms. Without it every price drop looks like a saving, which is how people lose money on this move.
- Have the agent surface `report.payload.live`. A `false` there means the numbers are sample data — a dry run, not a recommendation.
- Ask it to read `best.tradeoffs` aloud alongside `best.improvements`. A cheaper fare with one seat left and a different carrier is a different proposition from a cheaper fare on the same airline.
- The verdict already accounts for the user's threshold, so the agent should not re-derive it — `verdict: "hold"` means hold.
- Reports are signed. Keep `report.payload` + `report.signature`; `POST /verify` re-checks it later for free.
