function createHealthRoutes({ app, pool, smtpMonitor, dbHealth }) {
  app.get('/api/health', async (req, res) => {
    try {
      await pool.query('SELECT 1');
      const dbStatus = dbHealth && dbHealth.degraded ? 'degraded' : 'ok';
      const overallStatus = (smtpMonitor.status === 'failed' || dbStatus === 'degraded') ? 'degraded' : 'ok';
      res.json({
        status: overallStatus,
        uptime: Math.floor(process.uptime()),
        checks: {
          database: dbStatus,
          smtp: smtpMonitor.status
        }
      });
    } catch {
      res.status(503).json({ status: 'unhealthy', error: 'database unreachable' });
    }
  });

  app.get('/api/ready', async (req, res) => {
    if (dbHealth && dbHealth.degraded) {
      return res.status(503).json({
        status: 'not_ready',
        checks: {
          database: 'degraded',
          smtp: smtpMonitor.status
        }
      });
    }
    try {
      await pool.query('SELECT 1');
      res.json({
        status: 'ready',
        uptime: Math.floor(process.uptime()),
        checks: {
          database: 'ok',
          smtp: smtpMonitor.status
        }
      });
    } catch {
      res.status(503).json({
        status: 'not_ready',
        checks: {
          database: 'failed',
          smtp: smtpMonitor.status
        }
      });
    }
  });
}

module.exports = { createHealthRoutes };
