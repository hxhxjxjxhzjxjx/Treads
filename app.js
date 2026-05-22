'use strict';

/* =========================================================
 * Калькулятор раскроя труб для сварных изделий
 * Полностью офлайн ES6 (без внешних библиотек).
 * ========================================================= */

// ----- DOM helpers -----
const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const fmtNum = (n) => Math.round(n).toLocaleString('ru-RU');
const fmtPct = (n, d = 2) => (n * 100).toFixed(d) + '%';
function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// ----- Constants -----
const MAX_SEG_HARD = 9500;
const MIN_SEG_ADD = 1000;
const MAX_ADD_RATIO = 0.4;
const HISTORY_KEY = 'pipe-cutter:history';
const INPUT_KEY = 'pipe-cutter:lastInput';
const MAX_HISTORY = 200;

// Цвет = функция от (productIdx, role).
// Основная часть — насыщенный «product-цвет», доп.1 — контрастный к нему,
// доп.2 — третий оттенок. Для большего числа изделий — генератор по HSL.
const PRODUCT_PALETTES = [
  { main: '#2e7d32', add1: '#1976d2', add2: '#42a5f5' }, // 1: зелёный + синий
  { main: '#ef6c00', add1: '#fbc02d', add2: '#ffd54f' }, // 2: оранжевый + жёлтый
  { main: '#6a1b9a', add1: '#c2185b', add2: '#ec407a' }, // 3: фиолетовый + розовый
  { main: '#00838f', add1: '#26a69a', add2: '#80cbc4' }, // 4: бирюзовый + мятный
  { main: '#5d4037', add1: '#a1887f', add2: '#bcaaa4' }, // 5: коричневый + бежевый
  { main: '#455a64', add1: '#78909c', add2: '#b0bec5' }, // 6: серый + сталь
  { main: '#827717', add1: '#9e9d24', add2: '#cddc39' }, // 7: оливковый + лайм
  { main: '#d84315', add1: '#ff7043', add2: '#ffab91' }  // 8: терракот + лосось
];
function colorFor(productIdx, role) {
  if (productIdx < PRODUCT_PALETTES.length) {
    const p = PRODUCT_PALETTES[productIdx];
    return p[role] || p.main;
  }
  // Фоллбэк: генерируем по HSL
  const hue = (productIdx * 47) % 360;
  const sat = role === 'main' ? 55 : 65;
  const lit = role === 'main' ? 38 : role === 'add1' ? 50 : 62;
  return `hsl(${hue}, ${sat}%, ${lit}%)`;
}
const WASTE_COLOR = '#b0b0b0';
const ROLE_LABEL = { main: 'осн.', add1: 'доп.1', add2: 'доп.2' };

const DEFAULT_INPUT = {
  name: '',
  lNom: 11500,
  delta: 100,
  seams: 1,
  products: [
    { length: 11080, count: 192 },
    { length: 12120, count: 192 }
  ]
};

// ----- App state -----
const state = {
  result: null
};

// =========================================================
// ALGORITHM
// =========================================================

/**
 * Возвращает массив допустимых разбиений изделия L_i, отсортированных:
 *   1) основная часть L_main по убыванию;
 *   2) при равенстве — сумма Σдоп по возрастанию.
 * Каждый элемент: { main, adds: [add1] | [add1, add2], sumAdds }.
 * Параметр K — максимальное число возвращаемых уникальных кандидатов.
 */
function getCandidatePartitions(L_i, seams, L_calc, K = 5) {
  if (L_i <= 0 || K <= 0) return [];
  const maxSeg = Math.min(MAX_SEG_HARD, L_calc);
  const all = [];

  if (seams === 1) {
    const lowMain = Math.max(MIN_SEG_ADD, Math.ceil(L_i / (1 + MAX_ADD_RATIO)));
    const highMain = Math.min(maxSeg, L_i - MIN_SEG_ADD);
    for (let main = highMain; main >= lowMain; main--) {
      const add = L_i - main;
      if (add < MIN_SEG_ADD) continue;
      if (add > maxSeg) continue;
      if (add > MAX_ADD_RATIO * main + 1e-9) continue;
      all.push({ main, adds: [add], sumAdds: add });
    }
  } else if (seams === 2) {
    const lowMain = Math.max(MIN_SEG_ADD, Math.ceil(L_i / (1 + 2 * MAX_ADD_RATIO)));
    const highMain = Math.min(maxSeg, L_i - 2 * MIN_SEG_ADD);
    for (let main = highMain; main >= lowMain; main--) {
      const sumAdds = L_i - main;
      const maxAdd = Math.min(Math.floor(MAX_ADD_RATIO * main), maxSeg);
      // Чтобы избежать дублей add1/add2 — берём add1 ≤ add2 (т.е. add1 ≤ sumAdds/2).
      const lowAdd1 = Math.max(MIN_SEG_ADD, sumAdds - maxAdd);
      const highAdd1 = Math.min(maxAdd, Math.floor(sumAdds / 2));
      if (lowAdd1 > highAdd1) continue;
      // Сбалансированный (add1 ≈ add2) кандидат идёт первым — даёт более «удобные» равные отрезки.
      const seen = new Set();
      const balanced = Math.max(lowAdd1, Math.min(highAdd1, Math.floor(sumAdds / 2)));
      for (const a1 of [balanced, lowAdd1, highAdd1]) {
        if (seen.has(a1)) continue;
        seen.add(a1);
        const a2 = sumAdds - a1;
        if (a1 < MIN_SEG_ADD || a1 > maxAdd) continue;
        if (a2 < MIN_SEG_ADD || a2 > maxAdd) continue;
        const adds = a1 <= a2 ? [a1, a2] : [a2, a1];
        all.push({ main, adds, sumAdds });
      }
    }
  }

  if (!all.length) return [];

  // Сортировка: основная ↓, сумма доп. ↑, затем равномерность ↑ (предпочесть [a1,a2] ближе друг к другу).
  all.sort((a, b) => {
    if (b.main !== a.main) return b.main - a.main;
    if (a.sumAdds !== b.sumAdds) return a.sumAdds - b.sumAdds;
    const sa = a.adds.length === 2 ? Math.abs(a.adds[1] - a.adds[0]) : 0;
    const sb = b.adds.length === 2 ? Math.abs(b.adds[1] - b.adds[0]) : 0;
    return sa - sb;
  });

  // K = 1 — вернуть только лучшее разбиение (макс. основная).
  if (K === 1) {
    return [all[0]];
  }

  // Для перебора собираем разнообразные варианты по основной длине:
  // - всегда включаем лучший (максимальная основная);
  // - дополнительно семплируем равномерно по диапазону main-значений,
  //   чтобы охватить как «длинные доп.», так и «короткие доп.».
  const byMainDesc = [];
  const seenMain = new Set();
  for (const p of all) {
    if (seenMain.has(p.main)) continue;
    seenMain.add(p.main);
    byMainDesc.push(p);
  }
  const sample = [byMainDesc[0]];
  if (byMainDesc.length > 1 && K > 1) {
    const step = (byMainDesc.length - 1) / (K - 1);
    for (let i = 1; i < K; i++) {
      const idx = Math.min(byMainDesc.length - 1, Math.round(i * step));
      const cand = byMainDesc[idx];
      if (!sample.includes(cand)) sample.push(cand);
    }
  }
  return sample.slice(0, K);
}

/**
 * Совместимая обёртка над getCandidatePartitions: вернуть лучший единственный вариант.
 */
function findBestPartition(L_i, seams, L_calc) {
  const cands = getCandidatePartitions(L_i, seams, L_calc, 1);
  return cands.length ? { main: cands[0].main, adds: cands[0].adds } : null;
}

/**
 * Формирует список типоразмеров. Каждый тип однозначно соответствует
 * (productIdx, role) — это даёт ясную атрибуцию в плане раскроя.
 * Если несколько (изделие, роль) имеют одинаковую длину, они остаются
 * отдельными типами — это допустимо по спецификации.
 */
function buildTypeList(products, partitions) {
  const types = [];
  products.forEach((p, idx) => {
    const part = partitions[idx];
    if (!part) return;
    types.push({ length: part.main, count: p.count, productIdx: idx, role: 'main' });
    part.adds.forEach((a, i) => {
      types.push({ length: a, count: p.count, productIdx: idx, role: 'add' + (i + 1) });
    });
  });
  // FFD требует сортировки по убыванию длины. Тай-брейк — productIdx, чтобы
  // одинаковые длины разных изделий обрабатывались устойчиво.
  return types.sort((a, b) => b.length - a.length || a.productIdx - b.productIdx);
}

/**
 * Решает задачу раскроя жадным FFD по убыванию длин.
 * Пакеты идентичных длин обрабатываются батчем — это ускоряет работу
 * при больших count, но даёт тот же результат, что и поштучный FFD.
 *
 * Возвращает { patterns, totalPipes, totalWaste, algorithm }.
 */
function solveCuttingFFD(typeList, L_calc) {
  // Список «открытых» труб: { used, contents: Map<typeIdx, count> }
  const pipes = [];
  // Индекс по «оставшейся вместимости» (без структуры — наивный поиск).
  // Для удобства мы группируем одинаковые отрезки.

  const types = typeList.map((t, idx) => ({ length: t.length, count: t.count, idx }));

  for (const t of types) {
    let remaining = t.count;
    if (remaining <= 0) continue;

    // 1) Раскидываем по уже открытым трубам, пока туда вмещается.
    for (const pipe of pipes) {
      if (remaining <= 0) break;
      const free = L_calc - pipe.used;
      if (free < t.length) continue;
      const canFit = Math.floor(free / t.length);
      const place = Math.min(canFit, remaining);
      if (place > 0) {
        pipe.used += place * t.length;
        pipe.contents.set(t.idx, (pipe.contents.get(t.idx) || 0) + place);
        remaining -= place;
      }
    }

    // 2) Оставшиеся пускаем в новые трубы; пока длина одного отрезка ≤ L_calc,
    //    в одну трубу помещается floor(L_calc / t.length) одинаковых отрезков.
    if (remaining > 0) {
      if (t.length > L_calc) {
        // Не должно случиться при корректных partitions.
        throw new Error(`Отрезок ${t.length} мм не помещается в трубу ${L_calc} мм`);
      }
      const perPipe = Math.floor(L_calc / t.length);
      while (remaining > 0) {
        const place = Math.min(perPipe, remaining);
        const pipe = { used: place * t.length, contents: new Map([[t.idx, place]]) };
        pipes.push(pipe);
        remaining -= place;
      }
    }
  }

  return aggregatePatterns(pipes, typeList, L_calc, 'ffd');
}

/**
 * Группирует трубы с одинаковым составом (мультимножеством typeIdx)
 * в одну строку плана раскроя.
 */
function aggregatePatterns(pipes, typeList, L_calc, algorithm) {
  const map = new Map();
  for (const pipe of pipes) {
    // Каноничный ключ — отсортированный список typeIdx с количествами
    const entries = Array.from(pipe.contents.entries()).sort((a, b) => a[0] - b[0]);
    const key = entries.map(([k, v]) => k + ':' + v).join('|');
    if (!map.has(key)) {
      const composition = {};
      for (const [k, v] of entries) composition[k] = v;
      const usedLen = entries.reduce((s, [k, v]) => s + typeList[k].length * v, 0);
      map.set(key, {
        composition,
        used: usedLen,
        waste: L_calc - usedLen,
        count: 0
      });
    }
    map.get(key).count += 1;
  }
  const patterns = Array.from(map.values());
  // Сортируем: чаще используемые сверху, при равенстве — меньший отход
  patterns.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return a.waste - b.waste;
  });
  const totalPipes = pipes.length;
  const totalWaste = patterns.reduce((s, p) => s + p.waste * p.count, 0);
  return { patterns, totalPipes, totalWaste, algorithm };
}

/**
 * Подобрать партицию для каждого изделия. Используется в обычном режиме
 * (одно лучшее разбиение). Возвращает массив { main, adds } и список ошибок.
 */
function planPartitions(products, seams, L_calc) {
  const partitions = [];
  const problems = [];
  products.forEach((p, idx) => {
    const part = findBestPartition(p.length, seams, L_calc);
    if (!part) {
      const alt = findBestPartition(p.length, seams === 1 ? 2 : 1, L_calc);
      let msg = `Изделие ${idx + 1} (${fmtNum(p.length)} мм): не удалось подобрать разбиение `
              + `для ${seams === 1 ? '1 шва' : '2 швов'} в трубе ${fmtNum(L_calc)} мм.`;
      if (alt) {
        msg += ` Попробуйте ${seams === 1 ? '2 шва' : '1 шов'} — там есть допустимое разбиение.`;
      } else {
        msg += ` Также нет допустимого разбиения для ${seams === 1 ? '2 швов' : '1 шва'}.`;
      }
      problems.push(msg);
    }
    partitions.push(part);
  });
  return { partitions, problems };
}

/**
 * Перебор комбинаций кандидатов разбиений по изделиям (декартово произведение)
 * с ограничением общего числа комбинаций.
 * Возвращает массив массивов partitions (по индексам изделий).
 */
function enumerateCombos(candidatesPerProduct, maxCombos) {
  if (!candidatesPerProduct.length) return [];
  // Если у какого-то изделия нет кандидатов — комбинаций нет.
  if (candidatesPerProduct.some(c => !c.length)) return [];
  const total = candidatesPerProduct.reduce((a, c) => a * c.length, 1);
  const cap = Math.min(total, maxCombos);
  const combos = [];
  const N = candidatesPerProduct.length;
  const current = new Array(N);
  function rec(idx) {
    if (combos.length >= cap) return;
    if (idx === N) {
      combos.push(current.slice());
      return;
    }
    for (const c of candidatesPerProduct[idx]) {
      current[idx] = c;
      rec(idx + 1);
      if (combos.length >= cap) return;
    }
  }
  rec(0);
  return combos;
}

/**
 * Генерирует все валидные паттерны раскроя (набор отрезков, помещающихся в трубу),
 * с учётом ограничений по спросу на каждый тип.
 * Паттерн — массив длиной N (типов), значения ≥ 0, сумма длин ≤ L_calc.
 * Cap maxPatterns останавливает обход при слишком большом числе вариантов.
 */
function generateAllPatterns(types, L_calc, maxPatterns = 8000) {
  const N = types.length;
  const counts = new Array(N).fill(0);
  const patterns = [];
  let stopped = false;
  function rec(idx, usedLen) {
    if (stopped) return;
    if (idx === N) {
      // Минимум 1 отрезок
      let any = false;
      for (let i = 0; i < N; i++) if (counts[i] > 0) { any = true; break; }
      if (any) {
        patterns.push(counts.slice());
        if (patterns.length >= maxPatterns) stopped = true;
      }
      return;
    }
    const t = types[idx];
    const free = L_calc - usedLen;
    const maxK = Math.min(t.count, Math.floor(free / t.length));
    for (let k = 0; k <= maxK; k++) {
      counts[idx] = k;
      rec(idx + 1, usedLen + k * t.length);
      if (stopped) return;
    }
    counts[idx] = 0;
  }
  rec(0, 0);
  return patterns;
}

/**
 * Точный раскрой: используется полная генерация паттернов + жадный
 * пошаговый выбор по убыванию заполнения (минимум отхода на трубу),
 * с ограничением на остаточный спрос.
 *
 * Это эквивалент столбцовой эвристики LP-релаксации: даёт оптимум или
 * близкое к нему решение при разумном числе паттернов.
 *
 * Возвращает структуру { patterns, totalPipes, totalWaste, algorithm } —
 * совместимую с aggregatePatterns.
 */
function solveExact(typeList, L_calc, opts = {}) {
  const maxPatterns = opts.maxPatterns || 8000;
  const types = typeList.map((t, idx) => ({ length: t.length, count: t.count, idx }));
  const allPatterns = generateAllPatterns(types, L_calc, maxPatterns);
  if (!allPatterns.length) return null;

  // Для каждого паттерна — заполнение и отход.
  const ranked = allPatterns.map(p => {
    const filled = p.reduce((s, c, j) => s + c * types[j].length, 0);
    return { p, filled, waste: L_calc - filled };
  });
  // Сортируем по минимальному отходу.
  ranked.sort((a, b) => a.waste - b.waste);

  const demand = types.map(t => t.count);
  const used = new Map(); // idxInRanked -> count

  while (demand.some(d => d > 0)) {
    // Лучший паттерн, который реально покрывает остаток спроса.
    let chosen = -1;
    let chosenReps = 0;
    for (let r = 0; r < ranked.length; r++) {
      const p = ranked[r].p;
      let maxRepeats = Infinity;
      let useful = false;
      for (let j = 0; j < p.length; j++) {
        if (p[j] === 0) continue;
        useful = true;
        const k = Math.floor(demand[j] / p[j]);
        if (k < maxRepeats) maxRepeats = k;
        if (maxRepeats === 0) break;
      }
      if (!useful || maxRepeats === 0 || maxRepeats === Infinity) continue;
      chosen = r;
      chosenReps = maxRepeats;
      break; // ranked отсортирован по отходу — первый найденный лучший.
    }
    if (chosen < 0) return null; // не покрывается полностью паттернами — fallback на FFD
    used.set(chosen, (used.get(chosen) || 0) + chosenReps);
    const p = ranked[chosen].p;
    for (let j = 0; j < p.length; j++) demand[j] -= p[j] * chosenReps;
  }

  // Собираем результат в формате aggregatePatterns.
  const pipes = [];
  for (const [r, cnt] of used) {
    const p = ranked[r].p;
    const contents = new Map();
    for (let j = 0; j < p.length; j++) if (p[j] > 0) contents.set(j, p[j]);
    const filled = ranked[r].filled;
    for (let i = 0; i < cnt; i++) {
      pipes.push({ used: filled, contents: new Map(contents) });
    }
  }
  return aggregatePatterns(pipes, typeList, L_calc, 'exact');
}

/**
 * Сравнение двух результатов раскроя. Лучше тот, где меньше труб; при равенстве — меньше отход.
 */
function isBetterResult(a, b) {
  if (!b) return true;
  if (a.totalPipes !== b.totalPipes) return a.totalPipes < b.totalPipes;
  return a.totalWaste < b.totalWaste;
}

/**
 * Основная функция: с учётом точного/обычного режима подбирает разбиения
 * и решает раскрой. Возвращает { partitions, typeList, cutResult, combosTried }.
 */
function planAndCut(input, lCalc, exactMode) {
  const K = exactMode ? 5 : 1;
  const maxCombos = exactMode ? 200 : 1;
  const candidates = input.products.map(p =>
    getCandidatePartitions(p.length, input.seams, lCalc, K)
  );

  // Если хоть у одного изделия нет разбиений — ошибка.
  const noVariant = candidates.map((c, i) => c.length === 0 ? i : -1).filter(i => i >= 0);
  if (noVariant.length) {
    const problems = noVariant.map(i => {
      const p = input.products[i];
      const alt = getCandidatePartitions(p.length, input.seams === 1 ? 2 : 1, lCalc, 1);
      let msg = `Изделие ${i + 1} (${fmtNum(p.length)} мм): не удалось подобрать разбиение `
              + `для ${input.seams === 1 ? '1 шва' : '2 швов'} в трубе ${fmtNum(lCalc)} мм.`;
      msg += alt.length
        ? ` Попробуйте ${input.seams === 1 ? '2 шва' : '1 шов'} — там есть допустимое разбиение.`
        : ` Также нет допустимого разбиения для ${input.seams === 1 ? '2 швов' : '1 шва'}.`;
      return msg;
    });
    return { problems };
  }

  const combos = enumerateCombos(candidates, maxCombos);
  const timeBudgetMs = exactMode ? 4500 : 500;
  const t0 = Date.now();

  let best = null;
  let combosTried = 0;
  for (const combo of combos) {
    if (Date.now() - t0 > timeBudgetMs) break;
    combosTried++;
    const partitions = combo.map(c => ({ main: c.main, adds: c.adds }));
    const typeList = buildTypeList(input.products, partitions);
    let cutResult;
    if (exactMode) {
      cutResult = solveExact(typeList, lCalc) || solveCuttingFFD(typeList, lCalc);
    } else {
      cutResult = solveCuttingFFD(typeList, lCalc);
    }
    if (isBetterResult(cutResult, best && best.cutResult)) {
      best = { partitions, typeList, cutResult };
    }
  }

  if (!best) return { problems: ['Не удалось построить ни одного допустимого плана.'] };
  return { partitions: best.partitions, typeList: best.typeList, cutResult: best.cutResult, combosTried };
}

// =========================================================
// UI: PRODUCTS LIST
// =========================================================

function createProductRow(length = '', count = '') {
  const row = document.createElement('div');
  row.className = 'product-row';
  row.innerHTML = `
    <input type="number" class="p-length" min="1" step="1" placeholder="Длина (мм)" value="${length}" required>
    <input type="number" class="p-count" min="1" step="1" placeholder="Кол-во" value="${count}" required>
    <button type="button" class="remove-btn" title="Удалить">✕</button>
  `;
  row.querySelector('.remove-btn').addEventListener('click', () => {
    if ($$('.product-row').length > 1) {
      row.remove();
    } else {
      row.querySelector('.p-length').value = '';
      row.querySelector('.p-count').value = '';
    }
    saveInputState();
  });
  row.querySelector('.p-length').addEventListener('input', saveInputState);
  row.querySelector('.p-count').addEventListener('input', saveInputState);
  return row;
}

function renderProducts(products) {
  const list = $('#products-list');
  list.innerHTML = '';
  const arr = (products && products.length) ? products : [{ length: '', count: '' }];
  arr.forEach(p => list.appendChild(createProductRow(p.length, p.count)));
}

// =========================================================
// UI: FORM I/O
// =========================================================

function readForm() {
  return {
    name: $('#calc-name').value.trim(),
    lNom: parseInt($('#l-nom').value, 10) || 0,
    delta: parseInt($('#delta').value, 10) || 0,
    seams: parseInt(($('input[name="seams"]:checked') || {}).value, 10) || 1,
    products: $$('.product-row').map(row => ({
      length: parseInt(row.querySelector('.p-length').value, 10) || 0,
      count: parseInt(row.querySelector('.p-count').value, 10) || 0
    }))
  };
}

function applyForm(input) {
  $('#calc-name').value = input.name || '';
  $('#l-nom').value = input.lNom;
  $('#delta').value = input.delta;
  $$('input[name="seams"]').forEach(r => r.checked = parseInt(r.value, 10) === input.seams);
  renderProducts(input.products);
  updateLCalcDisplay();
}

function saveInputState() {
  try {
    localStorage.setItem(INPUT_KEY, JSON.stringify(readForm()));
  } catch (e) { /* quota etc. */ }
}

function loadInputState() {
  try {
    const data = JSON.parse(localStorage.getItem(INPUT_KEY) || 'null');
    if (data && typeof data === 'object') return Object.assign({}, DEFAULT_INPUT, data);
  } catch (e) {}
  return DEFAULT_INPUT;
}

function updateLCalcDisplay() {
  const lNom = parseInt($('#l-nom').value, 10) || 0;
  const delta = parseInt($('#delta').value, 10) || 0;
  $('#l-calc-display').textContent = fmtNum(lNom - delta);
}

// =========================================================
// CALCULATION
// =========================================================

function validateInput(input) {
  const errors = [];
  if (input.lNom <= 0) errors.push('Номинальная длина трубы должна быть положительной.');
  if (input.delta < 0) errors.push('Допуск не может быть отрицательным.');
  const lCalc = input.lNom - input.delta;
  if (lCalc <= 0) errors.push(`L_calc = ${lCalc} мм ≤ 0. Проверьте параметры.`);
  if (lCalc < MIN_SEG_ADD) errors.push(`L_calc = ${lCalc} мм меньше минимального отрезка (${MIN_SEG_ADD} мм).`);
  if (!input.products.length) errors.push('Добавьте хотя бы одно изделие.');
  input.products.forEach((p, i) => {
    if (p.length <= 0) errors.push(`Изделие ${i + 1}: длина должна быть положительной.`);
    if (p.count <= 0) errors.push(`Изделие ${i + 1}: количество должно быть положительным.`);
  });
  return { errors, lCalc };
}

async function performCalc() {
  const input = readForm();
  saveInputState();

  const { errors, lCalc } = validateInput(input);
  if (errors.length) {
    showResultError(errors);
    return;
  }

  const exactMode = !!$('#exact-mode').checked;
  showProgress(true, exactMode
    ? 'Перебираем варианты разбиений и патернов…'
    : 'Подбираем разбиения изделий…');
  await sleep(20);

  let plan;
  try {
    plan = planAndCut(input, lCalc, exactMode);
  } catch (e) {
    showResultError([e.message || String(e)]);
    showProgress(false);
    return;
  }
  if (plan.problems && plan.problems.length) {
    showResultError(plan.problems);
    showProgress(false);
    return;
  }

  showProgress(false);
  plan.cutResult.combosTried = plan.combosTried;
  plan.cutResult.exactMode = exactMode;
  renderResult(input, lCalc, plan.partitions, plan.typeList, plan.cutResult);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// =========================================================
// RESULT RENDERING
// =========================================================

function showProgress(show, text = 'Идёт расчёт…') {
  const el = $('#progress');
  el.classList.toggle('hidden', !show);
  if (show) el.querySelector('.progress-text').textContent = text;
  $('#calc-btn').disabled = show;
}

function showResultError(errors) {
  const result = $('#result');
  result.classList.remove('hidden');
  result.innerHTML = `
    <div class="card">
      <div class="error-msg">
        <strong>Не удалось завершить расчёт:</strong>
        <ul>${errors.map(e => `<li>${escapeHTML(e)}</li>`).join('')}</ul>
      </div>
    </div>
  `;
  result.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function describeType(t) {
  return `${ROLE_LABEL[t.role] || t.role} (изд. ${t.productIdx + 1})`;
}

function typeColor(t) {
  return colorFor(t.productIdx, t.role);
}

function getProductColor(productIdx) {
  return colorFor(productIdx, 'main');
}

function renderResult(input, lCalc, partitions, typeList, cutResult) {
  state.result = { input, lCalc, partitions, typeList, cutResult };

  const totalNominal = cutResult.totalPipes * input.lNom;
  const wastePct = totalNominal > 0 ? cutResult.totalWaste / totalNominal : 0;

  const summaryHTML = `
    <div class="card">
      <h2>Итоги расчёта${input.name ? ' — ' + escapeHTML(input.name) : ''}</h2>
      <div class="summary-grid">
        <div class="summary-item">
          <div class="label">Использовано труб</div>
          <div class="value">${fmtNum(cutResult.totalPipes)}</div>
        </div>
        <div class="summary-item">
          <div class="label">Общий отход</div>
          <div class="value">${fmtNum(cutResult.totalWaste)} мм</div>
        </div>
        <div class="summary-item">
          <div class="label">% отхода от L_nom</div>
          <div class="value">${fmtPct(wastePct)}</div>
        </div>
        <div class="summary-item">
          <div class="label">Расчётная длина трубы</div>
          <div class="value">${fmtNum(lCalc)} мм</div>
        </div>
      </div>
      <p class="muted">${cutResult.algorithm === 'exact'
        ? `Алгоритм раскроя: точный перебор паттернов (рассмотрено ${fmtNum(cutResult.combosTried || 1)} комбинаций разбиений).`
        : 'Алгоритм раскроя: First-Fit Decreasing (приближённое решение для cutting-stock).'}</p>
    </div>
  `;

  const productsHTML = `
    <div class="card">
      <h2>Разбиение по изделиям</h2>
      ${input.products.map((p, idx) => {
        const part = partitions[idx];
        const addsStr = part.adds.map((a, i) => {
          const pct = (a / part.main * 100).toFixed(1);
          return `доп.${i + 1} ${fmtNum(a)} мм (${pct}% от осн.)`;
        }).join(', ');
        return `
          <div class="product-summary">
            <div class="ps-title">
              <span class="sw" style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${getProductColor(idx)};margin-right:6px;"></span>
              Изделие ${idx + 1} (${fmtNum(p.length)} мм × ${fmtNum(p.count)})
            </div>
            <div>основная ${fmtNum(part.main)} мм, ${addsStr}</div>
          </div>
        `;
      }).join('')}
    </div>
  `;

  const patternsHTML = renderPatternsTable(input, lCalc, partitions, typeList, cutResult);

  const saveHTML = `
    <div class="card">
      <button id="save-history" class="btn-primary">Сохранить в историю</button>
    </div>
  `;

  const result = $('#result');
  result.classList.remove('hidden');
  result.innerHTML = summaryHTML + productsHTML + patternsHTML + saveHTML;
  $('#save-history').addEventListener('click', saveToHistory);
  result.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderPatternsTable(input, lCalc, partitions, typeList, cutResult) {
  const rows = cutResult.patterns.map((p, idx) => {
    const compEntries = Object.entries(p.composition); // [typeIdxStr, cnt]
    const compString = compEntries.map(([ti, cnt]) => {
      const t = typeList[parseInt(ti, 10)];
      return `${describeType(t)} ×${cnt} (${fmtNum(t.length)} мм)`;
    }).join('; ');
    const visual = renderPatternVisual(p, typeList, lCalc);
    return `
      <tr>
        <td>${idx + 1}</td>
        <td>
          <div>${compString}</div>
          ${visual}
        </td>
        <td>${fmtNum(p.count)}</td>
        <td>${fmtNum(p.waste)} мм</td>
        <td>${fmtNum(p.waste * p.count)} мм</td>
      </tr>
    `;
  }).join('');

  return `
    <div class="card">
      <h2>План раскроя труб</h2>
      <table class="patterns-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Состав и схема раскроя</th>
            <th>Труб, шт</th>
            <th>Отход / труба</th>
            <th>Сум. отход</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
        <tfoot>
          <tr>
            <td colspan="2">Итого</td>
            <td>${fmtNum(cutResult.totalPipes)}</td>
            <td>—</td>
            <td>${fmtNum(cutResult.totalWaste)} мм</td>
          </tr>
        </tfoot>
      </table>
    </div>
  `;
}

function renderPatternVisual(pattern, typeList, lCalc) {
  // Собираем сегменты в порядке убывания длины
  const segs = [];
  for (const [tiStr, cnt] of Object.entries(pattern.composition)) {
    const ti = parseInt(tiStr, 10);
    const t = typeList[ti];
    for (let i = 0; i < cnt; i++) {
      segs.push({
        length: t.length,
        color: typeColor(t),
        label: `${fmtNum(t.length)}`,
        tip: `${describeType(t)} ${fmtNum(t.length)} мм`
      });
    }
  }
  segs.sort((a, b) => b.length - a.length);
  if (pattern.waste > 0) {
    segs.push({
      length: pattern.waste,
      color: WASTE_COLOR,
      label: 'отход ' + fmtNum(pattern.waste),
      tip: 'Отход ' + fmtNum(pattern.waste) + ' мм',
      isWaste: true
    });
  }

  const total = lCalc;
  const barHTML = segs.map(s => {
    const pct = (s.length / total * 100);
    const cls = s.isWaste ? 'seg waste' : 'seg';
    const showLabel = pct >= 6;
    return `<div class="${cls}" style="width:${pct.toFixed(3)}%;background:${s.color}" title="${escapeHTML(s.tip)}">${showLabel ? escapeHTML(s.label) : ''}</div>`;
  }).join('');

  // Легенда (уникальные типы + отход)
  const legendMap = new Map();
  for (const [tiStr] of Object.entries(pattern.composition)) {
    const ti = parseInt(tiStr, 10);
    const t = typeList[ti];
    legendMap.set(ti, { color: typeColor(t), label: `${describeType(t)} — ${fmtNum(t.length)} мм` });
  }
  const legendItems = Array.from(legendMap.values());
  if (pattern.waste > 0) legendItems.push({ color: WASTE_COLOR, label: `отход — ${fmtNum(pattern.waste)} мм` });
  const legendHTML = legendItems.map(l =>
    `<span class="legend-item"><span class="sw" style="background:${l.color}"></span>${escapeHTML(l.label)}</span>`
  ).join('');

  return `
    <div class="pattern-visual">
      <div class="bar">${barHTML}</div>
      <div class="legend">${legendHTML}</div>
    </div>
  `;
}

// =========================================================
// HISTORY
// =========================================================

function loadHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); }
  catch (e) { return []; }
}
function persistHistory(items) {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(items)); }
  catch (e) { /* quota */ }
}

function saveToHistory() {
  if (!state.result) return;
  const items = loadHistory();
  const r = state.result;
  const record = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    timestamp: new Date().toISOString(),
    name: r.input.name || `Без названия (${new Date().toLocaleString('ru-RU')})`,
    input: r.input,
    lCalc: r.lCalc,
    partitions: r.partitions,
    typeList: r.typeList,
    cutResult: r.cutResult
  };
  items.unshift(record);
  if (items.length > MAX_HISTORY) items.length = MAX_HISTORY;
  persistHistory(items);

  const btn = $('#save-history');
  btn.textContent = '✓ Сохранено';
  btn.disabled = true;
  setTimeout(() => {
    if (btn.isConnected) {
      btn.textContent = 'Сохранить в историю';
      btn.disabled = false;
    }
  }, 1800);
}

function renderHistory() {
  const items = loadHistory();
  const container = $('#history-list');
  container.innerHTML = '';
  if (!items.length) {
    container.innerHTML = '<div class="empty">История пуста. Нажмите «Сохранить в историю» после расчёта.</div>';
    return;
  }
  for (const item of items) {
    const d = new Date(item.timestamp);
    const productsSummary = item.input.products.map(p => `${fmtNum(p.length)}×${fmtNum(p.count)}`).join(', ');
    const div = document.createElement('div');
    div.className = 'history-item';
    div.innerHTML = `
      <div class="hi-row">
        <div class="hi-name">${escapeHTML(item.name)}</div>
        <button type="button" class="hi-delete">Удалить</button>
      </div>
      <div class="hi-date">${escapeHTML(d.toLocaleString('ru-RU'))}</div>
      <div class="hi-summary">Труба ${fmtNum(item.input.lNom)} ±${fmtNum(item.input.delta)} мм, ${item.input.seams === 1 ? '1 шов' : '2 шва'}; изделия: ${escapeHTML(productsSummary)}</div>
      <div class="hi-summary"><strong>Труб: ${fmtNum(item.cutResult.totalPipes)}; отход ${fmtNum(item.cutResult.totalWaste)} мм</strong></div>
    `;
    div.addEventListener('click', (e) => {
      if (e.target.classList.contains('hi-delete')) return;
      loadHistoryItem(item);
    });
    div.querySelector('.hi-delete').addEventListener('click', (e) => {
      e.stopPropagation();
      if (confirm('Удалить эту запись?')) {
        persistHistory(loadHistory().filter(x => x.id !== item.id));
        renderHistory();
      }
    });
    container.appendChild(div);
  }
}

function loadHistoryItem(item) {
  // Открыть вкладку расчёта
  $('.tab-btn[data-tab="calc"]').click();
  applyForm(item.input);
  state.result = {
    input: item.input,
    lCalc: item.lCalc,
    partitions: item.partitions,
    typeList: item.typeList,
    cutResult: item.cutResult
  };
  renderResult(item.input, item.lCalc, item.partitions, item.typeList, item.cutResult);
}

function clearAllHistory() {
  if (confirm('Удалить всю историю расчётов? Действие необратимо.')) {
    persistHistory([]);
    renderHistory();
  }
}

// =========================================================
// TABS
// =========================================================

function initTabs() {
  $$('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.tab-btn').forEach(b => b.classList.remove('active'));
      $$('.tab-content').forEach(t => t.classList.remove('active'));
      btn.classList.add('active');
      $('#tab-' + btn.dataset.tab).classList.add('active');
      if (btn.dataset.tab === 'history') renderHistory();
    });
  });
}

// =========================================================
// INIT
// =========================================================

document.addEventListener('DOMContentLoaded', () => {
  initTabs();
  applyForm(loadInputState());

  $('#l-nom').addEventListener('input', () => { updateLCalcDisplay(); saveInputState(); });
  $('#delta').addEventListener('input', () => { updateLCalcDisplay(); saveInputState(); });
  $('#calc-name').addEventListener('input', saveInputState);
  $$('input[name="seams"]').forEach(r => r.addEventListener('change', saveInputState));

  $('#add-product').addEventListener('click', () => {
    $('#products-list').appendChild(createProductRow());
    saveInputState();
  });

  $('#calc-form').addEventListener('submit', (e) => {
    e.preventDefault();
    performCalc();
  });

  $('#clear-history').addEventListener('click', clearAllHistory);
});

// Expose algorithm primitives for unit tests / debugging in console.
window.PipeCutter = {
  findBestPartition,
  getCandidatePartitions,
  enumerateCombos,
  generateAllPatterns,
  buildTypeList,
  solveCuttingFFD,
  solveExact,
  planPartitions,
  planAndCut
};
