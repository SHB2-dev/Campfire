// Google アナリティクス(GA4)。サーバーに測定ID(GA_MEASUREMENT_ID)が設定されているときだけ動く。
//  - 訪問者が「同意する」を押すまで、Google のスクリプトは読み込まない(Cookie も作られない)
//  - 同意はこのブラウザにだけ保存する。「アクセス解析の設定」からいつでも変更できる
(() => {
  const id = document.querySelector('meta[name="ga-id"]')?.content;
  if (!id) return; // 未設定なら何もしない(バナーも出さない)

  const KEY = 'packhearth-analytics';
  const read = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
  const write = (v) => { try { localStorage.setItem(KEY, v); } catch { /* 保存できなくても動く */ } };

  let loaded = false;
  function load() {
    if (loaded) return;
    loaded = true;
    window.dataLayer = window.dataLayer || [];
    window.gtag = function gtag() { window.dataLayer.push(arguments); };
    window.gtag('js', new Date());
    window.gtag('config', id, { anonymize_ip: true });
    const s = document.createElement('script');
    s.async = true;
    s.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(id)}`;
    document.head.appendChild(s);
    // ダウンロードボタンのクリックを記録する
    document.addEventListener('click', (e) => {
      const a = e.target.closest?.('.dl, #dl-main');
      if (a && window.gtag) window.gtag('event', 'download_click', { os: a.dataset?.os || 'auto' });
    });
  }

  function stop() {
    window[`ga-disable-${id}`] = true; // 以降の送信を止める
    for (const c of document.cookie.split(';')) {
      const name = c.split('=')[0].trim();
      if (name.startsWith('_ga')) document.cookie = `${name}=; Max-Age=0; path=/`;
    }
  }

  function showBanner() {
    document.getElementById('consent')?.remove();
    const box = document.createElement('div');
    box.id = 'consent';
    box.className = 'consent';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', 'アクセス解析の設定');
    const p = document.createElement('p');
    p.append('サイトの改善のため、Google アナリティクスでアクセス状況を集計してもよろしいですか?同意するまで、Google への送信はしません。詳しくは');
    const a = document.createElement('a');
    a.href = '/privacy.html';
    a.textContent = 'プライバシーポリシー';
    p.append(a, 'をご覧ください。');
    const ok = document.createElement('button');
    ok.textContent = '同意する';
    ok.onclick = () => { write('granted'); window[`ga-disable-${id}`] = false; load(); box.remove(); };
    const no = document.createElement('button');
    no.className = 'ghost';
    no.textContent = '同意しない';
    no.onclick = () => { write('denied'); stop(); box.remove(); };
    box.append(p, ok, no);
    document.body.append(box);
  }

  const saved = read();
  if (saved === 'granted') load();
  else if (saved === null) showBanner();

  // フッターの「アクセス解析の設定」から、あとで変更できる
  document.querySelectorAll('[data-analytics-settings]').forEach((el) => {
    el.hidden = false;
    el.addEventListener('click', (e) => { e.preventDefault(); showBanner(); });
  });
})();
