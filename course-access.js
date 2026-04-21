function createCourseAccess({ pool, logger, jwt, jwtSecret, ttlMs = 120000 }) {
  const accessCache = new Map();

  function decodeAdminImpersonationToken(token) {
    if (!jwt || !jwtSecret) return null;
    try {
      const decoded = jwt.verify(token, jwtSecret, {
        issuer: 'namibarden-admin',
        audience: 'course-watch-impersonation'
      });
      if (!['admin-impersonate', 'admin-impersonate-access'].includes(decoded.kind)) return null;
      if (!decoded.courseId) return null;
      if (decoded.kind === 'admin-impersonate' && !decoded.customerId) return null;
      if (decoded.kind === 'admin-impersonate-access' && !decoded.accessToken) return null;
      return decoded;
    } catch {
      return null;
    }
  }

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
      if (ok) {
        accessCache.set(cacheKey, { ok: true, ts: Date.now() });
        return true;
      }

      const impersonation = decodeAdminImpersonationToken(token);
      if (!impersonation || impersonation.courseId !== courseId) {
        accessCache.set(cacheKey, { ok: false, ts: Date.now() });
        return false;
      }

      const adminResult = impersonation.kind === 'admin-impersonate-access'
        ? await pool.query(
          `SELECT id FROM nb_course_access
           WHERE access_token = $1 AND course_id = $2 AND (expires_at IS NULL OR expires_at > NOW())`,
          [impersonation.accessToken, courseId]
        )
        : await pool.query(
          `SELECT id FROM nb_course_access
           WHERE customer_id = $1 AND course_id = $2 AND (expires_at IS NULL OR expires_at > NOW())`,
          [impersonation.customerId, courseId]
        );
      return adminResult.rows.length > 0;
    } catch (err) {
      logger.error({ err }, 'verifyCourseAccess DB error');
      return false;
    }
  }

  async function getCourseAccessRowsForToken(token) {
    try {
      const result = await pool.query(
        `SELECT access_token, course_id, email, customer_id
         FROM nb_course_access
         WHERE access_token = $1 AND (expires_at IS NULL OR expires_at > NOW())
         ORDER BY purchased_at ASC`,
        [token]
      );
      if (result.rows.length > 0) return result.rows;

      const impersonation = decodeAdminImpersonationToken(token);
      if (!impersonation) return [];

      const adminResult = impersonation.kind === 'admin-impersonate-access'
        ? await pool.query(
          `SELECT access_token, course_id, email, customer_id
           FROM nb_course_access
           WHERE access_token = $1 AND course_id = $2 AND (expires_at IS NULL OR expires_at > NOW())
           ORDER BY purchased_at ASC`,
          [impersonation.accessToken, impersonation.courseId]
        )
        : await pool.query(
          `SELECT access_token, course_id, email, customer_id
           FROM nb_course_access
           WHERE customer_id = $1 AND course_id = $2 AND (expires_at IS NULL OR expires_at > NOW())
           ORDER BY purchased_at ASC`,
          [impersonation.customerId, impersonation.courseId]
        );
      return adminResult.rows;
    } catch (err) {
      logger.error({ err }, 'getCourseAccessRowsForToken DB error');
      return [];
    }
  }

  function cleanupAccessCache(now = Date.now()) {
    for (const [key, entry] of accessCache) {
      if (now - entry.ts > ttlMs) accessCache.delete(key);
    }
  }

  return {
    verifyCourseAccess,
    getCourseAccessRowsForToken,
    cleanupAccessCache
  };
}

module.exports = { createCourseAccess };
