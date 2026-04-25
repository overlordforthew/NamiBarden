function createAuthUtils({ jwt, jwtSecret, isProd, secureCookies }) {
  // Back-compat: callers passing isProd still get the old behavior.
  // Callers passing secureCookies (e.g., staging) override it.
  const useSecure = typeof secureCookies === 'boolean' ? secureCookies : !!isProd;

  function setAuthCookie(res, name, token, maxAgeMs, options = {}) {
    const sameSite = options.sameSite || 'Lax';
    const opts = [`${name}=${token}`, 'HttpOnly', 'Path=/', `SameSite=${sameSite}`, `Max-Age=${Math.floor(maxAgeMs / 1000)}`];
    if (useSecure) opts.push('Secure');
    res.append('Set-Cookie', opts.join('; '));
  }

  function clearAuthCookie(res, name) {
    const opts = [`${name}=`, 'HttpOnly', 'Path=/', 'SameSite=Lax', 'Max-Age=0'];
    if (useSecure) opts.push('Secure');
    res.append('Set-Cookie', opts.join('; '));
  }

  function authMiddleware(req, res, next) {
    const token = req.cookies?.nb_admin_token || (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null);
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try {
      const decoded = jwt.verify(token, jwtSecret);
      if (decoded.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
      if (decoded.scope) return res.status(403).json({ error: 'Forbidden' });
      req.admin = decoded;
      next();
    } catch {
      res.status(401).json({ error: 'Invalid token' });
    }
  }

  return {
    setAuthCookie,
    clearAuthCookie,
    authMiddleware
  };
}

module.exports = { createAuthUtils };
