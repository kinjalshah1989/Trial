(() => {
  'use strict';

  const root = document.documentElement;
  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
  const saveData = navigator.connection?.saveData === true;

  const currencyStorageKey = 'globalRaniCurrency';
  const currencyCookieKey = 'globalRaniCurrencySelection';
  const defaultCurrencySelection = { country: 'US', code: 'USD', name: 'United States', symbol: '$' };
  const fallbackExchangeRates = {
    USD: 1, INR: 95.5221, GBP: 0.748727, EUR: 0.874011, CAD: 1.41985, AUD: 1.44071,
    AED: 3.6725, SGD: 1.28, NZD: 1.63, JPY: 161, MYR: 4.24, PHP: 58.6, MXN: 18.2,
    ZAR: 17.9, SAR: 3.75, QAR: 3.64
  };

  const parseCurrencySelection = (value) => {
    const [country, code, name, symbol] = String(value || '').split('|');
    if (!country || !code || !name || symbol == null) return { ...defaultCurrencySelection };
    return { country, code: code.toUpperCase(), name, symbol };
  };

  const readCurrencyCookie = () => {
    const prefix = `${currencyCookieKey}=`;
    const match = String(document.cookie || '').split(';').map(value => value.trim()).find(value => value.startsWith(prefix));
    if (!match) return '';
    try { return decodeURIComponent(match.slice(prefix.length)); }
    catch (_) { return ''; }
  };

  const storedCurrencySelection = (() => {
    try { return localStorage.getItem(currencyStorageKey) || readCurrencyCookie(); }
    catch (_) { return readCurrencyCookie(); }
  })();

  let currencySelection = parseCurrencySelection(storedCurrencySelection);
  let exchangeRates = { ...fallbackExchangeRates };

  const isIndiaSelection = () => currencySelection.country === 'IN' || currencySelection.code === 'INR';
  const discountedUSD = (usd) => (Number(usd) || 0) * (isIndiaSelection() ? 0.5 : 1);
  const convertUSD = (usd) => discountedUSD(usd) * (exchangeRates[currencySelection.code] || fallbackExchangeRates[currencySelection.code] || 1);
  const formatAmount = (amount, currencyCode = currencySelection.code) => {
    const numericAmount = Number(amount) || 0;
    try {
      return new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: currencyCode,
        maximumFractionDigits: ['JPY', 'KRW', 'IDR'].includes(currencyCode) ? 0 : 2
      }).format(numericAmount);
    } catch (_) {
      return `${currencySelection.symbol}${numericAmount.toFixed(2)} ${currencyCode}`;
    }
  };
  const formatUSD = (usd) => formatAmount(convertUSD(usd));

  const nodesIncludingRoot = (scope, selector) => {
    const nodes = [];
    if (scope instanceof Element && scope.matches(selector)) nodes.push(scope);
    if (scope?.querySelectorAll) nodes.push(...scope.querySelectorAll(selector));
    return nodes;
  };

  const setFormattedUSD = (element, usd, prefix = '') => {
    if (!(element instanceof Element) || !Number.isFinite(Number(usd))) return;
    element.textContent = `${prefix}${formatUSD(Number(usd))}`;
    element.dataset.displayCurrency = currencySelection.code;
  };

  const updateCurrencyPrices = (scope = document) => {
    nodesIncludingRoot(scope, '.converted-price[data-usd], [data-global-rani-usd]').forEach((element) => {
      const usd = element.dataset.usd ?? element.dataset.globalRaniUsd;
      const prefix = /^\s*From\s+/i.test(element.textContent || '') ? 'From ' : '';
      setFormattedUSD(element, usd, prefix);
    });

    nodesIncludingRoot(scope, '.small-card .price:not([data-global-rani-usd])').forEach((element) => {
      const match = (element.textContent || '').trim().match(/^(From\s+)?\$([0-9]+(?:\.[0-9]+)?)$/i);
      if (!match) return;
      element.dataset.globalRaniUsd = match[2];
      setFormattedUSD(element, match[2], match[1] ? 'From ' : '');
    });

    nodesIncludingRoot(scope, '.product[data-usd-price], .product[data-price]').forEach((card) => {
      const usd = Number(card.dataset.usdPrice ?? card.dataset.price);
      if (!Number.isFinite(usd)) return;
      card.querySelectorAll('.price, .frame-price-badge, .inventory-product-price').forEach((element) => {
        if (element.matches('.converted-price[data-usd], [data-global-rani-usd]')) return;
        const currentText = (element.textContent || '').trim();
        if (usd === 0 && /add price|update price/i.test(currentText)) return;
        const prefix = /^From\s+/i.test(currentText) ? 'From ' : '';
        setFormattedUSD(element, usd, prefix);
      });
    });
  };

  const announceCurrencyUpdate = () => {
    updateCurrencyPrices(document);
    window.dispatchEvent(new CustomEvent('global-rani-currency-change', {
      detail: { selection: { ...currencySelection }, rate: exchangeRates[currencySelection.code] || 1, indiaDiscount: isIndiaSelection() }
    }));
  };

  const setCurrencySelection = (value, persist = true) => {
    currencySelection = parseCurrencySelection(value);
    if (persist) {
      try { localStorage.setItem(currencyStorageKey, value); }
      catch (_) {}
      try {
        document.cookie = `${currencyCookieKey}=${encodeURIComponent(value)}; Path=/; Max-Age=31536000; SameSite=Lax`;
      } catch (_) {}
    }
    root.dataset.shipToCountry = currencySelection.country;
    root.dataset.displayCurrency = currencySelection.code;
    announceCurrencyUpdate();
  };

  window.GlobalRaniCurrency = Object.freeze({
    convertUSD,
    discountedUSD,
    formatAmount,
    formatUSD,
    getRate: () => exchangeRates[currencySelection.code] || fallbackExchangeRates[currencySelection.code] || 1,
    getSelection: () => ({ ...currencySelection }),
    isIndia: isIndiaSelection,
    refresh: updateCurrencyPrices,
    setSelection: setCurrencySelection
  });

  document.addEventListener('change', (event) => {
    if (event.target?.id === 'countryCurrency') setCurrencySelection(event.target.value);
  }, true);

  window.addEventListener('storage', (event) => {
    if (event.key !== currencyStorageKey || !event.newValue) return;
    setCurrencySelection(event.newValue, false);
  });

  root.classList.add('quality-js');
  if (reduceMotion) root.classList.add('quality-reduced-motion');
  if (saveData) root.classList.add('quality-save-data');

  const optimizeImage = (image) => {
    if (!(image instanceof HTMLImageElement)) return;
    if (!image.hasAttribute('decoding')) image.decoding = 'async';

    const rect = image.getBoundingClientRect();
    const hiddenOrZeroSize = rect.width === 0 && rect.height === 0;
    const belowInitialView = rect.top > window.innerHeight * 1.15;
    if ((hiddenOrZeroSize || belowInitialView) && !image.hasAttribute('loading')) image.loading = 'lazy';
    if (!hiddenOrZeroSize && !belowInitialView && !image.hasAttribute('fetchpriority')) {
      image.setAttribute('fetchpriority', 'high');
    }
  };

  document.querySelectorAll('img').forEach(optimizeImage);

  const imageObserver = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      mutation.addedNodes.forEach((node) => {
        if (node instanceof HTMLImageElement) optimizeImage(node);
        if (node instanceof Element) {
          node.querySelectorAll('img').forEach(optimizeImage);
          updateCurrencyPrices(node);
        }
      });
    });
  });
  imageObserver.observe(document.body, { childList:true, subtree:true });

  document.querySelectorAll('a[target="_blank"]').forEach((link) => {
    const rel = new Set((link.getAttribute('rel') || '').split(/\s+/).filter(Boolean));
    rel.add('noopener');
    rel.add('noreferrer');
    link.setAttribute('rel', [...rel].join(' '));
  });

  document.querySelectorAll('.status').forEach((status) => {
    if (!status.hasAttribute('role')) status.setAttribute('role', 'status');
    if (!status.hasAttribute('aria-live')) status.setAttribute('aria-live', 'polite');
  });

  const updateVisibility = () => {
    root.classList.toggle('quality-page-hidden', document.hidden);
  };
  document.addEventListener('visibilitychange', updateVisibility, { passive:true });
  updateVisibility();

  root.dataset.shipToCountry = currencySelection.country;
  root.dataset.displayCurrency = currencySelection.code;
  announceCurrencyUpdate();
  fetch('https://open.er-api.com/v6/latest/USD')
    .then((response) => response.ok ? response.json() : Promise.reject(new Error('Exchange-rate request failed')))
    .then((data) => {
      if (data?.rates) exchangeRates = { ...fallbackExchangeRates, ...data.rates, USD: 1 };
    })
    .catch(() => {})
    .finally(announceCurrencyUpdate);
})();
