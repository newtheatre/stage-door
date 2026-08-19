/**
 * Daily backstop for manifest sync (ADR-0018). The ping is what delivers a
 * change; this catches an app whose ping quietly stopped working.
 */
export default defineTask({
  meta: {
    name: 'apps:sync-manifests',
    description: 'Re-read every registered app manifest',
  },
  async run() {
    const results = await syncAllApps()
    const failed = results.filter(r => !r.ok).map(r => r.app)

    return { result: { synced: results.length, failed } }
  },
})
