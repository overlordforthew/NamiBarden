function registerGlobalErrorHandling({ app, logger, recordOperationalAlert }) {
  app.use((err, req, res, _next) => {
    logger.error({ err, method: req.method, url: req.originalUrl }, 'Unhandled route error');
    recordOperationalAlert({
      alertKey: `route-error:${req.method}:${req.originalUrl}`,
      source: 'http',
      severity: 'warning',
      title: 'Unhandled route error',
      message: `${req.method} ${req.originalUrl}`,
      details: {
        method: req.method,
        url: req.originalUrl,
        error: err?.message || String(err)
      }
    }).catch((alertErr) => logger.error({ err: alertErr }, 'Operational alert write failed'));
    if (!res.headersSent) {
      res.status(500).json({ error: 'Server error' });
    }
  });

  process.on('uncaughtException', (err, origin) => {
    logger.fatal({ err, origin }, 'Uncaught exception — process will continue but may be unstable');
  });

  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'Unhandled promise rejection');
  });
}

async function initializeApp({
  pool,
  logger,
  ensureOperationalAlertsTable,
  adminPassword,
  bcrypt,
  transporter,
  smtpUser,
  smtpPass,
  smtpMonitor,
  resolveOperationalAlert,
  recordOperationalAlert
}) {
  try {
    await pool.query('SELECT 1');
    logger.info('Database connection verified');
  } catch (err) {
    logger.fatal({ err }, 'Cannot connect to database');
    throw err;
  }

  try {
    await ensureOperationalAlertsTable();
  } catch (err) {
    logger.error({ err }, 'Operational alerts table initialization failed');
  }

  try {
    const result = await pool.query('SELECT id FROM nb_admin LIMIT 1');
    if (result.rows.length === 0 && adminPassword) {
      const hash = await bcrypt.hash(adminPassword, 10);
      await pool.query('INSERT INTO nb_admin (password_hash) VALUES ($1)', [hash]);
      logger.info('Admin account initialized');
    }
  } catch (err) {
    if (err.message && (err.message.includes('does not exist') || err.message.includes('relation'))) {
      logger.fatal({ err }, 'Admin initialization failed — schema missing or relation does not exist');
      throw err;
    }
    logger.error({ err }, 'Admin initialization failed (non-fatal, may need schema)');
  }

  if (smtpUser && smtpPass) {
    try {
      await transporter.verify();
      smtpMonitor.status = 'ready';
      smtpMonitor.lastError = null;
      smtpMonitor.verifiedAt = new Date().toISOString();
      resolveOperationalAlert('smtp:verification-failed').catch((alertErr) => logger.error({ err: alertErr }, 'Operational alert resolve failed'));
      logger.info('SMTP connection verified');
    } catch (err) {
      smtpMonitor.status = 'failed';
      smtpMonitor.lastError = err?.message || String(err);
      recordOperationalAlert({
        alertKey: 'smtp:verification-failed',
        source: 'smtp',
        severity: 'warning',
        title: 'SMTP verification failed',
        message: 'SMTP verification failed during startup, so outbound email may not work.',
        details: {
          error: err?.message || String(err)
        }
      }).catch((alertErr) => logger.error({ err: alertErr }, 'Operational alert write failed'));
      logger.warn({ err }, 'SMTP verification failed — email sending may not work');
    }
  } else {
    smtpMonitor.status = 'not_configured';
  }
}

function startServer({ app, port, logger, pool }) {
  const server = app.listen(port, '127.0.0.1', () => {
    logger.info({ port }, 'NamiBarden API running');
  });

  function shutdown(signal) {
    logger.info({ signal }, 'Shutdown signal received — draining connections');
    server.close(() => {
      pool.end().then(() => {
        logger.info('Database pool closed');
        process.exit(0);
      }).catch((err) => {
        logger.error({ err }, 'Error closing database pool');
        process.exit(1);
      });
    });

    setTimeout(() => {
      logger.error('Graceful shutdown timed out — forcing exit');
      process.exit(1);
    }, 15000).unref();
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  return server;
}

module.exports = {
  registerGlobalErrorHandling,
  initializeApp,
  startServer
};
