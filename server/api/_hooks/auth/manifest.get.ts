/** This service's own role vocabulary, on the same contract as every app. */
export default defineEventHandler(async (event) => {
  await requireServiceToken(event)
  return APP_MANIFEST
})
