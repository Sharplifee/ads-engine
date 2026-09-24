// Rolling query generator. The engine writes its own search phrases from the coverage
// map plus the current month, and rotates them so coverage spreads over time instead
// of asking the same questions forever.
import { readFileSync } from 'node:fs';
import YAML from 'yaml';
const cov = YAML.parse(readFileSync(new URL('../learn/coverage.yaml', import.meta.url), 'utf8'));

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

export function currentQueries({ rotation = cov.cadence?.rotation || 12, seed = new Date() } = {}) {
  const month = MONTHS[seed.getMonth()], year = String(seed.getFullYear());
  const segments = Object.keys(cov.segments || {});
  const verticals = cov.verticals || [];
  const formats = (cov.formats || []).map(f => f.replace(/_/g, ' '));
  const out = [];
  for (const t of cov.query_templates || [])
    for (const segment of segments)
      for (const vertical of verticals)
        out.push({
          segment, vertical,
          q: t.replace('{segment}', segment.replace(/_/g, ' '))
               .replace('{vertical}', vertical.replace(/_/g, ' '))
               .replace('{format}', formats[out.length % formats.length])
               .replace('{month}', month).replace('{year}', year)
        });
  // Day-of-year rotation: a different slice every day, whole map covered over time.
  const day = Math.floor((seed - new Date(seed.getFullYear(), 0, 0)) / 864e5);
  const start = (day * rotation) % out.length;
  return [...out.slice(start), ...out.slice(0, start)].slice(0, rotation);
}

export const segments = () => Object.keys(cov.segments || {});
export const segmentTerms = s => cov.segments?.[s] || [];
export const verticals = () => cov.verticals || [];
export const operators = () => cov.operators || [];
export const formats = () => cov.formats || [];
