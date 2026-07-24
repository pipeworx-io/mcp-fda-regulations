interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * FDA Regulations MCP — US Food & Drug Administration regulations (21 CFR).
 *
 * FDA regulations ARE US federal regulations codified in Title 21 of the CFR
 * (Food and Drugs). Agents search "FDA regulation on X", "21 CFR 211", "what
 * does 21 CFR 820 require" — never "eCFR title 21". This is a thin, FDA-branded,
 * keyless wrapper over the official eCFR API (www.ecfr.gov/api), scoped to the
 * whole of Title 21: part 211 current good manufacturing practice (cGMP) for
 * drugs, part 820 / QMSR quality system for medical devices, part 101 food
 * labeling, part 801 device labeling, part 314 new drug applications, etc.
 *
 * DISTINCT from the openfda pack: openfda returns FDA DATA (drug labels,
 * adverse-event reports, recalls, NDC directory). THIS pack returns FDA
 * REGULATIONS — the binding rules/regulatory text in 21 CFR.
 *
 * Tools:
 * - fda_regulation: full text of one FDA regulation by citation
 * - fda_search:     keyword search across FDA regulations (21 CFR)
 *
 * Self-contained: does NOT import the eCFR pack — calls the eCFR API directly.
 */


const BASE = 'https://www.ecfr.gov/api';
const UA = 'pipeworx/1.0 (+https://pipeworx.io)';
const TITLE = 21;
const CITE = '21 CFR';

// --- XML/entity helpers ------------------------------------------------------
function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function stripHtml(s: unknown): string {
  if (typeof s !== 'string') return '';
  return decodeEntities(s.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

function xmlToText(xml: string): string {
  return decodeEntities(
    xml
      .replace(/<\?xml[^>]*\?>/g, '')
      .replace(/<HEAD>[\s\S]*?<\/HEAD>/g, '')
      .replace(/<\/(P|FP|HEAD|DIV\d+)>/g, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

// --- eCFR fetch with per-attempt timeout + 503 retry -------------------------
async function ecfrOnce(path: string, accept: string, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(`${BASE}${path}`, {
      headers: { Accept: accept, 'User-Agent': UA },
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function ecfrFetch(path: string, accept: string, retries = 3): Promise<Response> {
  let res: Response | null = null;
  for (let i = 0; i < retries; i++) {
    try {
      res = await ecfrOnce(path, accept, 12000);
      if (res.status !== 503) return res;
    } catch {
      res = null; // aborted (timeout) or network error — retry
    }
    if (i < retries - 1) await new Promise((r) => setTimeout(r, 600 * (i + 1)));
  }
  if (res) return res;
  throw new Error('eCFR temporarily unavailable (the eCFR text endpoint is timing out — retry in a few seconds).');
}

async function ecfrGet(path: string): Promise<Record<string, unknown>> {
  const res = await ecfrFetch(path, 'application/json');
  if (!res.ok) throw new Error(`eCFR: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as Record<string, unknown>;
}

// Current currency date for this title, with a 7-day-ago fallback.
async function currentDate(): Promise<string> {
  try {
    const data = await ecfrGet('/versioner/v1/titles.json');
    const titles = Array.isArray(data.titles) ? (data.titles as Array<Record<string, unknown>>) : [];
    const t = titles.find((x) => Number(x.number) === TITLE);
    if (t && typeof t.up_to_date_as_of === 'string' && t.up_to_date_as_of) return t.up_to_date_as_of;
  } catch {
    /* fall through to date fallback */
  }
  return new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
}

// --- citation parsing --------------------------------------------------------
// Forgiving: "211.100", "21 CFR 211.100", "§211.100", "211.100(a)", "part 820",
// "820". Returns the section (part.section) or a bare part.
function parseCitation(raw: string): { section: string | null; part: string | null } {
  let s = raw.trim();
  s = s.replace(/§+/g, ' ');
  s = s.replace(/\b(21\s*cfr|cfr|part|sections?|sec\.?)\b/gi, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  const secMatch = s.match(/(\d{1,4})\.(\d+[A-Za-z]*)/);
  if (secMatch) return { section: `${secMatch[1]}.${secMatch[2]}`, part: secMatch[1] };
  const partMatch = s.match(/\b(\d{1,4})\b/);
  if (partMatch) return { section: null, part: partMatch[1] };
  return { section: null, part: null };
}

// Best-effort subpart lookup for a section, via the eCFR search hierarchy.
async function lookupSubpart(section: string): Promise<string | null> {
  try {
    const params = new URLSearchParams({ query: section, per_page: '5', order: 'relevance' });
    params.append('hierarchy[title]', String(TITLE));
    const data = await ecfrGet(`/search/v1/results?${params.toString()}`);
    const results = Array.isArray(data.results) ? (data.results as Array<Record<string, unknown>>) : [];
    for (const r of results) {
      const h = (r.hierarchy as Record<string, unknown> | undefined) ?? {};
      if (h.section != null && String(h.section) === section && h.subpart != null) {
        return String(h.subpart);
      }
    }
  } catch {
    /* ignore — subpart is optional metadata */
  }
  return null;
}

// --- tools -------------------------------------------------------------------
const tools: McpToolExport['tools'] = [
  {
    name: 'fda_regulation',
    description:
      'Get the full text of one FDA regulation — a US Food & Drug Administration rule codified in 21 CFR — by its citation. Returns the exact regulatory wording currently in force. Answers "what does 21 CFR 211 require", "what is the FDA regulation for X", "does the FDA require X", "read 21 CFR 211.100", "the FDA good manufacturing practice rule". Forgiving citation input: "211.100", "21 CFR 211.100", "§211.100", even "211.100(a)" (paragraph stripped to the section). Covers 21 CFR part 211 current good manufacturing practice (cGMP / GMP) for finished drugs, part 210 cGMP general, part 820 quality system regulation / QMSR for medical devices, part 801 medical device labeling, part 101 food labeling / nutrition facts, part 314 new drug applications (NDA/ANDA), part 807 device establishment registration, part 111 dietary supplement cGMP, part 1308 controlled substance schedules — the whole of Title 21 (food, drugs, devices, cosmetics, biologics). This is FDA REGULATIONS (the rules/regulatory text); for FDA DATA (drug labels, adverse events, recalls) use the openfda tools. Pass a whole part (e.g. "211" or "820") to get that part\'s section list. Example: fda_regulation({ citation: "211.100" }) -> written procedures / process control; fda_regulation({ citation: "21 CFR 101.9" }) -> nutrition labeling. Keyless.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        citation: {
          type: 'string',
          description:
            'FDA regulation citation. A section: "211.100", "21 CFR 211.100", "§820.35", "211.100(a)". Or a whole part: "211", "part 820" -> returns the part\'s section list.',
        },
      },
      required: ['citation'],
    },
  },
  {
    name: 'fda_search',
    description:
      'Keyword search across FDA regulations — US Food & Drug Administration rules in 21 CFR. Answers "what FDA regulations cover X", "the FDA regulation / rule about X", "find the FDA requirement for X". Great for topics: good manufacturing practice (GMP / cGMP), quality system regulation, medical device labeling, drug labeling, nutrition facts / food labeling, new drug applications, dietary supplements, cosmetics, biologics, controlled substances, current good manufacturing practice for drugs and devices. Returns matching FDA regulations with citation (21 CFR), heading, excerpt, and source URL. This searches FDA REGULATIONS (regulatory text); for FDA DATA (drug labels, adverse events, recalls) use the openfda tools. Example: fda_search({ query: "medical device labeling" }); fda_search({ query: "good manufacturing practice", limit: 15 }). Keyless.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description:
            'FDA-regulation topic or phrase, e.g. "medical device labeling", "good manufacturing practice", "nutrition labeling", "quality system", "new drug application".',
        },
        limit: { type: 'number', description: 'Max results to return, 1-20 (default 10).' },
      },
      required: ['query'],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    switch (name) {
      case 'fda_regulation':
        return getRegulation(args);
      case 'fda_search':
        return searchRegulations(args);
      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

async function getRegulation(args: Record<string, unknown>): Promise<unknown> {
  const raw = typeof args.citation === 'string' ? args.citation : '';
  if (!raw.trim()) return { error: 'provide a citation, e.g. "211.100" or "21 CFR 820.35"' };

  const { section, part } = parseCitation(raw);
  if (!part) {
    return {
      error: `Could not parse an FDA citation from "${raw}". Use a section like "211.100" or "21 CFR 820.35", or a part like "211".`,
    };
  }

  const date = await currentDate();

  // ---- whole part requested: return its section list -----------------------
  if (!section) {
    const res = await ecfrFetch(
      `/versioner/v1/full/${date}/title-${TITLE}.xml?part=${encodeURIComponent(part)}`,
      'application/xml',
    );
    if (res.status === 404) return { error: `${CITE} part ${part} not found as of ${date}.`, part, date };
    if (res.status === 503) return { error: 'eCFR temporarily unavailable — retry in a few seconds.', part };
    if (!res.ok) throw new Error(`eCFR: ${res.status} ${(await res.text()).slice(0, 200)}`);
    const xml = await res.text();
    const blocks = xml.split(/<DIV8\b/).slice(1);
    const sections = blocks
      .map((b) => {
        const n = b.match(/\bN="([^"]+)"/)?.[1] ?? null;
        const head = b.match(/<HEAD>([\s\S]*?)<\/HEAD>/);
        return { section: n, heading: head ? stripHtml(head[1]) : null };
      })
      .filter((s) => s.section);
    return {
      part,
      citation: `${CITE} Part ${part}`,
      date,
      source: 'eCFR / FDA 21 CFR',
      source_url: `https://www.ecfr.gov/current/title-${TITLE}/part-${part}`,
      section_count: sections.length,
      note: `This is a whole FDA part (${sections.length} sections). Call fda_regulation with a specific citation (e.g. "${sections[0]?.section ?? part + '.1'}") to get full text.`,
      sections,
    };
  }

  // ---- single section ------------------------------------------------------
  const res = await ecfrFetch(
    `/versioner/v1/full/${date}/title-${TITLE}.xml?part=${encodeURIComponent(part)}&section=${encodeURIComponent(section)}`,
    'application/xml',
  );
  if (res.status === 404 || res.status === 400) {
    return {
      error: `FDA regulation ${CITE} ${section} not found as of ${date}. Check the citation, or use fda_search to find it.`,
      citation: `${CITE} ${section}`,
      part,
      date,
    };
  }
  if (res.status === 503) return { error: 'eCFR temporarily unavailable — retry in a few seconds.', citation: `${CITE} ${section}` };
  if (!res.ok) throw new Error(`eCFR: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const body = await res.text();
  // eCFR returns JSON {"error":"No matching content found."} for removed/absent sections
  if (body.trim().startsWith('{')) {
    return {
      error: `FDA regulation ${CITE} ${section} not found as of ${date} (the section may have been removed or renumbered — e.g. 21 CFR part 820 was restructured under the QMSR). Use fda_search to find the current rule.`,
      citation: `${CITE} ${section}`,
      part,
      date,
    };
  }
  const xml = body;

  const headMatch = xml.match(/<HEAD>([\s\S]*?)<\/HEAD>/);
  const heading = headMatch ? stripHtml(headMatch[1]) : null;
  const full = xmlToText(xml);
  const CAP = 30000;
  const truncated = full.length > CAP;
  const subpart = await lookupSubpart(section);

  return {
    citation: `${CITE} ${section}`,
    part,
    subpart: subpart ?? null,
    heading,
    text: truncated ? full.slice(0, CAP) : full,
    truncated,
    date,
    source: 'eCFR / FDA 21 CFR',
    source_url: `https://www.ecfr.gov/current/title-${TITLE}/section-${section}`,
  };
}

async function searchRegulations(args: Record<string, unknown>): Promise<unknown> {
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (!query) return { error: 'provide a query, e.g. "medical device labeling" or "good manufacturing practice"' };

  const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 20);
  const params = new URLSearchParams({
    query,
    per_page: String(Math.min(limit, 20)),
    page: '1',
    order: 'relevance',
  });
  params.append('hierarchy[title]', String(TITLE));

  const data = await ecfrGet(`/search/v1/results?${params.toString()}`);
  const meta = (data.meta as Record<string, unknown> | undefined) ?? {};
  const rawResults = Array.isArray(data.results) ? (data.results as Array<Record<string, unknown>>) : [];

  const results = rawResults
    .map((r) => {
      const h = (r.hierarchy as Record<string, unknown> | undefined) ?? {};
      const headings = (r.headings as Record<string, unknown> | undefined) ?? {};
      const hHeadings = (r.hierarchy_headings as Record<string, unknown> | undefined) ?? {};
      const part = h.part != null ? String(h.part) : null;
      const section = h.section != null ? String(h.section) : null;
      const subpart = h.subpart != null ? String(h.subpart) : null;
      const heading =
        (typeof headings.section === 'string' && stripHtml(headings.section)) ||
        (typeof hHeadings.section === 'string' && stripHtml(hHeadings.section)) ||
        null;
      let citation: string | null = null;
      let source_url: string | null = null;
      if (section) {
        citation = `${CITE} ${section}`;
        source_url = `https://www.ecfr.gov/current/title-${TITLE}/section-${section}`;
      } else if (part) {
        citation = `${CITE} Part ${part}`;
        source_url = `https://www.ecfr.gov/current/title-${TITLE}/part-${part}`;
      }
      return {
        part,
        subpart,
        section,
        citation,
        heading,
        excerpt: stripHtml(r.full_text_excerpt ?? (r as Record<string, unknown>).excerpt).slice(0, 300),
        source_url,
      };
    })
    .filter((r) => r.section || r.part)
    .slice(0, limit);

  return {
    query,
    total_matches: meta.total_count ?? null,
    count: results.length,
    scope: 'FDA regulations — 21 CFR (food, drugs, devices, cosmetics)',
    source: 'eCFR / FDA 21 CFR',
    results,
  };
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
