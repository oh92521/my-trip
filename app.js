'use strict';
/* ================= 저장소 ================= */
const KEY = 'travel-data-v1', SKEY = 'travel-settings-v1';
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { alert('저장에 실패했어요'); } };
// 예전 버전 데이터에 새 항목 채우기
const norm = t => { t.plan ||= {}; t.checklist ||= []; t.expenses ||= []; t.saved ||= []; t.diary ||= {}; t.members ||= []; return t; };
let trips = load(KEY, []).map(norm);
let settings = load(SKEY, { kakaoKey: '', googleKey: '' });
const persist = () => save(KEY, trips);
const uid = () => Math.random().toString(36).slice(2, 10);
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const won = n => Math.round(n).toLocaleString('ko-KR') + '원';

/* 사진은 용량이 커서 IndexedDB에 따로 저장 */
const idb = new Promise((ok, fail) => {
  const r = indexedDB.open('travel-photos', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('p');
  r.onsuccess = () => ok(r.result); r.onerror = () => fail(r.error);
});
const pTx = async (mode, fn) => { const db = await idb; return new Promise((ok, fail) => { const q = fn(db.transaction('p', mode).objectStore('p')); q.onsuccess = () => ok(q.result); q.onerror = () => fail(q.error); }); };
const photoPut = (id, blob) => pTx('readwrite', s => s.put(blob, id));
const photoGet = id => pTx('readonly', s => s.get(id));
const photoDel = id => pTx('readwrite', s => s.delete(id));
// 긴 변 1280px JPEG로 줄여서 저장
const shrink = file => new Promise((ok, fail) => {
  const img = new Image(), url = URL.createObjectURL(file);
  img.onload = () => {
    const k = Math.min(1, 1280 / Math.max(img.width, img.height)), c = document.createElement('canvas');
    c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    URL.revokeObjectURL(url);
    c.toBlob(b => b ? ok(b) : fail(new Error('변환 실패')), 'image/jpeg', 0.8);
  };
  img.onerror = () => { URL.revokeObjectURL(url); fail(new Error('사진을 읽지 못했어요')); };
  img.src = url;
});

/* ================= 날짜·거리 ================= */
// 현지 시간 기준 YYYY-MM-DD (toISOString은 UTC라 한국에선 하루 밀림)
const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const days = t => {
  const out = [], d = new Date(t.start + 'T00:00'), e = new Date(t.end + 'T00:00');
  for (let i = 0; d <= e && i < 60; i++) { out.push(ymd(d)); d.setDate(d.getDate() + 1); }
  return out;
};
const fmtDay = s => { const d = new Date(s + 'T00:00'); return `${d.getMonth() + 1}/${d.getDate()} (${'일월화수목금토'[d.getDay()]})`; };
const today = () => ymd(new Date());
const dist = (a, b) => { // 직선거리 km
  const R = 6371, r = x => x * Math.PI / 180, dLa = r(b.lat - a.lat), dLo = r(b.lng - a.lng);
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};
const fmtDist = km => km < 1 ? `${Math.round(km * 1000)}m` : `${km.toFixed(1)}km`;
const DAY_COLORS = ['#14b8a6', '#f97316', '#6366f1', '#ec4899', '#eab308', '#0ea5e9', '#84cc16'];

/* ================= 모달 ================= */
const openModal = html => { $('#sheet').innerHTML = html; $('#modal').hidden = false; };
const closeModal = () => { $('#modal').hidden = true; $('#sheet').innerHTML = ''; };
$('#modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });

/* ================= 지도 API 로더 =================
   국내 → 카카오, 해외 → Google Places API (New) */
const loadScript = src => new Promise((ok, fail) => {
  const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = () => fail(new Error('지도 스크립트를 불러오지 못했어요 (인터넷 연결·키 확인)')); document.head.appendChild(s);
});
let kakaoReady, googleReady;
function loadKakao() {
  if (!settings.kakaoKey) return Promise.reject(new Error('설정(⚙)에서 카카오 JavaScript 키를 입력해 주세요'));
  kakaoReady ??= loadScript(`https://dapi.kakao.com/v2/maps/sdk.js?appkey=${encodeURIComponent(settings.kakaoKey)}&libraries=services&autoload=false`)
    .then(() => new Promise(r => window.kakao.maps.load(r))).catch(e => { kakaoReady = null; throw e; });
  return kakaoReady;
}
function loadGoogle() {
  if (!settings.googleKey) return Promise.reject(new Error('설정(⚙)에서 Google API 키를 입력해 주세요'));
  googleReady ??= loadScript(`https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(settings.googleKey)}&v=weekly&loading=async&language=ko`)
    .then(() => window.google.maps.importLibrary('places')).catch(e => { googleReady = null; throw e; });
  return googleReady;
}

// 공통 결과 형식: {name, address, lat, lng, rating, reviews, url, category, phone, hours[], _photo()}
const KAKAO_CAT = { food: 'FD6', cafe: 'CE7', sight: 'AT4', stay: 'AD5' };
const GOOGLE_CAT = { food: ['restaurant'], cafe: ['cafe'], sight: ['tourist_attraction'], stay: ['lodging'] };
const G_FIELDS = ['displayName', 'formattedAddress', 'location', 'rating', 'userRatingCount', 'googleMapsURI', 'primaryTypeDisplayName', 'nationalPhoneNumber', 'regularOpeningHours', 'photos'];

const fromKakao = p => ({ name: p.place_name, address: p.road_address_name || p.address_name, lat: +p.y, lng: +p.x, url: p.place_url, category: (p.category_name || '').split(' > ').pop(), phone: p.phone || '', distance: p.distance ? +p.distance : null });
const fromGoogle = p => ({
  name: p.displayName, address: p.formattedAddress, lat: p.location?.lat(), lng: p.location?.lng(), rating: p.rating, reviews: p.userRatingCount,
  url: p.googleMapsURI, category: p.primaryTypeDisplayName, phone: p.nationalPhoneNumber || '', hours: p.regularOpeningHours?.weekdayDescriptions || null,
  // 사진은 요청마다 사용량이 잡혀서 '상세'를 열 때만 불러옴 (함수라 저장할 땐 자동으로 빠짐)
  _photo: p.photos?.[0] ? () => p.photos[0].getURI({ maxWidth: 800 }) : null
});

async function searchPlaces(region, query) {
  if (region === 'domestic') {
    await loadKakao();
    const k = window.kakao.maps.services;
    return new Promise((ok, fail) => new k.Places().keywordSearch(query, (data, status) => {
      if (status === k.Status.OK) ok(data.map(fromKakao));
      else if (status === k.Status.ZERO_RESULT) ok([]);
      else fail(new Error('카카오 검색 실패 (키·도메인 설정을 확인해 주세요)'));
    }));
  }
  const { Place } = await loadGoogle();
  const { places } = await Place.searchByText({ textQuery: query, fields: G_FIELDS, maxResultCount: 15, language: 'ko' });
  return places.map(fromGoogle);
}

async function nearby(region, cat, center) {
  if (region === 'domestic') {
    await loadKakao();
    const k = window.kakao.maps;
    return new Promise((ok, fail) => new k.services.Places().categorySearch(KAKAO_CAT[cat], (data, status) => {
      if (status === k.services.Status.OK) ok(data.map(fromKakao));
      else if (status === k.services.Status.ZERO_RESULT) ok([]);
      else fail(new Error('카카오 검색 실패'));
    }, { location: new k.LatLng(center.lat, center.lng), radius: 2000, sort: k.services.SortBy.ACCURACY }));
  }
  const { Place, SearchNearbyRankPreference } = await loadGoogle();
  const { places } = await Place.searchNearby({
    fields: G_FIELDS, includedPrimaryTypes: GOOGLE_CAT[cat], maxResultCount: 20, language: 'ko',
    locationRestriction: { center, radius: 2000 }, rankPreference: SearchNearbyRankPreference.POPULARITY
  });
  // 별점 × 리뷰 수 가중치로 정렬 (리뷰 적은 5점짜리가 위로 오지 않게)
  return places.map(fromGoogle).sort((a, b) => score(b) - score(a));
}
const score = p => (p.rating || 0) * Math.log10((p.reviews || 0) + 1);

/* 장소 목록 그리기. actions: [{label, cls, fn(place, button)}] */
function renderPlaces(el, list, actions, emptyMsg) {
  if (!list.length) { el.innerHTML = `<div class="muted">${emptyMsg || '결과가 없어요'}</div>`; return; }
  el.innerHTML = list.map((p, i) => `<div class="result">
    <div class="row"><div class="grow"><b>${esc(p.name)}</b>
      <div class="muted">${p.rating ? `<span class="star">★ ${p.rating}</span> (${(p.reviews || 0).toLocaleString()}) · ` : ''}${esc(p.category || '')}${p.distance != null ? ` · ${p.distance}m` : ''}</div>
      <div class="muted">${esc(p.address || '')}</div>
      <div class="muted">${p.phone || p.hours || p._photo ? `<button class="link" data-more="${i}">상세 ▾</button> ` : ''}${p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener">지도에서 보기 ↗</a>` : ''}</div></div>
      <div class="acts">${actions.map((a, k) => `<button class="btn sm ${a.cls || ''}" data-a="${i}|${k}">${typeof a.label === 'function' ? a.label(p) : a.label}</button>`).join('')}</div></div>
    <div class="more" id="more${i}" hidden></div></div>`).join('');
  el.querySelectorAll('[data-a]').forEach(b => b.onclick = () => { const [i, k] = b.dataset.a.split('|'); actions[k].fn(list[i], b); });
  el.querySelectorAll('[data-more]').forEach(b => b.onclick = () => {
    const p = list[b.dataset.more], m = el.querySelector('#more' + b.dataset.more);
    if (!m.hidden) { m.hidden = true; return; }
    let photo = ''; try { if (p._photo) photo = `<img src="${esc(p._photo())}" alt="" loading="lazy">`; } catch { }
    m.innerHTML = `${photo}${p.phone ? `<div>📞 <a href="tel:${esc(p.phone.replace(/[^\d+]/g, ''))}">${esc(p.phone)}</a></div>` : ''}
      ${p.hours ? `<div>🕒 영업시간</div><div class="muted">${p.hours.map(esc).join('<br>')}</div>` : ''}`;
    m.hidden = false;
  });
}
const pure = p => { const { distance, ...rest } = p; return JSON.parse(JSON.stringify(rest)); }; // 저장용 (함수·거리 제거)
const isSaved = (t, p) => t.saved.some(s => s.name === p.name && s.address === p.address);
const saveAction = (t, after) => ({
  label: p => isSaved(t, p) ? '♥ 찜' : '♡ 찜',
  fn: (p, btn) => {
    if (isSaved(t, p)) t.saved = t.saved.filter(s => !(s.name === p.name && s.address === p.address));
    else t.saved.push({ id: uid(), ...pure(p) });
    persist(); btn.textContent = isSaved(t, p) ? '♥ 찜' : '♡ 찜'; after?.();
  }
});

/* ================= 라우팅 ================= */
let tab = 'plan', recCat = 'food', recBase = 'center', mapDay = 'all';
function route() {
  const [, page, id] = location.hash.split('/');
  $('#backBtn').hidden = !page;
  if (page === 'trip') { const t = trips.find(x => x.id === id); return t ? tripView(t) : (location.hash = ''); }
  if (page === 'settings') return settingsView();
  listView();
}
window.addEventListener('hashchange', () => { tab = 'plan'; mapDay = 'all'; recBase = 'center'; route(); window.scrollTo(0, 0); });
$('#backBtn').onclick = () => { location.hash = ''; };
$('#settingsBtn').onclick = () => { location.hash = '#/settings'; };

/* ================= 홈 ================= */
const dday = t => Math.round((new Date(t.start + 'T00:00') - new Date(today() + 'T00:00')) / 864e5);
function listView() {
  $('#title').textContent = '내여행';
  const now = today();
  const ongoing = trips.find(t => t.start <= now && now <= t.end);
  const next = [...trips].filter(t => t.start > now).sort((a, b) => a.start.localeCompare(b.start))[0];
  const f = ongoing || next;
  let hero = '';
  if (f) {
    const items = ongoing ? (f.plan[now] || []) : [];
    hero = `<a class="hero" href="#/trip/${f.id}">
      <div class="hero-d">${ongoing ? `여행 ${days(f).indexOf(now) + 1}일째` : `D-${dday(f)}`}</div>
      <div class="hero-t">${esc(f.title)}</div><div class="hero-s">${esc(f.dest)} · ${f.start} ~ ${f.end}</div>
      ${ongoing ? `<div class="hero-list"><b>오늘 일정</b>${items.length ? items.map(it => `<div>${it.time ? esc(it.time) + ' ' : ''}${esc(it.name)}</div>`).join('') : '<div>아직 없어요</div>'}</div>` : ''}</a>`;
  }
  const sorted = [...trips].sort((a, b) => b.start.localeCompare(a.start));
  $('#view').innerHTML = hero + (sorted.length ? `<h3 class="sec">모든 여행</h3>` + sorted.map(t => {
    const dd = dday(t), when = dd > 0 ? `D-${dd}` : (t.end >= now ? '여행 중' : '다녀옴');
    return `<a class="card trip-card" href="#/trip/${t.id}">
      <div><span class="badge ${t.region}">${t.region === 'domestic' ? '국내' : '해외'}</span><span class="muted">${when}</span></div>
      <h3>${esc(t.title)}</h3><div class="muted">${esc(t.dest)} · ${t.start} ~ ${t.end}</div></a>`;
  }).join('') : `<div class="empty">아직 여행이 없어요<br>아래 + 버튼으로 첫 여행을 만들어 보세요</div>`)
    + `<button class="fab" id="addTrip" aria-label="여행 추가">+</button>`;
  $('#addTrip').onclick = () => tripForm();
}

function tripForm(t) {
  const e = t || { title: '', dest: '', region: 'domestic', start: today(), end: today(), currency: 'KRW', rate: 1, members: [] };
  openModal(`<h2>${t ? '여행 수정' : '새 여행'}</h2>
    <label>국내 / 해외</label>
    <div class="seg" id="regionSeg"><button data-v="domestic">🇰🇷 국내</button><button data-v="overseas">🌏 해외</button></div>
    <label>여행 이름</label><input id="fTitle" value="${esc(e.title)}" placeholder="예: 제주 가족여행">
    <label>목적지 (도시)</label><input id="fDest" value="${esc(e.dest)}" placeholder="예: 제주 / 오사카">
    <div class="row"><div class="grow"><label>시작</label><input type="date" id="fStart" value="${e.start}"></div>
    <div class="grow"><label>끝</label><input type="date" id="fEnd" value="${e.end}"></div></div>
    <div id="fxBox"><div class="row"><div class="grow"><label>현지 통화</label><input id="fCur" value="${esc(e.currency === 'KRW' ? '' : e.currency)}" placeholder="JPY"></div>
    <div class="grow"><label>1 통화당 원화</label><input id="fRate" type="number" step="any" value="${e.rate}"></div></div>
    <button class="btn sm" id="fFx" style="margin-top:8px">오늘 환율 불러오기</button> <span class="muted" id="fFxMsg"></span></div>
    <label>같이 가는 사람 (쉼표로 구분, 정산용 · 비워도 돼요)</label><input id="fMem" value="${esc(e.members.join(', '))}" placeholder="예: 나, 민수, 지영">
    <div style="height:16px"></div>
    <button class="btn primary block" id="fSave">저장</button>
    ${t ? `<button class="btn danger block" id="fDel" style="margin-top:8px">여행 삭제</button>` : ''}`);
  let region = e.region;
  const paint = () => { document.querySelectorAll('#regionSeg button').forEach(b => b.classList.toggle('on', b.dataset.v === region)); $('#fxBox').hidden = region === 'domestic'; };
  document.querySelectorAll('#regionSeg button').forEach(b => b.onclick = () => { region = b.dataset.v; paint(); });
  paint();
  $('#fFx').onclick = async () => {
    const cur = $('#fCur').value.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(cur)) return alert('통화 코드 3글자를 입력해 주세요 (예: JPY, USD)');
    $('#fFxMsg').textContent = '불러오는 중…';
    try {
      const r = await (await fetch('https://open.er-api.com/v6/latest/' + cur)).json();
      if (!r.rates?.KRW) throw 0;
      $('#fRate').value = +r.rates.KRW.toFixed(4); $('#fFxMsg').textContent = '기준환율 (실제 환전·카드 환율과 달라요)';
    } catch { $('#fFxMsg').textContent = '환율을 불러오지 못했어요'; }
  };
  $('#fSave').onclick = () => {
    const v = { title: $('#fTitle').value.trim(), dest: $('#fDest').value.trim(), region, start: $('#fStart').value, end: $('#fEnd').value,
      currency: region === 'domestic' ? 'KRW' : ($('#fCur').value.trim().toUpperCase() || 'KRW'), rate: region === 'domestic' ? 1 : (+$('#fRate').value || 1),
      members: [...new Set($('#fMem').value.split(',').map(s => s.trim()).filter(Boolean))] };
    if (!v.title || !v.start || !v.end) return alert('이름과 날짜를 입력해 주세요');
    if (v.end < v.start) return alert('끝 날짜가 시작보다 빨라요');
    const destChanged = !t || t.dest !== v.dest || t.region !== v.region;
    let trip;
    if (t) {
      // 날짜가 바뀌면 일정·기록을 "며칠째" 기준으로 새 날짜에 옮김 (줄어든 날의 일정은 마지막 날로)
      if (t.start !== v.start || t.end !== v.end) {
        const od = days(t), nd = days(v), plan = {}, diary = {};
        const idx = d => Math.min(Math.max(od.indexOf(d), 0), nd.length - 1);
        Object.keys(t.plan).sort().forEach(d => { if (t.plan[d]?.length) (plan[nd[idx(d)]] ||= []).push(...t.plan[d]); });
        Object.keys(t.diary).sort().forEach(d => {
          const e = t.diary[d], k = nd[idx(d)], x = (diary[k] ||= {});
          if (e.text) x.text = x.text ? x.text + '\n' + e.text : e.text;
          if (e.photos?.length) x.photos = [...(x.photos || []), ...e.photos];
        });
        t.plan = plan; t.diary = diary;
      }
      Object.assign(t, v); trip = t;
    } else { trip = norm({ id: uid(), ...v }); trips.push(trip); }
    if (destChanged) trip.center = null;
    persist(); closeModal();
    if (destChanged && v.dest) locateDest(trip); // 추천 기준 좌표 (실패해도 무시)
    t ? route() : (location.hash = '#/trip/' + trip.id);
  };
  if (t) $('#fDel').onclick = () => {
    if (!confirm(`'${t.title}' 여행을 삭제할까요? 일정·가계부·사진이 모두 지워지고 되돌릴 수 없어요.`)) return;
    Object.values(t.diary).forEach(d => (d.photos || []).forEach(id => photoDel(id).catch(() => { })));
    trips = trips.filter(x => x !== t); persist(); closeModal(); location.hash = '';
  };
}
async function locateDest(t) {
  try { const r = await searchPlaces(t.region, t.dest); if (r[0]) { t.center = { lat: r[0].lat, lng: r[0].lng }; persist(); } } catch { }
}

/* ================= 여행 상세 ================= */
const TABS = [['plan', '일정'], ['map', '지도'], ['rec', '추천'], ['saved', '찜'], ['check', '준비물'], ['money', '가계부'], ['diary', '기록']];
function tripView(t) {
  $('#title').textContent = t.title;
  $('#view').innerHTML = `<div class="card"><div class="row"><div class="grow">
      <span class="badge ${t.region}">${t.region === 'domestic' ? '국내' : '해외'}</span><span class="muted">${esc(t.dest)}</span>
      <div class="muted">${t.start} ~ ${t.end} · ${days(t).length}일${t.members.length > 1 ? ` · ${t.members.length}명` : ''}</div></div>
      <button class="btn sm" id="editTrip">수정</button></div></div>
    <div class="tabs"><div class="chips" id="tabs">${TABS.map(([k, n]) => `<button class="chip ${k === tab ? 'on' : ''}" data-v="${k}">${n}${k === 'saved' && t.saved.length ? ` ${t.saved.length}` : ''}</button>`).join('')}</div></div>
    <div id="tabBody"></div>`;
  $('#editTrip').onclick = () => tripForm(t);
  document.querySelectorAll('#tabs button').forEach(b => b.onclick = () => { tab = b.dataset.v; tripView(t); });
  $('#tabs .on')?.scrollIntoView({ block: 'nearest', inline: 'center' });
  ({ plan: planTab, map: mapTab, rec: recTab, saved: savedTab, check: checkTab, money: moneyTab, diary: diaryTab })[tab](t, $('#tabBody'));
}

/* ---------- 일정 ---------- */
function planTab(t, el) {
  el.innerHTML = days(t).map((d, i) => {
    const items = t.plan[d] || [];
    return `<div class="day-h"><h3><span class="dot" style="background:${DAY_COLORS[i % DAY_COLORS.length]}"></span>Day ${i + 1} <span class="muted">${fmtDay(d)}</span></h3>
      <button class="btn sm" data-add="${d}">+ 장소</button></div>
      <div class="card" data-daycard="${d}">${items.length ? items.map((it, j) => {
        const prev = items[j - 1];
        const leg = prev && prev.lat != null && it.lat != null ? `<div class="leg">↓ 직선거리 ${fmtDist(dist(prev, it))}</div>` : (j ? '<div class="leg">↓</div>' : '');
        return `${leg}<div class="item" data-pos="${d}|${j}">
        <div class="num" style="background:${DAY_COLORS[i % DAY_COLORS.length]}">${j + 1}</div>
        <div class="body"><div class="name">${it.time ? `<span class="muted">${esc(it.time)}</span> ` : ''}${esc(it.name)}</div>
          ${it.address ? `<div class="muted">${esc(it.address)}</div>` : ''}
          ${it.memo ? `<div class="muted">📝 ${esc(it.memo)}</div>` : ''}
          <div class="muted">${it.phone ? `<a href="tel:${esc(it.phone.replace(/[^\d+]/g, ''))}">📞 ${esc(it.phone)}</a> ` : ''}${it.url ? `<a href="${esc(it.url)}" target="_blank" rel="noopener">지도 ↗</a>` : ''}</div></div>
        <div class="ctrl"><button data-up="${d}|${j}" aria-label="위로">▲</button><button class="handle" data-drag aria-label="끌어서 이동">☰</button><button data-down="${d}|${j}" aria-label="아래로">▼</button><button data-edit="${d}|${j}" aria-label="수정">✎</button></div>
      </div>`; }).join('') : '<div class="muted">아직 일정이 없어요</div>'}</div>`;
  }).join('');
  el.querySelectorAll('[data-add]').forEach(b => b.onclick = () => placeSearch(t, b.dataset.add));
  const mv = (key, dir) => { const [d, j] = key.split('|'); const a = t.plan[d]; const k = +j + dir; if (k < 0 || k >= a.length) return; [a[j], a[k]] = [a[k], a[j]]; persist(); tripView(t); };
  el.querySelectorAll('[data-up]').forEach(b => b.onclick = () => mv(b.dataset.up, -1));
  el.querySelectorAll('[data-down]').forEach(b => b.onclick = () => mv(b.dataset.down, 1));
  el.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => { const [d, j] = b.dataset.edit.split('|'); itemForm(t, d, t.plan[d][j]); });
  // ☰ 를 잡고 끌어서 순서 변경 (다른 날짜로도 이동 가능)
  el.querySelectorAll('[data-drag]').forEach(h => h.onpointerdown = e => {
    e.preventDefault();
    const src = h.closest('.item'), [sd, sj] = src.dataset.pos.split('|'), y0 = e.clientY, s0 = scrollY;
    let over = null;
    h.setPointerCapture(e.pointerId); src.classList.add('dragging');
    const end = () => {
      h.onpointermove = h.onpointerup = h.onpointercancel = null;
      if (over) {
        const it = t.plan[sd].splice(+sj, 1)[0];
        if (over.dataset.pos) { const [td, tj] = over.dataset.pos.split('|'); t.plan[td].splice(+tj, 0, it); }
        else (t.plan[over.dataset.daycard] ||= []).push(it);
        persist();
      }
      tripView(t);
    };
    h.onpointermove = ev => {
      src.style.transform = `translateY(${ev.clientY - y0 + scrollY - s0}px)`;
      const hit = document.elementFromPoint(ev.clientX, ev.clientY);
      let tgt = hit?.closest('.item[data-pos]') || hit?.closest('[data-daycard]');
      if (tgt === src || (tgt && !tgt.dataset.pos && tgt.dataset.daycard === sd)) tgt = null;
      if (over !== tgt) { over?.classList.remove('drop'); over = tgt; over?.classList.add('drop'); }
      if (ev.clientY < 110) scrollBy(0, -14); else if (ev.clientY > innerHeight - 70) scrollBy(0, 14);
    };
    h.onpointerup = end;
    h.onpointercancel = () => { over = null; end(); };
  });
}

function placeSearch(t, day) {
  openModal(`<h2>장소 추가 <span class="muted">${fmtDay(day)}</span></h2>
    <div class="muted">${t.region === 'domestic' ? '카카오' : 'Google'} 장소 검색</div>
    <div class="row" style="margin-top:8px"><input class="grow" id="q" placeholder="예: ${t.region === 'domestic' ? '성산일출봉' : '도톤보리'}">
    <button class="btn primary" id="qBtn">검색</button></div>
    <div id="qRes" style="margin-top:8px"></div>
    ${t.saved.length ? `<button class="btn block" id="fromSaved" style="margin-top:12px">♥ 찜한 장소에서 고르기 (${t.saved.length})</button>` : ''}
    <button class="btn block" id="manual" style="margin-top:8px">직접 입력</button>`);
  const pick = { label: '추가', cls: 'primary', fn: p => itemForm(t, day, null, pure(p)) };
  const run = async () => {
    const q = $('#q').value.trim(); if (!q) return;
    $('#qRes').innerHTML = '<div class="muted">검색 중…</div>';
    try {
      // 해외는 도시 이름을 붙여야 엉뚱한 나라 결과가 덜 나옴
      const query = t.region === 'overseas' && t.dest && !q.includes(t.dest) ? `${q} ${t.dest}` : q;
      renderPlaces($('#qRes'), await searchPlaces(t.region, query), [saveAction(t), pick]);
    } catch (e) { $('#qRes').innerHTML = `<div class="note">${esc(e.message)}</div>`; }
  };
  $('#qBtn').onclick = run;
  $('#q').onkeydown = e => { if (e.key === 'Enter') run(); };
  $('#manual').onclick = () => itemForm(t, day, null, { name: $('#q').value.trim() });
  $('#fromSaved')?.addEventListener('click', () => renderPlaces($('#qRes'), t.saved, [pick]));
  setTimeout(() => $('#q')?.focus(), 50);
}

function itemForm(t, day, item, place) {
  const e = item || { time: '', memo: '', ...place };
  openModal(`<h2>${item ? '일정 수정' : '일정 추가'}</h2>
    <label>날짜</label><select id="iDay">${days(t).map((d, i) => `<option value="${d}" ${d === day ? 'selected' : ''}>Day ${i + 1} · ${fmtDay(d)}</option>`).join('')}</select>
    <label>장소 이름</label><input id="iName" value="${esc(e.name)}">
    <label>시간</label><input id="iTime" type="time" value="${esc(e.time)}">
    <label>메모</label><textarea id="iMemo" rows="2">${esc(e.memo)}</textarea>
    <div style="height:16px"></div>
    <button class="btn primary block" id="iSave">저장</button>
    ${item ? '<button class="btn danger block" id="iDel" style="margin-top:8px">삭제</button>' : ''}`);
  $('#iSave').onclick = () => {
    const name = $('#iName').value.trim(); if (!name) return alert('장소 이름을 입력해 주세요');
    const nd = $('#iDay').value;
    const v = { ...e, id: item ? e.id : uid(), name, time: $('#iTime').value, memo: $('#iMemo').value.trim() };
    if (item && nd === day && v.time === (item.time || '')) {
      t.plan[day][t.plan[day].indexOf(item)] = v; // 날짜·시간이 그대로면 자리 유지 (끌어서 바꾼 순서 보존)
    } else {
      if (item) t.plan[day] = t.plan[day].filter(x => x !== item);
      const a = (t.plan[nd] ||= []);
      // 시간이 있으면 더 늦은 일정 바로 앞에, 없으면 맨 뒤에. 다른 일정 순서는 건드리지 않음
      const at = v.time ? a.findIndex(x => x.time && x.time > v.time) : -1;
      at < 0 ? a.push(v) : a.splice(at, 0, v);
    }
    persist(); closeModal(); tab = 'plan'; tripView(t);
  };
  if (item) $('#iDel').onclick = () => { t.plan[day] = t.plan[day].filter(x => x !== item); persist(); closeModal(); tripView(t); };
}

/* ---------- 지도 ---------- */
async function mapTab(t, el) {
  const ds = days(t);
  el.innerHTML = `<div class="chips"><button class="chip ${mapDay === 'all' ? 'on' : ''}" data-d="all">전체</button>
    ${ds.map((d, i) => `<button class="chip ${mapDay === d ? 'on' : ''}" data-d="${d}">Day ${i + 1}</button>`).join('')}</div>
    <div id="map"></div><div id="mapMsg"></div><div class="card" id="mapList" style="margin-top:12px"></div>`;
  el.querySelectorAll('[data-d]').forEach(b => b.onclick = () => { mapDay = b.dataset.d; mapTab(t, el); });
  const groups = ds.map((d, i) => ({ d, i, color: DAY_COLORS[i % DAY_COLORS.length], pts: (t.plan[d] || []).map((it, j) => ({ ...it, n: j + 1 })).filter(it => it.lat != null) }))
    .filter(g => (mapDay === 'all' || g.d === mapDay) && g.pts.length);
  $('#mapList').innerHTML = groups.length ? groups.map(g => `<div style="margin-bottom:8px"><b><span class="dot" style="background:${g.color}"></span>Day ${g.i + 1}</b>
    <div class="muted">${g.pts.map(p => `${p.n}. ${esc(p.name)}`).join(' → ')}</div></div>`).join('') : '<div class="muted">지도에 표시할 장소가 없어요. 일정에서 검색으로 장소를 추가해 주세요. (직접 입력한 장소는 위치 정보가 없어요)</div>';
  if (!groups.length) { $('#map').hidden = true; return; }
  const div = $('#map');
  try {
    if (t.region === 'domestic') {
      await loadKakao();
      if (!div.isConnected) return;
      const k = window.kakao.maps, first = groups[0].pts[0];
      const map = new k.Map(div, { center: new k.LatLng(first.lat, first.lng), level: 5 });
      const bounds = new k.LatLngBounds(); let cnt = 0;
      groups.forEach(g => {
        const path = g.pts.map(p => new k.LatLng(p.lat, p.lng));
        path.forEach((pos, j) => { bounds.extend(pos); cnt++; new k.CustomOverlay({ position: pos, content: `<div class="pin" style="background:${g.color}">${g.pts[j].n}</div>`, yAnchor: 0.5 }).setMap(map); });
        if (path.length > 1) new k.Polyline({ path, strokeWeight: 4, strokeColor: g.color, strokeOpacity: 0.85 }).setMap(map);
      });
      if (cnt > 1) map.setBounds(bounds);
    } else {
      await loadGoogle();
      const [{ Map, Polyline }, { Marker }, { LatLngBounds }] = await Promise.all(['maps', 'marker', 'core'].map(l => window.google.maps.importLibrary(l)));
      if (!div.isConnected) return;
      const first = groups[0].pts[0];
      const map = new Map(div, { center: { lat: first.lat, lng: first.lng }, zoom: 14, disableDefaultUI: true, zoomControl: true, gestureHandling: 'greedy' });
      const bounds = new LatLngBounds(); let cnt = 0;
      groups.forEach(g => {
        const path = g.pts.map(p => ({ lat: p.lat, lng: p.lng }));
        path.forEach((pos, j) => {
          bounds.extend(pos); cnt++;
          new Marker({ map, position: pos, title: g.pts[j].name, label: { text: String(g.pts[j].n), color: '#fff', fontWeight: '700' },
            icon: { path: 0 /* CIRCLE */, scale: 13, fillColor: g.color, fillOpacity: 1, strokeColor: '#fff', strokeWeight: 2 } });
        });
        if (path.length > 1) new Polyline({ map, path, strokeColor: g.color, strokeWeight: 4, strokeOpacity: 0.85 });
      });
      if (cnt > 1) map.fitBounds(bounds, 40);
    }
  } catch (e) { div.hidden = true; $('#mapMsg').innerHTML = `<div class="note">${esc(e.message)}</div>`; }
}

/* ---------- 추천 ---------- */
function recTab(t, el) {
  const spots = days(t).flatMap(d => (t.plan[d] || []).filter(x => x.lat != null)).filter((x, i, a) => a.findIndex(y => y.name === x.name) === i);
  if (recBase !== 'center' && !spots[recBase]) recBase = 'center';
  el.innerHTML = `<label style="margin-top:0">기준 위치</label>
    <select id="base"><option value="center">📍 ${esc(t.dest || '목적지')} 중심</option>
    ${spots.map((s, i) => `<option value="${i}">${esc(s.name)} 주변</option>`).join('')}</select>
    <div class="chips" style="margin-top:12px">${[['food', '🍜 맛집'], ['cafe', '☕ 카페'], ['sight', '🏛 관광지'], ['stay', '🏨 숙소']].map(([k, n]) => `<button class="chip ${k === recCat ? 'on' : ''}" data-c="${k}">${n}</button>`).join('')}</div>
    <div class="muted" style="margin:8px 0">${t.region === 'domestic' ? '카카오 · 정확도순, 반경 2km' : 'Google · 별점과 리뷰 수 기준, 반경 2km'}</div>
    <div class="card" id="recRes"><div class="muted">불러오는 중…</div></div>`;
  $('#base').value = recBase;
  $('#base').onchange = e => { recBase = e.target.value; recTab(t, el); };
  el.querySelectorAll('[data-c]').forEach(b => b.onclick = () => { recCat = b.dataset.c; recTab(t, el); });
  (async () => {
    const box = $('#recRes');
    try {
      let center = recBase === 'center' ? t.center : { lat: spots[recBase].lat, lng: spots[recBase].lng };
      if (!center) { // 키 누락 등의 에러는 그대로 보여줌
        const r = await searchPlaces(t.region, t.dest);
        if (r[0]) { t.center = center = { lat: r[0].lat, lng: r[0].lng }; persist(); }
      }
      if (!center) throw new Error('목적지 위치를 찾지 못했어요. 여행 수정에서 목적지 이름을 확인해 주세요');
      const r = await nearby(t.region, recCat, center);
      if (!box.isConnected) return;
      renderPlaces(box, r, [saveAction(t), { label: '+ 일정', fn: p => itemForm(t, days(t)[0], null, pure(p)) }], '주변에 결과가 없어요');
    } catch (e) { if (box.isConnected) box.innerHTML = `<div class="note">${esc(e.message)}</div>`; }
  })();
}

/* ---------- 찜 ---------- */
function savedTab(t, el) {
  el.innerHTML = `<div class="muted" style="margin-bottom:8px">검색이나 추천에서 ♡ 찜을 누르면 여기에 모여요</div><div class="card" id="savedList"></div>`;
  renderPlaces($('#savedList'), t.saved, [
    { label: '+ 일정', cls: 'primary', fn: p => itemForm(t, days(t)[0], null, pure(p)) },
    { label: '삭제', cls: 'danger', fn: p => { t.saved = t.saved.filter(s => s !== p); persist(); tripView(t); } }
  ], '아직 찜한 장소가 없어요');
}

/* ---------- 준비물 ---------- */
const DEFAULT_CHECK = { domestic: ['신분증', '충전기', '보조배터리', '세면도구', '상비약'], overseas: ['여권', '항공권/e티켓', '환전/트래블카드', '유심·eSIM', '여행자보험', '멀티어댑터', '충전기', '상비약'] };
function checkTab(t, el) {
  const done = t.checklist.filter(c => c.done).length;
  el.innerHTML = `<div class="row"><input class="grow" id="cIn" placeholder="준비물 추가"><button class="btn primary" id="cAdd">추가</button></div>
    <div class="muted" style="margin:10px 0">${done} / ${t.checklist.length} 완료</div>
    <div class="card">${t.checklist.length ? t.checklist.map((c, i) => `<label class="check ${c.done ? 'done' : ''}" style="margin:0;color:inherit;font-size:15px">
      <input type="checkbox" data-i="${i}" ${c.done ? 'checked' : ''}><span class="grow">${esc(c.text)}</span><button class="btn sm danger" data-del="${i}">삭제</button></label>`).join('')
      : `<div class="muted">비어 있어요</div><button class="btn sm" id="cDef" style="margin-top:8px">기본 ${t.region === 'domestic' ? '국내' : '해외'} 준비물 넣기</button>`}</div>`;
  const add = () => { const v = $('#cIn').value.trim(); if (!v) return; t.checklist.push({ id: uid(), text: v, done: false }); persist(); checkTab(t, el); $('#cIn').focus(); };
  $('#cAdd').onclick = add; $('#cIn').onkeydown = e => { if (e.key === 'Enter') add(); };
  el.querySelectorAll('[data-i]').forEach(c => c.onchange = () => { t.checklist[c.dataset.i].done = c.checked; persist(); checkTab(t, el); });
  el.querySelectorAll('[data-del]').forEach(b => b.onclick = e => { e.preventDefault(); t.checklist.splice(b.dataset.del, 1); persist(); checkTab(t, el); });
  $('#cDef')?.addEventListener('click', () => { t.checklist = DEFAULT_CHECK[t.region].map(x => ({ id: uid(), text: x, done: false })); persist(); checkTab(t, el); });
}

/* ---------- 가계부 ---------- */
const CATS = ['식비', '교통', '숙박', '관광', '쇼핑', '기타'];
// 모두 똑같이 나눠 낸다고 보고, 누가 누구에게 얼마 보내면 되는지 계산
function settle(t, krw) {
  const m = t.members, total = t.expenses.reduce((s, x) => s + krw(x), 0), share = total / m.length;
  const bal = m.map(name => ({ name, v: t.expenses.filter(x => (m.includes(x.paidBy) ? x.paidBy : m[0]) === name).reduce((s, x) => s + krw(x), 0) - share }));
  const paid = bal.map(b => ({ name: b.name, paid: b.v + share }));
  const owe = bal.filter(b => b.v < -0.5).map(b => ({ ...b, v: -b.v })), get = bal.filter(b => b.v > 0.5).map(b => ({ ...b }));
  const moves = [];
  for (let i = 0, j = 0; i < owe.length && j < get.length;) {
    const a = Math.min(owe[i].v, get[j].v);
    moves.push({ from: owe[i].name, to: get[j].name, amt: a });
    owe[i].v -= a; get[j].v -= a;
    if (owe[i].v < 0.5) i++; if (get[j].v < 0.5) j++;
  }
  return { share, paid, moves };
}
function moneyTab(t, el) {
  const krw = x => x.currency === 'KRW' ? x.amount : x.amount * t.rate;
  const total = t.expenses.reduce((s, x) => s + krw(x), 0);
  const byCat = CATS.map(c => [c, t.expenses.filter(x => x.cat === c).reduce((s, x) => s + krw(x), 0)]).filter(x => x[1]);
  const multi = t.members.length > 1, st = multi && t.expenses.length ? settle(t, krw) : null;
  el.innerHTML = `<div class="card"><div class="muted">총 지출 (원화 환산)</div><div class="total">${won(total)}</div>
    ${t.region === 'overseas' ? `<div class="muted">환율 1 ${esc(t.currency)} = ${t.rate}원 · 여행 수정에서 변경</div>` : ''}
    ${byCat.length ? `<div class="muted" style="margin-top:8px">${byCat.map(([c, v]) => `${c} ${won(v)}`).join(' · ')}</div>` : ''}</div>
    ${st ? `<div class="card"><b>정산</b> <span class="muted">1인당 ${won(st.share)}</span>
      <div class="muted" style="margin:6px 0">${st.paid.map(p => `${esc(p.name)} ${won(p.paid)} 냄`).join(' · ')}</div>
      ${st.moves.length ? st.moves.map(m => `<div>${esc(m.from)} → ${esc(m.to)} <b>${won(m.amt)}</b></div>`).join('') : '<div>정산할 금액이 없어요</div>'}</div>` : ''}
    <button class="btn primary block" id="eAdd">+ 지출 기록</button>
    <div class="card" style="margin-top:12px">${t.expenses.length ? [...t.expenses].sort((a, b) => b.date.localeCompare(a.date)).map(x => `<div class="result row" data-e="${x.id}" style="cursor:pointer">
      <div class="grow"><b>${esc(x.title)}</b><div class="muted">${x.date} · ${x.cat}${multi ? ` · ${esc(t.members.includes(x.paidBy) ? x.paidBy : t.members[0])} 결제` : ''}</div></div>
      <div style="text-align:right"><b>${x.amount.toLocaleString()} ${esc(x.currency)}</b>${x.currency !== 'KRW' ? `<div class="muted">${won(krw(x))}</div>` : ''}</div></div>`).join('') : '<div class="muted">기록이 없어요</div>'}</div>`;
  $('#eAdd').onclick = () => expenseForm(t);
  el.querySelectorAll('[data-e]').forEach(r => r.onclick = () => expenseForm(t, t.expenses.find(x => x.id === r.dataset.e)));
}
function expenseForm(t, x) {
  const d = days(t), e = x || { title: '', amount: '', currency: t.currency, cat: '식비', date: d.includes(today()) ? today() : d[0], paidBy: t.members[0] };
  const curs = [...new Set([t.currency, 'KRW'])], multi = t.members.length > 1;
  openModal(`<h2>${x ? '지출 수정' : '지출 기록'}</h2>
    <label>내용</label><input id="eTitle" value="${esc(e.title)}" placeholder="예: 라멘">
    <div class="row"><div class="grow"><label>금액</label><input id="eAmt" type="number" inputmode="decimal" step="any" value="${e.amount}"></div>
    <div style="width:110px"><label>통화</label><select id="eCur">${curs.map(c => `<option ${c === e.currency ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></div></div>
    <div class="row"><div class="grow"><label>분류</label><select id="eCat">${CATS.map(c => `<option ${c === e.cat ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
    <div class="grow"><label>날짜</label><input id="eDate" type="date" value="${e.date}"></div></div>
    ${multi ? `<label>결제한 사람</label><select id="ePay">${t.members.map(m => `<option ${m === e.paidBy ? 'selected' : ''}>${esc(m)}</option>`).join('')}</select>` : ''}
    <div style="height:16px"></div><button class="btn primary block" id="eSave">저장</button>
    ${x ? '<button class="btn danger block" id="eDel" style="margin-top:8px">삭제</button>' : ''}`);
  $('#eSave').onclick = () => {
    const v = { title: $('#eTitle').value.trim() || $('#eCat').value, amount: +$('#eAmt').value, currency: $('#eCur').value, cat: $('#eCat').value, date: $('#eDate').value, paidBy: multi ? $('#ePay').value : (e.paidBy || null) };
    if (!v.amount) return alert('금액을 입력해 주세요');
    x ? Object.assign(x, v) : t.expenses.push({ id: uid(), ...v });
    persist(); closeModal(); tripView(t);
  };
  if (x) $('#eDel').onclick = () => { t.expenses = t.expenses.filter(y => y !== x); persist(); closeModal(); tripView(t); };
}

/* ---------- 기록 (일기 + 사진) ---------- */
function diaryTab(t, el) {
  el.innerHTML = days(t).map((d, i) => {
    const e = t.diary[d] || {};
    return `<div class="day-h"><h3>Day ${i + 1} <span class="muted">${fmtDay(d)}</span></h3>
      <label class="btn sm" style="margin:0;color:inherit">+ 사진<input type="file" accept="image/*" multiple hidden data-ph="${d}"></label></div>
      <div class="card"><textarea rows="3" data-txt="${d}" placeholder="오늘 어땠나요?">${esc(e.text || '')}</textarea>
      <div class="photos" data-grid="${d}"></div></div>`;
  }).join('') + `<div class="muted" style="margin-top:8px">사진을 누르면 크게 보거나 지울 수 있어요. 사진은 이 기기에만 저장되고 백업 파일에는 들어가지 않아요.</div>`;
  el.querySelectorAll('[data-txt]').forEach(a => a.onchange = () => { (t.diary[a.dataset.txt] ||= {}).text = a.value; persist(); });
  el.querySelectorAll('[data-ph]').forEach(inp => inp.onchange = async () => {
    const d = inp.dataset.ph, e = (t.diary[d] ||= {}); e.photos ||= [];
    for (const f of inp.files) {
      try { const id = uid(); await photoPut(id, await shrink(f)); e.photos.push(id); } catch (err) { alert(err.message || '사진 저장 실패'); }
    }
    persist(); drawPhotos(t, d);
  });
  days(t).forEach(d => drawPhotos(t, d));
}
async function drawPhotos(t, d) {
  const grid = document.querySelector(`[data-grid="${d}"]`); if (!grid) return;
  const ids = t.diary[d]?.photos || [];
  grid.innerHTML = '';
  for (const id of ids) {
    const blob = await photoGet(id).catch(() => null); if (!blob || !grid.isConnected) continue;
    const img = document.createElement('img'); img.src = URL.createObjectURL(blob); img.alt = '';
    img.onclick = () => {
      openModal(`<img src="${img.src}" alt="" style="width:100%;border-radius:12px"><button class="btn danger block" id="phDel" style="margin-top:8px">사진 삭제</button><button class="btn block" id="phClose" style="margin-top:8px">닫기</button>`);
      $('#phClose').onclick = closeModal;
      $('#phDel').onclick = () => { t.diary[d].photos = t.diary[d].photos.filter(x => x !== id); persist(); photoDel(id).catch(() => { }); closeModal(); drawPhotos(t, d); };
    };
    grid.appendChild(img);
  }
}

/* ================= 설정 ================= */
function settingsView() {
  $('#title').textContent = '설정';
  $('#view').innerHTML = `<div class="card"><h3 style="margin-top:0">🇰🇷 카카오 (국내 검색·지도)</h3>
    <label>JavaScript 키</label><input id="sK" value="${esc(settings.kakaoKey)}" autocomplete="off">
    <div class="note" style="margin-top:8px">developers.kakao.com → 내 애플리케이션 → 앱 키의 <b>JavaScript 키</b>.<br>플랫폼 → Web에 이 앱 주소를 등록해야 동작해요. 카카오맵 사용 설정도 켜 주세요.</div></div>
    <div class="card"><h3 style="margin-top:0">🌏 Google (해외 검색·지도)</h3>
    <label>API 키</label><input id="sG" value="${esc(settings.googleKey)}" autocomplete="off">
    <div class="note" style="margin-top:8px">console.cloud.google.com → <b>Maps JavaScript API</b>와 <b>Places API (New)</b> 사용 설정 → 사용자 인증 정보에서 API 키 생성.<br>키 제한에서 <b>웹사이트 제한</b>에 이 앱 주소만 넣어 두세요.</div></div>
    <button class="btn primary block" id="sSave">저장</button>
    <div class="card" style="margin-top:20px"><h3 style="margin-top:0">백업</h3>
    <div class="muted">데이터는 이 기기에만 저장돼요. 가끔 백업해 두세요. (사진은 백업에 포함되지 않아요)</div>
    <div class="row" style="margin-top:10px"><button class="btn grow" id="exp">내보내기</button><button class="btn grow" id="imp">가져오기</button></div>
    <input type="file" id="impFile" accept="application/json" hidden></div>`;
  $('#sSave').onclick = () => {
    const k = $('#sK').value.trim(), g = $('#sG').value.trim();
    const changed = k !== settings.kakaoKey || g !== settings.googleKey;
    settings = { kakaoKey: k, googleKey: g }; save(SKEY, settings);
    if (changed && (kakaoReady || googleReady)) { alert('저장했어요. 바뀐 키를 적용하려고 앱을 새로 고칠게요.'); location.reload(); } else alert('저장했어요');
  };
  $('#exp').onclick = async () => {
    const name = `내여행-백업-${today()}.json`, json = JSON.stringify(trips, null, 1);
    // 아이폰 홈 화면 앱에서는 파일 다운로드가 잘 안 돼서 공유 시트(파일에 저장)를 먼저 시도
    try {
      const file = new File([json], name, { type: 'application/json' });
      if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file] }); return; }
    } catch (e) { if (e.name === 'AbortError') return; }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    a.download = name; a.click();
  };
  $('#imp').onclick = () => $('#impFile').click();
  $('#impFile').onchange = async e => {
    try { const d = JSON.parse(await e.target.files[0].text()); if (!Array.isArray(d)) throw 0;
      if (confirm(`여행 ${d.length}개를 가져올까요? 지금 데이터는 덮어써져요.`)) { trips = d.map(norm); persist(); location.hash = ''; route(); }
    } catch { alert('백업 파일을 읽지 못했어요'); }
  };
}

route();
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => { });
