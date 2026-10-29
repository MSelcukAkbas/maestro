// Panel asistanı: durum, açma (kaldığı yerden ya da yeni konuşma) ve kapatma.
const assistant = require('../panel/assistant');
const { route, readBody } = require('../panel/http');
const { HttpError } = require('../panel/context');

route('GET', '/api/assistant', async () => assistant.status());

route('POST', '/api/assistant/open', async (req) => {
  const body = await readBody(req);
  return assistant.open({ fresh: !!body.fresh, accountId: typeof body.accountId === 'string' ? body.accountId : undefined });
});

route('POST', '/api/assistant/stop', async () => assistant.stop());

// Zamanlayıcılar (asistanın kurduğu tek seferlik işler): liste ve iptal.
route('GET', '/api/schedules', async () => assistant.scheduleView());
route('DELETE', '/api/schedules/(\\d+)', async (req, m) => {
  try {
    assistant.cancelSchedule(Number(m[1]));
  } catch (err) {
    throw new HttpError(409, err.message);
  }
  return { ok: true };
});
