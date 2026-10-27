// Mesaj geliştirici: her terminalin sağ altındaki ✨ düğmesi, terminalin üstünde küçük bir panel açar. Ham mesaj yazılır,
// model düzeltip kısa gerekçelerle gösterir; sonuç kopyalanır ya da üyenin terminaline gönderilir.
const IMP_HTML = `
  <div class="imp-h"><b>Mesajı geliştir</b><button type="button" class="imp-x" data-imp="close" aria-label="Kapat">×</button></div>
  <textarea class="imp-in" rows="5" placeholder="Göndereceğin ham mesajı yaz…" aria-label="Ham mesaj"></textarea>
  <div class="imp-act"><span class="imp-msg"></span><button type="button" class="btn primary" data-imp="run">Geliştir</button></div>
  <div class="imp-out" hidden>
    <textarea class="imp-res" rows="7" aria-label="Geliştirilmiş mesaj"></textarea>
    <ul class="imp-why"></ul>
    <div class="imp-act"><button type="button" class="btn ghost" data-imp="copy">Kopyala</button><button type="button" class="btn ghost" data-imp="retry">Tekrar dene</button><button type="button" class="btn primary" data-imp="send">Gönder</button></div>
  </div>`;

function impPanel(pane) {
  let p = pane.querySelector('.imp');
  if (!p) {
    p = document.createElement('div');
    p.className = 'imp';
    p.hidden = true;
    p.innerHTML = IMP_HTML;
    pane.appendChild(p);
  }
  return p;
}

async function impRun(p, sid) {
  const input = p.querySelector('.imp-in');
  const text = input.value.trim();
  if (!text) return;
  const btn = p.querySelector('[data-imp="run"]');
  const msg = p.querySelector('.imp-msg');
  btn.disabled = true;
  msg.textContent = 'Geliştiriliyor…';
  try {
    const r = await api('POST', `/api/sessions/${encodeURIComponent(sid)}/improve-prompt`, { text });
    p.querySelector('.imp-res').value = r.text;
    p.querySelector('.imp-why').innerHTML = (r.changed ? r.reasons : r.reasons.length ? r.reasons : ['Mesaj zaten net; değişiklik gerekmedi.']).map((x) => `<li>${esc(x)}</li>`).join('');
    p.querySelector('.imp-out').hidden = false;
    msg.textContent = '';
  } catch (err) {
    msg.textContent = '';
    toast(err.message || 'Mesaj geliştirilemedi.', true);
  } finally {
    btn.disabled = false;
  }
}

document.addEventListener('click', async (e) => {
  const open = e.target.closest('.pane-imp');
  const act = e.target.closest('[data-imp]');
  const pane = (open || act) && (open || act).closest('.pane');
  if (!pane) return;
  const p = impPanel(pane);
  if (open) {
    p.hidden = !p.hidden;
    if (!p.hidden) p.querySelector('.imp-in').focus();
    return;
  }
  const sid = pane.dataset.sid;
  const what = act.dataset.imp;
  if (what === 'close') p.hidden = true;
  else if (what === 'run' || what === 'retry') await impRun(p, sid);
  else if (what === 'copy') {
    try {
      await navigator.clipboard.writeText(p.querySelector('.imp-res').value);
      toast('Kopyalandı.');
    } catch { toast('Kopyalanamadı.', true); }
  } else if (what === 'send') {
    const text = p.querySelector('.imp-res').value.trim();
    if (!text) return;
    try {
      await api('POST', `/api/sessions/${encodeURIComponent(sid)}/send`, { text });
      toast('Gönderildi.');
      p.querySelector('.imp-in').value = '';
      p.querySelector('.imp-out').hidden = true;
      p.hidden = true;
    } catch (err) { toast(err.message || 'Gönderilemedi.', true); }
  }
});

document.addEventListener('keydown', (e) => {
  const p = e.target.closest && e.target.closest('.imp');
  if (!p) return;
  if (e.key === 'Escape') p.hidden = true;
  else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && e.target.classList.contains('imp-in')) {
    e.preventDefault();
    impRun(p, p.closest('.pane').dataset.sid);
  }
});
