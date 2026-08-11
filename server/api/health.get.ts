import { version } from '../../package.json'

/** GET /api/health — uptime check (docs/api-reference.md). */
export default defineEventHandler(() => {
  return { ok: true, version }
})
