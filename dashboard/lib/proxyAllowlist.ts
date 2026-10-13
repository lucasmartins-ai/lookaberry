/** Upstream API routes the dashboard proxy may forward (decoded path, as the API router sees it). */
const ALLOWED_PATH = /^\/api\/v1\/(campaigns(\/[^/]+)*|health\/(cadence|sync))$/;

export function isAllowedPath(decodedPath: string): boolean {
  return ALLOWED_PATH.test(decodedPath) && !decodedPath.split('/').some((seg) => seg === '..' || seg === '.');
}
