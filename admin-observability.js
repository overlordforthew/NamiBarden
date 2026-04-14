function createAdminObservability({ app, pool, logger, authMiddleware }) {
  function mapAlertRow(row) {
    return {
      id: row.id,
      alertKey: row.alert_key,
      source: row.source,
      severity: row.severity,
      title: row.title,
      message: row.message,
      details: row.details || {},
      status: row.status,
      occurrenceCount: row.occurrence_count,
      firstSeen: row.first_seen,
      lastSeen: row.last_seen,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  app.get('/api/admin/alerts', authMiddleware, async (req, res) => {
    try {
      const status = ['open', 'acknowledged', 'resolved'].includes(req.query.status) ? req.query.status : '';
      const severity = ['info', 'warning', 'critical'].includes(req.query.severity) ? req.query.severity : '';
      const source = typeof req.query.source === 'string' ? req.query.source.trim().slice(0, 100) : '';
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);

      const [alertsQ, summaryQ] = await Promise.all([
        pool.query(
          `SELECT id, alert_key, source, severity, title, message, details, status,
                  occurrence_count, first_seen, last_seen, created_at, updated_at
           FROM nb_operational_alerts
           WHERE ($1 = '' OR status = $1)
             AND ($2 = '' OR severity = $2)
             AND ($3 = '' OR source = $3)
           ORDER BY
             CASE status
               WHEN 'open' THEN 0
               WHEN 'acknowledged' THEN 1
               ELSE 2
             END,
             CASE severity
               WHEN 'critical' THEN 0
               WHEN 'warning' THEN 1
               ELSE 2
             END,
             last_seen DESC
           LIMIT $4`,
          [status, severity, source, limit]
        ),
        pool.query(`SELECT
          COUNT(*) FILTER (WHERE status = 'open') AS open,
          COUNT(*) FILTER (WHERE status = 'acknowledged') AS acknowledged,
          COUNT(*) FILTER (WHERE status = 'resolved') AS resolved,
          COUNT(*) FILTER (WHERE status = 'open' AND severity = 'critical') AS critical_open
          FROM nb_operational_alerts`)
      ]);

      res.json({
        summary: summaryQ.rows[0],
        alerts: alertsQ.rows.map(mapAlertRow)
      });
    } catch (e) {
      logger.error({ err: e }, 'Admin alerts list error');
      res.status(500).json({ error: 'Server error' });
    }
  });

  app.post('/api/admin/alerts/:id/status', authMiddleware, async (req, res) => {
    try {
      const alertId = parseInt(req.params.id, 10);
      const nextStatus = req.body?.status;
      if (!Number.isInteger(alertId) || alertId <= 0) {
        return res.status(400).json({ error: 'Invalid alert id' });
      }
      if (!['open', 'acknowledged', 'resolved'].includes(nextStatus)) {
        return res.status(400).json({ error: 'Invalid status' });
      }

      const updated = await pool.query(
        `UPDATE nb_operational_alerts
         SET status = $2, updated_at = NOW()
         WHERE id = $1
         RETURNING id, alert_key, source, severity, title, message, details, status,
                   occurrence_count, first_seen, last_seen, created_at, updated_at`,
        [alertId, nextStatus]
      );

      if (updated.rows.length === 0) {
        return res.status(404).json({ error: 'Alert not found' });
      }

      res.json({
        ok: true,
        alert: mapAlertRow(updated.rows[0])
      });
    } catch (e) {
      logger.error({ err: e }, 'Admin alert status update error');
      res.status(500).json({ error: 'Server error' });
    }
  });

  app.get('/api/admin/lumina/analytics', authMiddleware, async (req, res) => {
    try {
      const windowDays = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 7), 365);
      const recentLimit = Math.min(Math.max(parseInt(req.query.recent, 10) || 20, 5), 100);
      const toInt = (value) => parseInt(value || 0, 10);
      const toNum = (value) => Number(value || 0);
      const actorExpr = `COALESCE(
        NULLIF(email, ''),
        CASE WHEN user_id IS NOT NULL THEN CONCAT('u:', user_id::text) END,
        CONCAT('s:', session_id)
      )`;

      const [
        subscriptionSummaryQ,
        planMixQ,
        eventSummaryQ,
        dailyActivityQ,
        engagementQ,
        activityWindowQ,
        stateMixQ,
        recentEventsQ
      ] = await Promise.all([
        pool.query(
          `SELECT
             COUNT(*) AS total_entitlements,
             COUNT(*) FILTER (
               WHERE (
                 status IN ('active', 'trialing', 'past_due')
                 AND GREATEST(
                   COALESCE(current_period_end, TIMESTAMP 'epoch'),
                   COALESCE(trial_end, TIMESTAMP 'epoch')
                 ) > NOW()
               ) OR (
                 status = 'canceled'
                 AND COALESCE(current_period_end, TIMESTAMP 'epoch') > NOW()
               )
             ) AS active_access,
             COUNT(*) FILTER (
               WHERE status = 'trialing'
               AND COALESCE(trial_end, current_period_end, TIMESTAMP 'epoch') > NOW()
             ) AS trialing,
             COUNT(*) FILTER (
               WHERE status = 'past_due'
               AND COALESCE(current_period_end, trial_end, TIMESTAMP 'epoch') > NOW()
             ) AS grace,
             COUNT(*) FILTER (
               WHERE status = 'canceled'
               AND COALESCE(current_period_end, TIMESTAMP 'epoch') > NOW()
             ) AS cancel_scheduled,
             COUNT(*) FILTER (
               WHERE status = 'canceled'
               AND COALESCE(current_period_end, TIMESTAMP 'epoch') <= NOW()
             ) AS expired
           FROM nb_app_entitlements
           WHERE app_slug = 'lumina'`
        ),
        pool.query(
          `SELECT
             COALESCE(plan_code, 'unknown') AS plan_code,
             COUNT(*) AS total,
             COUNT(*) FILTER (
               WHERE (
                 status IN ('active', 'past_due')
                 AND COALESCE(current_period_end, trial_end, TIMESTAMP 'epoch') > NOW()
               ) OR (
                 status = 'canceled'
                 AND COALESCE(current_period_end, TIMESTAMP 'epoch') > NOW()
               )
             ) AS active_access,
             COUNT(*) FILTER (
               WHERE status = 'trialing'
               AND COALESCE(trial_end, current_period_end, TIMESTAMP 'epoch') > NOW()
             ) AS trialing
           FROM nb_app_entitlements
           WHERE app_slug = 'lumina'
           GROUP BY COALESCE(plan_code, 'unknown')
           ORDER BY COALESCE(plan_code, 'unknown')`
        ),
        pool.query(
          `SELECT
             event_name,
             COUNT(*) AS total_events,
             COUNT(DISTINCT ${actorExpr}) AS unique_actors
           FROM lumina.analytics_events
           WHERE created_at >= NOW() - (($1::int - 1) * INTERVAL '1 day')
           GROUP BY event_name`,
          [windowDays]
        ),
        pool.query(
          `WITH days AS (
             SELECT generate_series(
               CURRENT_DATE - ($1::int - 1),
               CURRENT_DATE,
               INTERVAL '1 day'
             )::date AS day
           ),
           activity AS (
             SELECT
               created_at::date AS day,
               COUNT(DISTINCT ${actorExpr}) AS active_users,
               COUNT(*) FILTER (WHERE event_name = 'billing_checkout_started') AS checkout_starts,
               COUNT(*) FILTER (WHERE event_name = 'billing_access_granted') AS access_grants,
               COUNT(*) FILTER (WHERE event_name = 'checkin_saved') AS checkins,
               COUNT(*) FILTER (WHERE event_name = 'day_completed') AS completions
             FROM lumina.analytics_events
             WHERE created_at >= CURRENT_DATE - ($1::int - 1)
             GROUP BY created_at::date
           )
           SELECT
             days.day,
             COALESCE(activity.active_users, 0) AS active_users,
             COALESCE(activity.checkout_starts, 0) AS checkout_starts,
             COALESCE(activity.access_grants, 0) AS access_grants,
             COALESCE(activity.checkins, 0) AS checkins,
             COALESCE(activity.completions, 0) AS completions
           FROM days
           LEFT JOIN activity ON activity.day = days.day
           ORDER BY days.day`,
          [windowDays]
        ),
        pool.query(
          `WITH progress_rollup AS (
             SELECT user_id, COUNT(*) AS completed_days, MAX(completed_at) AS last_completed_at
             FROM lumina.progress
             GROUP BY user_id
           ),
           checkin_rollup AS (
             SELECT user_id, COUNT(*) AS total_checkins, MAX(updated_at) AS last_checkin_at
             FROM lumina.checkins
             GROUP BY user_id
           ),
           reflection_rollup AS (
             SELECT
               user_id,
               COUNT(*) AS total_reflections,
               COUNT(*) FILTER (WHERE favorite) AS favorite_reflections,
               MAX(updated_at) AS last_reflection_at
             FROM lumina.reflections
             GROUP BY user_id
           ),
           analytics_rollup AS (
             SELECT
               COUNT(DISTINCT ${actorExpr})
                 FILTER (WHERE created_at >= NOW() - INTERVAL '7 days') AS active_7d,
               COUNT(DISTINCT ${actorExpr})
                 FILTER (WHERE created_at >= NOW() - (($1::int - 1) * INTERVAL '1 day')) AS active_window
             FROM lumina.analytics_events
           ),
           user_rollup AS (
             SELECT
               COUNT(*) AS total_users,
               COUNT(*) FILTER (WHERE u.created_at >= NOW() - (($1::int - 1) * INTERVAL '1 day')) AS new_users_window,
               COUNT(*) FILTER (WHERE COALESCE(p.completed_days, 0) > 0) AS started_journey,
               COUNT(*) FILTER (WHERE COALESCE(p.completed_days, 0) >= 7) AS reached_day7,
               COUNT(*) FILTER (WHERE COALESCE(p.completed_days, 0) >= 30) AS reached_day30,
               COUNT(*) FILTER (WHERE COALESCE(c.total_checkins, 0) > 0) AS checked_in_users,
               COUNT(*) FILTER (WHERE COALESCE(r.total_reflections, 0) > 0) AS reflective_users,
               ROUND(AVG(COALESCE(p.completed_days, 0))::numeric, 1) AS avg_completed_days
             FROM lumina.users u
             LEFT JOIN progress_rollup p ON p.user_id = u.id
             LEFT JOIN checkin_rollup c ON c.user_id = u.id
             LEFT JOIN reflection_rollup r ON r.user_id = u.id
           )
           SELECT
             COALESCE(u.total_users, 0) AS total_users,
             COALESCE(u.new_users_window, 0) AS new_users_window,
             COALESCE(u.started_journey, 0) AS started_journey,
             COALESCE(u.reached_day7, 0) AS reached_day7,
             COALESCE(u.reached_day30, 0) AS reached_day30,
             COALESCE(u.checked_in_users, 0) AS checked_in_users,
             COALESCE(u.reflective_users, 0) AS reflective_users,
             COALESCE(u.avg_completed_days, 0) AS avg_completed_days,
             COALESCE(a.active_7d, 0) AS active_7d,
             COALESCE(a.active_window, 0) AS active_window
           FROM user_rollup u
           CROSS JOIN analytics_rollup a`,
          [windowDays]
        ),
        pool.query(
          `SELECT
             COUNT(DISTINCT ${actorExpr})
               FILTER (WHERE created_at >= NOW() - INTERVAL '7 days') AS active_7d,
             COUNT(DISTINCT ${actorExpr})
               FILTER (WHERE created_at >= NOW() - (($1::int - 1) * INTERVAL '1 day')) AS active_window
           FROM lumina.analytics_events`,
          [windowDays]
        ),
        pool.query(
          `SELECT state, COUNT(*) AS count
           FROM lumina.checkins
           WHERE updated_at >= NOW() - (($1::int - 1) * INTERVAL '1 day')
           GROUP BY state
           ORDER BY count DESC, state ASC
           LIMIT 6`,
          [windowDays]
        ),
        pool.query(
          `SELECT
             created_at,
             event_name,
             email,
             page_path,
             properties
           FROM lumina.analytics_events
           ORDER BY created_at DESC
           LIMIT $1`,
          [recentLimit]
        )
      ]);

      const subscriptionSummary = subscriptionSummaryQ.rows[0] || {};
      const engagement = engagementQ.rows[0] || {};
      const activityWindow = activityWindowQ.rows[0] || {};
      const eventMap = new Map(eventSummaryQ.rows.map((row) => [row.event_name, row]));
      const funnelStages = [
        ['auth_screen_viewed', 'Auth screen viewed'],
        ['auth_signup_completed', 'Signups completed'],
        ['billing_screen_viewed', 'Billing screen viewed'],
        ['billing_checkout_started', 'Checkout started'],
        ['billing_checkout_returned', 'Checkout returned'],
        ['billing_access_granted', 'Access granted'],
        ['checkin_saved', 'First check-in'],
        ['day_completed', 'Day completed'],
        ['weekly_synthesis_viewed', 'Weekly synthesis viewed']
      ].map(([eventName, label]) => {
        const row = eventMap.get(eventName);
        return {
          eventName,
          label,
          totalEvents: toInt(row?.total_events),
          uniqueActors: toInt(row?.unique_actors)
        };
      });

      res.json({
        windowDays,
        subscriptions: {
          totalEntitlements: toInt(subscriptionSummary.total_entitlements),
          activeAccess: toInt(subscriptionSummary.active_access),
          trialing: toInt(subscriptionSummary.trialing),
          grace: toInt(subscriptionSummary.grace),
          cancelScheduled: toInt(subscriptionSummary.cancel_scheduled),
          expired: toInt(subscriptionSummary.expired),
          plans: planMixQ.rows.map((row) => ({
            planCode: row.plan_code,
            total: toInt(row.total),
            activeAccess: toInt(row.active_access),
            trialing: toInt(row.trialing)
          }))
        },
        engagement: {
          totalUsers: toInt(engagement.total_users),
          newUsersWindow: toInt(engagement.new_users_window),
          active7d: toInt(activityWindow.active_7d),
          activeWindow: toInt(activityWindow.active_window),
          startedJourney: toInt(engagement.started_journey),
          reachedDay7: toInt(engagement.reached_day7),
          reachedDay30: toInt(engagement.reached_day30),
          checkedInUsers: toInt(engagement.checked_in_users),
          reflectiveUsers: toInt(engagement.reflective_users),
          avgCompletedDays: toNum(engagement.avg_completed_days)
        },
        funnel: funnelStages,
        daily: dailyActivityQ.rows.map((row) => ({
          day: row.day,
          activeUsers: toInt(row.active_users),
          checkoutStarts: toInt(row.checkout_starts),
          accessGrants: toInt(row.access_grants),
          checkins: toInt(row.checkins),
          completions: toInt(row.completions)
        })),
        states: stateMixQ.rows.map((row) => ({
          state: row.state,
          count: toInt(row.count)
        })),
        recentEvents: recentEventsQ.rows.map((row) => ({
          createdAt: row.created_at,
          eventName: row.event_name,
          email: row.email || null,
          pagePath: row.page_path || null,
          properties: row.properties || {}
        }))
      });
    } catch (e) {
      logger.error({ err: e }, 'Lumina analytics admin error');
      res.status(500).json({ error: 'Server error' });
    }
  });
}

module.exports = { createAdminObservability };
