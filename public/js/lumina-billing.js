(function () {
  var params = new URLSearchParams(window.location.search);
  var selectedPlan = params.get('plan') === 'lumina-annual' ? 'lumina-annual' : 'lumina-monthly';
  var plans = Array.prototype.slice.call(document.querySelectorAll('.plan'));
  var form = document.getElementById('billing-form');
  var status = document.getElementById('status');
  var checkoutButton = document.getElementById('checkout-button');
  var returnLuminaButton = document.getElementById('return-lumina');
  var nameInput = document.getElementById('billing-name');
  var emailInput = document.getElementById('billing-email');
  var langInput = document.getElementById('billing-lang');
  var currencyInput = document.getElementById('billing-currency');
  var ackInput = document.getElementById('billing-ack');
  var renewalLabel = document.getElementById('renewal-label');
  var renewalPrice = document.getElementById('renewal-price');
  var summaryCopy = document.getElementById('summary-copy');
  var summaryAccess = document.getElementById('summary-access');
  var trialPrice = document.getElementById('trial-price');
  var monthlyPrice = document.getElementById('monthly-price');
  var annualPrice = document.getElementById('annual-price');
  var monthlyTermsPrice = document.getElementById('monthly-terms-price');
  var annualTermsPrice = document.getElementById('annual-terms-price');
  var returnUrl = params.get('return_url') || 'https://lumina.namibarden.com/?billing=success';
  var currencyTouched = false;

  var PRICING = {
    usd: {
      'lumina-monthly': {
        card: 'USD $20 <small>/ month</small>',
        renewal: 'USD $20 / month',
        trial: 'USD $0 during trial',
        term: 'USD $20 every 30 days',
        button: 'Start 7-Day Trial',
        access: 'Daily guidance, reflection, and synthesis',
        summary: 'Choose monthly if you want a lighter starting point and the option to stay flexible.'
      },
      'lumina-annual': {
        card: 'USD $200 <small>/ year</small>',
        renewal: 'USD $200 / year',
        trial: 'USD $0 during trial',
        term: 'USD $200 every 365 days',
        button: 'Start 7-Day Annual Trial',
        access: 'A full year of Lumina access',
        summary: 'Choose annual if you want one clean commitment and the best value for long-term practice.'
      }
    },
    jpy: {
      'lumina-monthly': {
        card: 'JPY 2,980 <small>/ month</small>',
        renewal: 'JPY 2,980 / month',
        trial: 'JPY 0 during trial',
        term: 'JPY 2,980 every 30 days',
        button: 'Start 7-Day Trial',
        access: 'Daily guidance, reflection, and synthesis',
        summary: 'Choose monthly if you want a lighter starting point and the option to stay flexible.'
      },
      'lumina-annual': {
        card: 'JPY 29,800 <small>/ year</small>',
        renewal: 'JPY 29,800 / year',
        trial: 'JPY 0 during trial',
        term: 'JPY 29,800 every 365 days',
        button: 'Start 7-Day Annual Trial',
        access: 'A full year of Lumina access',
        summary: 'Choose annual if you want one clean commitment and the best value for long-term practice.'
      }
    }
  };

  function normalizeCurrency(value) {
    if (value === 'jpy' || value === 'usd') return value;
    return null;
  }

  function defaultCurrencyForLang(lang) {
    return lang === 'ja' ? 'jpy' : 'usd';
  }

  function getReturnOrigin() {
    try {
      return new URL(returnUrl).origin + '/';
    } catch (error) {
      return 'https://lumina.namibarden.com/';
    }
  }

  function setStatus(message, type) {
    status.textContent = message || '';
    status.className = 'status' + (type ? ' ' + type : '');
  }

  function getCurrentCurrency() {
    return normalizeCurrency(currencyInput.value) || defaultCurrencyForLang(langInput.value);
  }

  function updatePriceBlocks() {
    var currency = getCurrentCurrency();
    if (monthlyPrice) monthlyPrice.innerHTML = PRICING[currency]['lumina-monthly'].card;
    if (annualPrice) annualPrice.innerHTML = PRICING[currency]['lumina-annual'].card;
    if (monthlyTermsPrice) monthlyTermsPrice.textContent = PRICING[currency]['lumina-monthly'].term;
    if (annualTermsPrice) annualTermsPrice.textContent = PRICING[currency]['lumina-annual'].term;
  }

  function applySelectedPlan() {
    var currency = getCurrentCurrency();
    var pricing = PRICING[currency][selectedPlan];

    plans.forEach(function (plan) {
      plan.classList.toggle('selected', plan.getAttribute('data-plan') === selectedPlan);
    });

    updatePriceBlocks();
    checkoutButton.textContent = pricing.button;
    if (renewalLabel) renewalLabel.textContent = 'After 7 days';
    if (renewalPrice) renewalPrice.textContent = pricing.renewal;
    if (trialPrice) trialPrice.textContent = pricing.trial;
    if (summaryAccess) summaryAccess.textContent = pricing.access;
    if (summaryCopy) summaryCopy.textContent = pricing.summary;
  }

  function syncCheckoutState() {
    checkoutButton.disabled = !ackInput.checked;
  }

  plans.forEach(function (plan) {
    plan.addEventListener('click', function () {
      selectedPlan = plan.getAttribute('data-plan');
      applySelectedPlan();
    });
  });

  nameInput.value = params.get('name') || '';
  emailInput.value = params.get('email') || '';
  langInput.value = params.get('lang') === 'ja' ? 'ja' : 'en';
  currencyInput.value = normalizeCurrency(params.get('currency')) || defaultCurrencyForLang(langInput.value);
  currencyTouched = !!normalizeCurrency(params.get('currency'));
  applySelectedPlan();
  syncCheckoutState();

  langInput.addEventListener('change', function () {
    if (!currencyTouched) {
      currencyInput.value = defaultCurrencyForLang(langInput.value);
    }
    setStatus('');
    applySelectedPlan();
  });

  currencyInput.addEventListener('change', function () {
    currencyTouched = true;
    currencyInput.value = getCurrentCurrency();
    setStatus('');
    applySelectedPlan();
  });

  ackInput.addEventListener('change', function () {
    if (ackInput.checked) setStatus('');
    syncCheckoutState();
  });

  returnLuminaButton.addEventListener('click', function () {
    window.location.href = getReturnOrigin();
  });

  if (!params.get('return_url')) {
    returnLuminaButton.textContent = 'Go to Lumina';
  }

  form.addEventListener('submit', async function (event) {
    event.preventDefault();
    if (!ackInput.checked) {
      setStatus('Please confirm the billing terms before continuing.', 'error');
      return;
    }

    setStatus('');
    checkoutButton.disabled = true;

    var payload = {
      product: selectedPlan,
      name: nameInput.value.trim(),
      email: emailInput.value.trim(),
      lang: langInput.value,
      currency: getCurrentCurrency(),
      success_url: returnUrl,
      cancel_url: window.location.href
    };

    try {
      var response = await fetch('/api/stripe/create-checkout-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      var data = await response.json();
      if (!response.ok || !data.url) {
        throw new Error(data.error || 'Unable to start checkout');
      }
      setStatus('Redirecting to secure checkout...', 'ok');
      window.location.href = data.url;
    } catch (error) {
      setStatus(error.message || 'Unable to start checkout right now.', 'error');
      syncCheckoutState();
    }
  });
})();
