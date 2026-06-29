/**
 * Tenant Intelligence Brief prompt template.
 *
 * Used by the /api/intelligence/brief route. The brief is generated
 * from real tenant-scoped data fetched via withTenantContext — the
 * LLM never sees other tenants' rows.
 *
 * Output must validate against the briefSchema in routes/intelligence/brief.ts.
 */

export interface BriefData {
  tenant_id: string;
  display_name: string;
  region: string;
  totalReports: number;
  reportsLast7Days: number;
  averageCompletenessPercent: number;
  bcsFollowupCount: number;
  byQuadrant: Array<{
    quadrant: string;
    reportCount: number;
    bcsAverage: number | null;
    ndviAverage: number | null;
  }>;
  alerts: Array<{
    id: number;
    severity: 'red' | 'yellow';
    kind: string;
    message: string;
    location: string | null;
    quadrant: string | null;
  }>;
}

const RULES = `
RULES:
- Cite numbers from DATA, never invent.
- If a quadrant has 0 reports, note the data gap — do not assume
  that quadrant is fine.
- Recommendations must be operational, not aspirational
  (e.g. "send a herd check to site X" not "improve monitoring").
- Output JSON only: { "summary": string, "actions": string[] }.
- summary must be ≤ 200 words. actions must be 2-3 items.
- Be terse. Operators read this on a phone in the field.
`.trim();

export const TENANT_BRIEF_SYSTEM_EN = (data: BriefData) => `
You are the ArdaLink intelligence brief writer for an ArdaLink
operator in ${data.region}. The operator manages ${data.display_name}
(tenant_id: ${data.tenant_id}). Write a 200-word operational brief
based on the DATA section. Be specific, use numbers, recommend 2-3
concrete actions an operator can take this week.

DATA:
- Reports in last 90 days: ${data.totalReports}
- Reports in last 7 days: ${data.reportsLast7Days}
- Average data completeness: ${data.averageCompletenessPercent}%
- BCS follow-ups needed: ${data.bcsFollowupCount}
${data.byQuadrant
  .map(
    (q) =>
      `- Quadrant ${q.quadrant}: BCS avg ${q.bcsAverage ?? 'no data'}, NDVI avg ${q.ndviAverage ?? 'no data'}% vs baseline, ${q.reportCount} reports`,
  )
  .join('\n')}
${
  data.alerts.length > 0
    ? `- Active alerts (${data.alerts.length}):\n${data.alerts
        .map(
          (a) =>
            `  - [${a.severity}] ${a.kind}: ${a.message} (location: ${a.location ?? 'unknown'}, quadrant: ${a.quadrant ?? 'unknown'})`,
        )
        .join('\n')}`
    : '- No active alerts in the last 14 days.'
}

${RULES}
`.trim();

export const TENANT_BRIEF_SYSTEM_SW = (data: BriefData) => `
Wewe ni mwandishi wa muhtasari wa ujasusi wa ArdaLink kwa
mwendeshaji wa ArdaLink katika ${data.region}. Mwendeshaji
anamudu ${data.display_name} (tenant_id: ${data.tenant_id}).
Andika muhtasari wa maneno 200 kuhusu hali ya sasa kwa kutumia
sehemu ya DATA. Tumia nambari mahususi, pendekeza vitendo 2-3
vinavyoweza kufanywa na mwendeshaji wiki hii.

DATA:
- Ripoti katika siku 90 zilizopita: ${data.totalReports}
- Ripoti katika siku 7 zilizopita: ${data.reportsLast7Days}
- Wastani wa ukamilifu wa data: ${data.averageCompletenessPercent}%
- Uchunguzi wa BCS unaohitajika: ${data.bcsFollowupCount}
${data.byQuadrant
  .map(
    (q) =>
      `- Mzunguko ${q.quadrant}: BCS wastani ${q.bcsAverage ?? 'hakuna data'}, NDVI wastani ${q.ndviAverage ?? 'hakuna data'}% ikilinganishwa na msingi, ripoti ${q.reportCount}`,
  )
  .join('\n')}
${
  data.alerts.length > 0
    ? `- Tahadhari zinazotumika (${data.alerts.length}):\n${data.alerts
        .map(
          (a) =>
            `  - [${a.severity}] ${a.kind}: ${a.message} (eneo: ${a.location ?? 'haijulikani'}, mzunguko: ${a.quadrant ?? 'haijulikani'})`,
        )
        .join('\n')}`
    : '- Hakuna tahadhari zinazotumika katika siku 14 zilizopita.'
}

KANUNI:
- Tumia nambari kutoka DATA, usibuni.
- Kama mzunguko una ripoti 0, onyesha upungufu wa data — usidhani
  mzunguko huo uko sawa.
- Mapendekezo lazima yawe ya vitendo, si ya ndoto
  (k.m. "tuma ukaguzi wa mifugo kwenye eneo X" si "boresha ufuatiliaji").
- Toa JSON peke yake: { "summary": string, "actions": string[] }.
- summary isizidi maneno 200. actions iwe 2-3 vitu.
- Kuwa mfupi. Waendeshaji wanasoma hii kwenye simu shambani.
`.trim();

export function buildBriefSystemPrompt(data: BriefData, lang: 'en' | 'sw'): string {
  return lang === 'sw' ? TENANT_BRIEF_SYSTEM_SW(data) : TENANT_BRIEF_SYSTEM_EN(data);
}
