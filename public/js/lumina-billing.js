(function () {
  var params = new URLSearchParams(window.location.search);
  var forms = Array.prototype.slice.call(document.querySelectorAll('[data-checkout-form]'));
  var langLinks = Array.prototype.slice.call(document.querySelectorAll('[data-lang-choice]'));
  var returnUrl = params.get('return_url') || 'https://lumina.namibarden.com/?billing=success';

  function setLang(lang) {
    var safeLang = lang === 'en' ? 'en' : 'ja';
    document.documentElement.dataset.lang = safeLang;
    document.documentElement.lang = safeLang;
    document.cookie = 'nb_lang=' + encodeURIComponent(safeLang) + '; path=/; max-age=31536000; SameSite=Lax';
    try {
      var url = new URL(window.location.href);
      url.searchParams.set('lang', safeLang);
      window.history.replaceState({}, '', url.toString());
    } catch (error) {}
  }

  function setStatus(form, status) {
    Array.prototype.slice.call(form.querySelectorAll('[data-status-message]')).forEach(function (node) {
      node.hidden = node.getAttribute('data-status-message') !== status;
    });
  }

  function syncForm(form) {
    var ack = form.elements.ack;
    var button = form.querySelector('button[type="submit"]');
    if (button) button.disabled = !(ack && ack.checked);
  }

  function fillInitialValues(form) {
    if (form.elements.name) form.elements.name.value = params.get('name') || '';
    if (form.elements.email) form.elements.email.value = params.get('email') || '';
  }

  langLinks.forEach(function (link) {
    link.addEventListener('click', function (event) {
      event.preventDefault();
      setLang(link.getAttribute('data-lang-choice'));
    });
  });

  forms.forEach(function (form) {
    fillInitialValues(form);
    syncForm(form);

    if (form.elements.ack) {
      form.elements.ack.addEventListener('change', function () {
        setStatus(form, '');
        syncForm(form);
      });
    }
    if (form.elements.email) {
      form.elements.email.addEventListener('input', function () {
        setStatus(form, '');
      });
    }

    form.addEventListener('submit', async function (event) {
      event.preventDefault();
      var lang = form.getAttribute('data-lang') === 'en' ? 'en' : 'ja';
      var button = form.querySelector('button[type="submit"]');
      var ack = form.elements.ack;
      var email = form.elements.email;

      if (!ack || !ack.checked) {
        setStatus(form, 'terms');
        syncForm(form);
        return;
      }
      if (!email || !email.value || !email.checkValidity()) {
        setStatus(form, 'error');
        syncForm(form);
        return;
      }

      if (button) button.disabled = true;
      setStatus(form, 'loading');

      try {
        var response = await fetch('/api/stripe/create-checkout-session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            product: 'lumina-lifetime',
            name: form.elements.name ? form.elements.name.value.trim() : '',
            email: email.value.trim(),
            lang: lang,
            currency: 'jpy',
            return_url: returnUrl,
            success_url: returnUrl,
            cancel_url: window.location.href
          })
        });
        var data = await response.json();
        if (!response.ok || !data.url) throw new Error('checkout_failed');
        setStatus(form, 'ok');
        window.location.href = data.url;
      } catch (error) {
        setStatus(form, 'error');
        syncForm(form);
      }
    });
  });
})();
