/**
 * Daily eligibility snapshot (ADR-0019). Certification expiry is calendar
 * driven, so a day's granularity catches every lapse.
 */
export default defineTask({
  meta: {
    name: 'eligibility:snapshot',
    description: 'Re-read rehearsal\'s eligibility answers',
  },
  async run() {
    const results = await snapshotAllRules()
    return { result: { rules: results.length, failed: results.filter(r => !r.ok).map(r => r.ruleKey) } }
  },
})
