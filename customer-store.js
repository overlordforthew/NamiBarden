function createCustomerStore({ pool, logger, normalizeEmail }) {
  async function upsertCustomer(email, name, stripeCustomerId) {
    try {
      const safeEmail = normalizeEmail(email);
      if (!safeEmail) throw new Error('Email required for customer upsert');

      if (stripeCustomerId) {
        const existingStripe = await pool.query(
          `SELECT id FROM nb_customers WHERE stripe_customer_id = $1 LIMIT 1`,
          [stripeCustomerId]
        );
        if (existingStripe.rows.length > 0) {
          await pool.query(
            `UPDATE nb_customers
             SET email = $1, name = COALESCE($2, name), updated_at = NOW()
             WHERE id = $3`,
            [safeEmail, name || null, existingStripe.rows[0].id]
          );
          return existingStripe.rows[0].id;
        }
      }

      const existingEmail = await pool.query(
        `SELECT id, stripe_customer_id
         FROM nb_customers
         WHERE LOWER(email) = $1
         ORDER BY updated_at DESC
         LIMIT 1`,
        [safeEmail]
      );
      if (existingEmail.rows.length > 0) {
        await pool.query(
          `UPDATE nb_customers
           SET name = COALESCE($1, name),
               stripe_customer_id = COALESCE(stripe_customer_id, $2),
               updated_at = NOW()
           WHERE id = $3`,
          [name || null, stripeCustomerId || null, existingEmail.rows[0].id]
        );
        return existingEmail.rows[0].id;
      }

      const inserted = await pool.query(
        `INSERT INTO nb_customers (email, name, stripe_customer_id)
         VALUES ($1, $2, $3)
         RETURNING id`,
        [safeEmail, name || null, stripeCustomerId || null]
      );
      return inserted.rows[0].id;
    } catch (err) {
      logger.error({ err, email, stripeCustomerId }, 'upsertCustomer DB error');
      throw err;
    }
  }

  return {
    upsertCustomer
  };
}

module.exports = { createCustomerStore };
