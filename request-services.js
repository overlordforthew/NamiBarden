function registerBaseMiddleware({ app, express }) {
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    req.cookies = {};
    const cookieHeader = req.headers.cookie;
    if (cookieHeader) {
      cookieHeader.split(';').forEach((pair) => {
        try {
          const [name, ...rest] = pair.trim().split('=');
          if (name) req.cookies[name.trim()] = decodeURIComponent(rest.join('=').trim());
        } catch {
          // Ignore malformed cookie values.
        }
      });
    }
    next();
  });

  app.use((req, res, next) => {
    if (req.originalUrl === '/api/stripe/webhook') {
      express.raw({ type: 'application/json' })(req, res, (err) => {
        if (err) return next(err);
        next();
      });
    } else {
      express.json({ limit: '5mb' })(req, res, (err) => {
        if (err) return next(err);
        next();
      });
    }
  });

  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
    if (err instanceof URIError) return res.status(400).json({ error: 'Bad request' });
    next(err);
  });
}

function createRequestServices({ multer }) {
  const rateLimits = new Map();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

  function rateLimit(key, maxAttempts, windowMs) {
    const now = Date.now();
    const entry = rateLimits.get(key) || { attempts: [], blocked: 0 };
    entry.attempts = entry.attempts.filter((attemptTime) => now - attemptTime < windowMs);
    if (entry.attempts.length >= maxAttempts) return false;
    entry.attempts.push(now);
    rateLimits.set(key, entry);
    return true;
  }

  function cleanupRateLimits(now = Date.now()) {
    for (const [key, entry] of rateLimits) {
      entry.attempts = entry.attempts.filter((attemptTime) => now - attemptTime < 3600000);
      if (entry.attempts.length === 0) rateLimits.delete(key);
    }
  }

  function getIP(req) {
    return req.headers['x-real-ip'] || req.ip;
  }

  return {
    rateLimit,
    cleanupRateLimits,
    getIP,
    uploadImportCsv: upload.single('file')
  };
}

module.exports = {
  registerBaseMiddleware,
  createRequestServices
};
