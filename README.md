# mcp-fda-regulations

FDA Regulations MCP — US Food & Drug Administration regulations (21 CFR).

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1476+ live data sources.

## Tools

| Tool | Description |
|------|-------------|
| `fda_regulation` | Get the full text of one FDA regulation — a US Food & Drug Administration rule codified in 21 CFR — by its citation. Returns the exact regulatory wording currently in force. Answers "what does 21 CFR 211 require", "what is the FDA regulation for X", "does the FDA require X", "read 21 CFR 211.100", "the FDA good manufacturing practice rule". Forgiving citation input: "211.100", "21 CFR 211.100", "§211.100", even "211.100(a)" (paragraph stripped to the section). Covers 21 CFR part 211 current good manufacturing practice (cGMP / GMP) for finished drugs, part 210 cGMP general, part 820 quality system regulation / QMSR for medical devices, part 801 medical device labeling, part 101 food labeling / nutrition facts, part 314 new drug applications (NDA/ANDA), part 807 device establishment registration, part 111 dietary supplement cGMP, part 1308 controlled substance schedules — the whole of Title 21 (food, drugs, devices, cosmetics, biologics). This is FDA REGULATIONS (the rules/regulatory text); for FDA DATA (drug labels, adverse events, recalls) use the openfda tools. Pass a whole part (e.g. "211" or "820") to get that part's section list. Example: fda_regulation({ citation: "211.100" }) -> written procedures / process control; fda_regulation({ citation: "21 CFR 101.9" }) -> nutrition labeling. Keyless. |
| `fda_search` | Keyword search across FDA regulations — US Food & Drug Administration rules in 21 CFR. Answers "what FDA regulations cover X", "the FDA regulation / rule about X", "find the FDA requirement for X". Great for topics: good manufacturing practice (GMP / cGMP), quality system regulation, medical device labeling, drug labeling, nutrition facts / food labeling, new drug applications, dietary supplements, cosmetics, biologics, controlled substances, current good manufacturing practice for drugs and devices. Returns matching FDA regulations with citation (21 CFR), heading, excerpt, and source URL. This searches FDA REGULATIONS (regulatory text); for FDA DATA (drug labels, adverse events, recalls) use the openfda tools. Example: fda_search({ query: "medical device labeling" }); fda_search({ query: "good manufacturing practice", limit: 15 }). Keyless. |

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "fda-regulations": {
      "url": "https://gateway.pipeworx.io/fda-regulations/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/fda-regulations/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1476+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Fda Regulations data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
