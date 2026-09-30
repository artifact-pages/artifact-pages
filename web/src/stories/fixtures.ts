import sreIndex from '../../../fixtures/storage/_indexes/sre/index.json'
import frontendIndex from '../../../fixtures/storage/_indexes/frontend/index.json'
import type { ArtifactIndexEntry, SiteIndex } from '../domain/index'

const baseIndex = sreIndex as SiteIndex
const template = baseIndex.artifacts[0]

function artifact(path: string, title: string, updatedAt: string): ArtifactIndexEntry {
  const sourcePath = `${path}/index.html`
  return {
    ...template,
    id: sourcePath,
    path: sourcePath,
    title,
    format: 'html',
    artifactUrl: `/_artifacts/sre/${sourcePath}`,
    updatedAt,
    source: template.source ? { ...template.source, filePath: sourcePath } : undefined,
  }
}

const deepArtifacts = [
  artifact('incidents/2026/q3/checkout/latency-review', 'Checkout latency review', '2026-09-22T08:10:00Z'),
  artifact('incidents/2026/q3/checkout/payment-retries', 'Payment retry saturation', '2026-09-22T07:20:00Z'),
  artifact('incidents/2026/q3/billing/gateway-timeouts', 'Gateway timeout review', '2026-09-21T17:30:00Z'),
  artifact('incidents/2025/q4/fulfillment/queue-backlog', 'Fulfillment queue backlog', '2026-09-20T13:15:00Z'),
  artifact('architecture/platform/networking/edge-cache', 'Edge cache topology', '2026-09-19T10:00:00Z'),
  artifact('architecture/platform/identity/session-boundaries', 'Session boundaries', '2026-09-18T09:45:00Z'),
  artifact('runbooks/payments/europe/failover', 'European payment failover', '2026-09-17T11:00:00Z'),
]

export const deepSreIndex: SiteIndex = {
  ...baseIndex,
  artifacts: [...baseIndex.artifacts, ...deepArtifacts],
}

export const storyIndexes = [deepSreIndex, frontendIndex as SiteIndex]

export const deepExpandedPaths = [
  'incidents',
  'incidents/2026',
  'incidents/2026/q3',
  'incidents/2026/q3/checkout',
  'architecture',
  'architecture/platform',
  'architecture/platform/networking',
  'runbooks',
  'runbooks/payments',
  'runbooks/payments/europe',
]
