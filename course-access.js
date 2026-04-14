function createCourseAccess({ pool, logger, ttlMs = 120000 }) {
  const accessCache = new Map();

  async function verifyCourseAccess(token, courseId) {
    const cacheKey = `${token}:${courseId}`;
    const cached = accessCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < ttlMs) return cached.ok;

    try {
      const result = await pool.query(
        `SELECT id FROM nb_course_access
         WHERE access_token = $1 AND course_id = $2 AND (expires_at IS NULL OR expires_at > NOW())`,
        [token, courseId]
      );
      const ok = result.rows.length > 0;
      accessCache.set(cacheKey, { ok, ts: Date.now() });
      return ok;
    } catch (err) {
      logger.error({ err }, 'verifyCourseAccess DB error');
      return false;
    }
  }

  function cleanupAccessCache(now = Date.now()) {
    for (const [key, entry] of accessCache) {
      if (now - entry.ts > ttlMs) accessCache.delete(key);
    }
  }

  return {
    verifyCourseAccess,
    cleanupAccessCache
  };
}

module.exports = { createCourseAccess };
