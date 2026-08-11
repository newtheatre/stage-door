export default defineTask({
  meta: {
    name: 'rate-limits:sweep',
    description: 'Delete rate-limit counters whose window lapsed over a day ago',
  },
  async run() {
    const removed = await sweepRateLimits()
    console.info(`[rate-limits:sweep] removed ${removed} stale counters`)
    return { result: { removed } }
  },
})
