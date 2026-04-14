function safeAlertDetails(details) {
  if (!details) return {};
  try {
    return JSON.parse(JSON.stringify(details));
  } catch {
    return { note: 'details_not_serializable' };
  }
}

function createOperationalAlerts({
  pool,
  logger,
  transporter,
  smtpUser,
  smtpPass,
  smtpFrom,
  alertEmailTo,
  notifyCooldownMs,
  sendWhatsApp,
  alertWhatsAppJid
}) {
  async function ensureOperationalAlertsTable() {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS nb_operational_alerts (
         id SERIAL PRIMARY KEY,
         alert_key VARCHAR(255) UNIQUE NOT NULL,
         source VARCHAR(100) NOT NULL,
         severity VARCHAR(20) NOT NULL DEFAULT 'warning' CHECK (severity IN ('info', 'warning', 'critical')),
         title VARCHAR(255) NOT NULL,
         message TEXT,
         details JSONB DEFAULT '{}'::jsonb,
         status VARCHAR(20) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved')),
         occurrence_count INTEGER NOT NULL DEFAULT 1,
         first_seen TIMESTAMP DEFAULT NOW(),
         last_seen TIMESTAMP DEFAULT NOW(),
         last_notified_at TIMESTAMP,
         created_at TIMESTAMP DEFAULT NOW(),
         updated_at TIMESTAMP DEFAULT NOW()
       )`
    );
    await pool.query('ALTER TABLE nb_operational_alerts ADD COLUMN IF NOT EXISTS last_notified_at TIMESTAMP');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_operational_alerts_status_seen ON nb_operational_alerts(status, last_seen DESC)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_operational_alerts_source_status ON nb_operational_alerts(source, status)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_operational_alerts_severity_status ON nb_operational_alerts(severity, status)');
  }

  async function markOperationalAlertNotified(alertId) {
    if (!alertId) return;
    try {
      await pool.query(
        `UPDATE nb_operational_alerts
         SET last_notified_at = NOW(), updated_at = NOW()
         WHERE id = $1`,
        [alertId]
      );
    } catch (err) {
      logger.error({ err, alertId }, 'markOperationalAlertNotified DB error');
    }
  }

  async function sendOperationalAlertEmail(alert) {
    if (!smtpUser || !smtpPass || !smtpFrom || !alertEmailTo) return false;
    try {
      const detailText = JSON.stringify(alert.details || {}, null, 2);
      const text = [
        `[Nami Alert] ${String(alert.severity || 'warning').toUpperCase()} - ${alert.title}`,
        alert.message || '',
        `Source: ${alert.source}`,
        `Status: ${alert.status}`,
        `Occurrences: ${alert.occurrence_count}`,
        `First seen: ${alert.first_seen}`,
        `Last seen: ${alert.last_seen}`,
        `Alert key: ${alert.alert_key}`,
        '',
        'Details:',
        detailText
      ].filter(Boolean).join('\n');

      await transporter.sendMail({
        from: smtpFrom,
        to: alertEmailTo,
        subject: `[Nami Alert] ${String(alert.severity || 'warning').toUpperCase()} - ${alert.title}`,
        text
      });
      return true;
    } catch (err) {
      logger.error({ err, alertKey: alert?.alert_key }, 'Operational alert email send failed');
      return false;
    }
  }

  async function notifyOperationalAlertExternal(alert) {
    if (!alert || alert.severity !== 'critical') return false;

    const detailText = JSON.stringify(alert.details || {}, null, 2);
    const waText = [
      `*Nami alert* ${String(alert.severity || 'warning').toUpperCase()}`,
      alert.title,
      alert.message || '',
      `Source: ${alert.source}`,
      `Occurrences: ${alert.occurrence_count}`,
      `Last seen: ${alert.last_seen}`,
      `Key: ${alert.alert_key}`
    ].filter(Boolean).join('\n');

    const results = await Promise.allSettled([
      sendWhatsApp(alertWhatsAppJid, `${waText}\nDetails: ${detailText.slice(0, 1200)}`),
      sendOperationalAlertEmail(alert)
    ]);

    return results.some((result) => result.status === 'fulfilled' && result.value !== false);
  }

  async function recordOperationalAlert({ alertKey, source, severity, title, message, details }) {
    if (!alertKey || !source || !title) return null;
    try {
      const result = await pool.query(
        `INSERT INTO nb_operational_alerts (
           alert_key, source, severity, title, message, details, status, occurrence_count, first_seen, last_seen
         )
          VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'open', 1, NOW(), NOW())
          ON CONFLICT (alert_key) DO UPDATE SET
            source = EXCLUDED.source,
            severity = EXCLUDED.severity,
            title = EXCLUDED.title,
            message = EXCLUDED.message,
            details = EXCLUDED.details,
            status = 'open',
            occurrence_count = nb_operational_alerts.occurrence_count + 1,
            last_seen = NOW(),
            updated_at = NOW()
          RETURNING id, alert_key, source, severity, title, message, details, status,
                    occurrence_count, first_seen, last_seen, last_notified_at`,
        [alertKey, source, severity || 'warning', title, message || null, JSON.stringify(safeAlertDetails(details))]
      );
      const alert = result.rows[0] || null;
      if (alert && alert.severity === 'critical') {
        const lastNotifiedAt = alert.last_notified_at ? new Date(alert.last_notified_at).getTime() : 0;
        const shouldNotify = !lastNotifiedAt || (Date.now() - lastNotifiedAt) >= notifyCooldownMs;
        if (shouldNotify) {
          Promise.resolve()
            .then(() => notifyOperationalAlertExternal(alert))
            .then((delivered) => delivered ? markOperationalAlertNotified(alert.id) : null)
            .catch((err) => logger.error({ err, alertKey }, 'Operational alert notification failed'));
        }
      }
      return alert;
    } catch (err) {
      logger.error({ err, alertKey }, 'recordOperationalAlert DB error');
      return null;
    }
  }

  async function resolveOperationalAlert(alertKey) {
    if (!alertKey) return;
    try {
      await pool.query(
        `UPDATE nb_operational_alerts
         SET status = 'resolved', updated_at = NOW()
         WHERE alert_key = $1 AND status <> 'resolved'`,
        [alertKey]
      );
    } catch (err) {
      logger.error({ err, alertKey }, 'resolveOperationalAlert DB error');
    }
  }

  return {
    ensureOperationalAlertsTable,
    recordOperationalAlert,
    resolveOperationalAlert
  };
}

module.exports = {
  createOperationalAlerts
};
