function createWhatsAppSender({ overlordUrl, webhookToken, logger }) {
  return async function sendWhatsApp(to, text) {
    if (!overlordUrl || !webhookToken) return false;
    try {
      const response = await fetch(`${overlordUrl}/api/send`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${webhookToken}`
        },
        body: JSON.stringify({ to, text }),
        signal: AbortSignal.timeout(10000)
      });
      if (!response.ok) {
        logger.error({ status: response.status }, 'WhatsApp send failed');
        return false;
      }
      return true;
    } catch (err) {
      logger.error({ err }, 'WhatsApp send failed');
      return false;
    }
  };
}

module.exports = { createWhatsAppSender };
