"use strict";

// ===== Утилиты =====
const $ = (s) => document.querySelector(s);
const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const DAY = 24 * 60 * 60 * 1000; // миллисекунд в сутках
const BASE_POINTS = 20; // базовые баллы за визит
const DAILY_LIMIT = 100; // максимум баллов за посещения в сутки
const fmtDate = (t) => new Date(t).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });

/*! Ожидаемая ошибка: её текст показывается пользователю в уведомлении. */
class AppError extends Error {}

// ===== Инфраструктура (DIP: сервисы зависят от абстракций) =====
/*! Обёртка над localStorage с запасным хранилищем в памяти. */
class StorageAdapter {
  constructor(prefix) {
    this.p = prefix;
    this.mem = {};
  }
  get(k, d) {
    try {
      const v = localStorage.getItem(this.p + k);
      if (v !== null) return JSON.parse(v);
      return k in this.mem ? this.mem[k] : d;
    } catch (e) {
      return k in this.mem ? this.mem[k] : d;
    }
  }
  set(k, v) {
    this.mem[k] = v;
    try {
      localStorage.setItem(this.p + k, JSON.stringify(v));
    } catch (e) {
      // localStorage недоступен: данные остаются только в памяти
    }
  }
}

/*! Хеширование паролей: SHA-256 с солью. */
class Sha256Hasher {
  async hash(text, salt) {
    try {
      const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(salt + ":" + text));
      return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
    } catch (e) {
      return "plain:" + salt + ":" + text;
    }
  }
}

// ===== Репозитории (SRP: только доступ к данным) =====
/*! Базовый репозиторий: чтение и добавление записей. */
class Repository {
  constructor(store, key) {
    this.store = store;
    this.key = key;
  }
  all() {
    return this.store.get(this.key, []);
  }
  add(item) {
    this.store.set(this.key, [...this.all(), item]);
    return item;
  }
  find(fn) {
    return this.all().find(fn);
  }
  where(fn) {
    return this.all().filter(fn);
  }
}

/*! Пользователи. */
class UserRepository extends Repository {
  constructor(s) {
    super(s, "users");
  }
  byLogin(l) {
    return this.find((u) => u.login === String(l).trim().toLowerCase());
  }
  byId(id) {
    return this.find((u) => u.id === id);
  }
}

/*! Посещения и уборки. */
class VisitRepository extends Repository {
  constructor(s) {
    super(s, "visits");
  }
  forUser(id) {
    return this.where((v) => v.userId === id);
  }
}

/*! Выданные купоны. */
class CouponRepository extends Repository {
  constructor(s) {
    super(s, "coupons");
  }
  forUser(id) {
    return this.where((c) => c.userId === id).sort((a, b) => b.date - a.date);
  }
}

/*! Журнал баллов: баланс считается как сумма операций. */
class LedgerRepository extends Repository {
  // баллы = журнал операций, а не одно поле balance
  constructor(s) {
    super(s, "ledger");
  }
  forUser(id) {
    return this.where((e) => e.userId === id).sort((a, b) => b.date - a.date);
  }
  balance(id) {
    return this.forUser(id).reduce((s, e) => s + e.amount, 0);
  }
  earned(id) {
    return this.forUser(id).filter((e) => e.amount > 0).reduce((s, e) => s + e.amount, 0);
  }
}

/*! Неизменяемый каталог (места, награды). */
class Catalog {
  constructor(items) {
    this.items = items;
  }
  all() {
    return this.items;
  }
  get(id) {
    return this.items.find((i) => i.id === id);
  }
}

// ===== Данные каталога =====
/*! Каталог мест. */
const PLACES = new Catalog([
  { id: "medeu", name: "Медеу", load: "high", code: "MEDEU-2026", desc: "Высокогорный каток и плотина. Самое популярное место, часто перегружено." },
  { id: "shymbulak", name: "Шымбулак", load: "high", code: "SHYM-2026", desc: "Горнолыжный курорт и канатная дорога. Пик нагрузки по выходным." },
  { id: "bao", name: "Большое Алматинское озеро", load: "mid", code: "BAO-2026", desc: "Бирюзовое озеро в нацпарке. Средняя нагрузка, нужен пропуск." },
  { id: "butakovka", name: "Бутаковское ущелье", load: "low", code: "BUTA-2026", desc: "Тропа к водопадам. Спокойный маршрут, отличный выбор в будни." },
  { id: "kokzhailau", name: "Кок-Жайляу", load: "low", code: "KOK-2026", desc: "Альпийские луга и панорамы города. Мало людей, много простора." }
]);

/*! Каталог наград от партнёров. */
const REWARDS = new Catalog([
  { id: "coffee", partner: "Coffee Boom", title: "Скидка 10% на кофе", cost: 50 },
  { id: "guide", partner: "Гид Ерлан Т.", title: "Скидка 15% на экскурсию по Бутаковке", cost: 120 },
  { id: "gear", partner: "Alpindustria", title: "Купон 2 000 ₸ на снаряжение", cost: 150 },
  { id: "tour", partner: "Tau Travel", title: "Сертификат 5 000 ₸ на тур", cost: 250 }
]);

/*! Подписи уровня нагрузки. */
const LOAD_LABEL = { low: "Нагрузка: низкая", mid: "Нагрузка: средняя", high: "Нагрузка: высокая" };

/*! Уровни пользователя по заработанным баллам. */
const LEVELS = [{ min: 0, name: "Новичок" }, { min: 100, name: "Исследователь" }, { min: 300, name: "Страж гор" }, { min: 600, name: "Хранитель Алатау" }];

// ===== Правила начисления (OCP: новое правило = новый класс) =====
/*! Правило: множитель за нагрузку на место (чем меньше людей, тем больше баллов). */
class LoadRule {
  apply(ctx, p) {
    return p * { high: 1, mid: 1.5, low: 2 }[ctx.place.load];
  }
}

/*! Правило: повторный визит за 30 дней даёт вдвое меньше. */
class RepeatRule {
  apply(ctx, p) {
    return ctx.visits.some((v) => v.placeId === ctx.place.id && v.kind === "visit" && ctx.now - v.date < 30 * DAY) ? p * 0.5 : p;
  }
}

/*! Правило: суточный лимит баллов. */
class DailyLimitRule {
  constructor(limit) {
    this.limit = limit;
  }
  apply(ctx, p) {
    const today = ctx.visits.filter((v) => ctx.now - v.date < DAY).reduce((s, v) => s + v.points, 0);
    return Math.max(0, Math.min(p, this.limit - today));
  }
}

/*! Применяет список правил по очереди. Новое правило = новый класс. */
class PointsCalculator {
  constructor(rules) {
    this.rules = rules;
  }
  calc(ctx, base) {
    return Math.round(this.rules.reduce((p, r) => r.apply(ctx, p), base));
  }
}

// ===== Сервисы (SRP: бизнес-логика) =====
/*! Регистрация, вход, выход и текущая сессия. */
class AuthService {
  constructor(users, hasher, store) {
    this.users = users;
    this.hasher = hasher;
    this.store = store;
  }
  async register({ name, login, password, confirm }) {
    name = (name || "").trim();
    login = (login || "").trim().toLowerCase();
    if (name.length < 2) throw new AppError("Введите имя (минимум 2 символа)");
    if (!/^[a-z0-9_]{3,20}$/.test(login)) throw new AppError("Логин: 3–20 символов, латиница, цифры и _");
    if ((password || "").length < 6) throw new AppError("Пароль должен быть не короче 6 символов");
    if (password !== confirm) throw new AppError("Пароли не совпадают");
    if (this.users.byLogin(login)) throw new AppError("Такой логин уже занят");
    const salt = uid();
    const user = this.users.add({ id: uid(), name, login, salt, hash: await this.hasher.hash(password, salt), created: Date.now() });
    this.store.set("session", user.id);
    return user;
  }
  async login(login, password) {
    const u = this.users.byLogin(login || "");
    if (!u || u.hash !== await this.hasher.hash(password || "", u.salt)) throw new AppError("Неверный логин или пароль");
    this.store.set("session", u.id);
    return u;
  }
  logout() {
    this.store.set("session", null);
  }
  current() {
    const id = this.store.get("session", null);
    return id ? this.users.byId(id) || null : null;
  }
}

/*! Отметки по QR, уборки и расчёт баллов. */
class VisitService {
  constructor(visits, ledger, places, calc) {
    Object.assign(this, { visits, ledger, places, calc });
  }
  placeIdByCode(code) {
    const place = this.places.all().find((p) => p.code === String(code || "").trim().toUpperCase());
    if (!place) throw new AppError("QR-код не распознан. Проверьте код на точке");
    return place.id;
  }
  ctx(user, place) {
    return { place, visits: this.visits.forUser(user.id), now: Date.now() };
  }
  visitedToday(c) {
    return c.visits.some((v) => v.placeId === c.place.id && v.kind === "visit" && c.now - v.date < DAY);
  }
  preview(user, place) {
    const c = this.ctx(user, place);
    return this.visitedToday(c) ? 0 : this.calc.calc(c, BASE_POINTS);
  }
  checkIn(user, placeId, code) {
    const place = this.places.get(placeId);
    if (!place) throw new AppError("Место не найдено");
    if (String(code || "").trim().toUpperCase() !== place.code) throw new AppError("Неверный QR-код. Сверьте код на точке");
    const c = this.ctx(user, place);
    if (this.visitedToday(c)) throw new AppError("Сегодня вы уже отмечались в этом месте");
    const pts = this.calc.calc(c, BASE_POINTS);
    if (pts <= 0) throw new AppError("Дневной лимит баллов исчерпан, возвращайтесь завтра");
    return this.record(user, place, "visit", 0, pts);
  }
  cleanup(user, placeId, kg) {
    const place = this.places.get(placeId);
    kg = Number(kg);
    if (!place) throw new AppError("Выберите место уборки");
    if (!(kg >= 0.5 && kg <= 30)) throw new AppError("Вес мусора: от 0.5 до 30 кг");
    const now = Date.now();
    if (this.visits.forUser(user.id).some((v) => v.kind === "cleanup" && now - v.date < DAY)) throw new AppError("Уборку можно засчитать один раз в сутки");
    return this.record(user, place, "cleanup", kg, Math.min(60, 15 + Math.round(kg * 5)));
  }
  record(user, place, kind, kg, pts, date = Date.now()) {
    this.visits.add({ id: uid(), userId: user.id, placeId: place.id, kind, kg, points: pts, date });
    this.ledger.add({ id: uid(), userId: user.id, amount: pts, date, title: kind === "visit" ? "Посещение: " + place.name : `Уборка: ${place.name} (${kg} кг)` });
    return pts;
  }
}

/*! Обмен баллов на купоны. */
class RewardService {
  constructor(ledger, coupons, rewards) {
    Object.assign(this, { ledger, coupons, rewards });
  }
  redeem(user, rewardId, date = Date.now()) {
    const r = this.rewards.get(rewardId);
    if (!r) throw new AppError("Награда не найдена");
    if (this.ledger.balance(user.id) < r.cost) throw new AppError("Недостаточно баллов");
    this.ledger.add({ id: uid(), userId: user.id, amount: -r.cost, date, title: "Обмен: " + r.title });
    return this.coupons.add({ id: uid(), userId: user.id, rewardId, code: "ST-" + uid().slice(0, 6).toUpperCase(), date });
  }
}

/*! Уровень и прогресс пользователя. */
class LevelService {
  progress(earned) {
    let i = 0;
    LEVELS.forEach((l, n) => {
      if (earned >= l.min) i = n;
    });
    const cur = LEVELS[i], next = LEVELS[i + 1];
    return { cur, next, pct: next ? Math.round((earned - cur.min) / (next.min - cur.min) * 100) : 100 };
  }
}

// ===== Демо-данные: Анарбек (логин anarbek, пароль 123456) =====
/*! Демо-данные: пользователь Анарбек (anarbek / 123456). */
async function seedDemo(d) {
  if (d.store.get("seeded", false)) return;
  const salt = "demo", now = Date.now();
  const user = d.users.add({ id: "u_anarbek", name: "Анарбек Сериков", login: "anarbek", salt, hash: await d.hasher.hash("123456", salt), created: now - 30 * DAY });
  [[21, "medeu", "visit", 0, 20], [14, "butakovka", "visit", 0, 40], [7, "kokzhailau", "visit", 0, 40], [5, "butakovka", "cleanup", 3, 30], [2, "shymbulak", "visit", 0, 20]].forEach(([ago, pid, kind, kg, pts]) => d.visitSvc.record(user, PLACES.get(pid), kind, kg, pts, now - ago * DAY));
  d.rewardSvc.redeem(user, "coffee", now - 1 * DAY);
  d.store.set("seeded", true);
}

// ===== Интерфейс =====
/*! Рисует псевдо-QR по коду купона (для демонстрации). */
const qrSvg = (code) => {
  let h = 0, s = "";
  for (const c of code) h = h * 31 + c.charCodeAt(0) >>> 0;
  for (let y = 0; y < 9; y++) for (let x = 0; x < 9; x++) {
    h = h * 1103515245 + 12345 >>> 0;
    if (x < 3 && y < 3 || x > 5 && y < 3 || x < 3 && y > 5 || h >>> 16 & 1) s += `<rect x="${x}" y="${y}" width="1" height="1"/>`;
  }
  return `<svg viewBox="0 0 9 9" width="76" height="76" fill="currentColor" shape-rendering="crispEdges" aria-label="QR">${s}</svg>`;
};

/*! Сканер QR через камеру: BarcodeDetector, если он есть, иначе библиотека jsQR. */
class QrScanner {
  constructor() {
    this.stream = null;
    this.timer = null;
  }
  async start(video, onCode) {
    const detect = this.createDetector(video);
    if (!navigator.mediaDevices?.getUserMedia) throw new AppError("Камера недоступна: нужен https или localhost");
    this.stop();
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
    } catch (e) {
      throw new AppError("Нет доступа к камере. Разрешите её в настройках браузера");
    }
    this.stream = stream;
    video.srcObject = stream;
    video.hidden = false;
    await video.play().catch(() => {});
    if (this.stream !== stream) return; // окно закрыли, пока включалась камера
    this.timer = setInterval(async () => {
      try {
        const code = await detect();
        if (code) {
          this.stop();
          onCode(code);
        }
      } catch (e) {
        // кадр ещё не готов: пробуем на следующем тике
      }
    }, 250);
  }
  createDetector(video) {
    if ("BarcodeDetector" in window) {
      const detector = new BarcodeDetector({ formats: ["qr_code"] });
      return async () => (await detector.detect(video))[0]?.rawValue;
    }
    if (window.jsQR) {
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      return async () => {
        if (!video.videoWidth) return null;
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0);
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        return jsQR(img.data, img.width, img.height)?.data;
      };
    }
    throw new AppError("Сканер QR не загрузился. Введите код вручную");
  }
  stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }
}

/*! Вкладки интерфейса. */
const TABS = [["places", "Места"], ["eco", "Эко-действия"], ["rewards", "Награды"], ["cabinet", "Личный кабинет"]];

/*! Интерфейс: обработка событий и отрисовка экранов. */
class App {
  constructor(d) {
    this.d = d;
    this.tab = "places";
    this.mode = "login";
    this.modal = null;
    this.sos = null;
    this.scanner = new QrScanner();
    this.bind();
    this.render();
  }
  toast(msg, bad) {
    const t = document.createElement("div");
    t.className = "toast" + (bad ? " bad" : "");
    t.textContent = msg;
    $("#toast").append(t);
    setTimeout(() => t.remove(), 3400);
  }
  bind() {
    document.addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = e.target, data = Object.fromEntries(new FormData(f));
      await this.safe(() => this.onSubmit(f.dataset.form, data));
    });
    document.addEventListener("click", async (e) => {
      const b = e.target.closest("[data-action]");
      if (!b) return;
      if (b.classList.contains("overlay") && e.target !== b) return;
      await this.safe(() => this.onAction(b.dataset.action, b.dataset.v));
    });
  }
  async safe(fn) {
    try {
      await fn();
    } catch (err) {
      if (err instanceof AppError) this.toast(err.message, true);
      else {
        console.error(err);
        this.toast("Что-то пошло не так, попробуйте ещё раз", true);
      }
    }
  }
  async onSubmit(kind, f) {
    const d = this.d, u = d.auth.current();
    if (kind === "login") {
      await d.auth.login(f.login, f.password);
      this.tab = "places";
    } else if (kind === "register") {
      await d.auth.register(f);
      this.tab = "places";
      this.toast("Аккаунт создан. Добро пожаловать!");
    } else if (kind === "checkin") {
      const placeId = this.modal === "any" ? d.visitSvc.placeIdByCode(f.code) : this.modal;
      const p = d.visitSvc.checkIn(u, placeId, f.code);
      this.modal = null;
      this.toast(`+${p} баллов за посещение!`);
    } else if (kind === "cleanup") {
      const p = d.visitSvc.cleanup(u, f.place, f.kg);
      this.toast(`+${p} баллов за уборку. Спасибо природе!`);
    }
    this.render();
  }
  async onAction(a, v) {
    const d = this.d, u = d.auth.current();
    if (a === "sos") return this.openSos();
    if (a === "sos-close") {
      this.sos = null;
      return this.renderSos();
    }
    if (a === "sos-copy") return this.copySos();
    if (a === "camera") return this.startCamera();
    if (a === "mode") this.mode = v;
    else if (a === "demo") {
      await d.auth.login("anarbek", "123456");
      this.tab = "cabinet";
    } else if (a === "logout") {
      d.auth.logout();
      this.mode = "login";
    } else if (a === "tab") this.tab = v;
    else if (a === "open") this.modal = v;
    else if (a === "close") this.modal = null;
    else if (a === "redeem") {
      const c = d.rewardSvc.redeem(u, v);
      this.toast("Купон получен: " + c.code);
      this.tab = "cabinet";
    }
    this.render();
  }
  render() {
    this.scanner.stop();
    const u = this.d.auth.current();
    $("#app").innerHTML = u ? this.shell(u) : this.authView();
  }
  authView() {
    const reg = this.mode === "register";
    return `<main class="auth"><div class="brand big">Safe Trip</div>
    <p class="muted" style="text-align:center">Безопасные походы, бережное отношение к природе и награды</p>
    <div class="card"><div class="seg">
      <button data-action="mode" data-v="login" class="${reg ? "" : "on"}">Вход</button>
      <button data-action="mode" data-v="register" class="${reg ? "on" : ""}">Регистрация</button></div>
    <form data-form="${reg ? "register" : "login"}" novalidate>
      ${reg ? '<label for="n">Имя</label><input id="n" name="name" autocomplete="name">' : ""}
      <label for="l">Логин</label><input id="l" name="login" autocomplete="username" autocapitalize="none">
      <label for="p">Пароль</label><input id="p" name="password" type="password" autocomplete="${reg ? "new-password" : "current-password"}">
      ${reg ? '<label for="c">Повторите пароль</label><input id="c" name="confirm" type="password" autocomplete="new-password">' : ""}
      <button class="btn" type="submit">${reg ? "Создать аккаунт" : "Войти"}</button></form></div>
    <div class="card sm"><b>Демо-аккаунт:</b> <code>anarbek</code> / <code>123456</code><br>
    <button class="ghost" style="margin-top:10px;width:100%" data-action="demo">Войти как Анарбек</button></div></main>`;
  }
  shell(u) {
    const bal = this.d.ledger.balance(u.id);
    return `<header class="top"><div class="brand">Safe Trip</div><div class="row"><span class="chip">${bal} баллов</span><button class="ghost sm" data-action="logout">Выйти</button></div></header>
    <nav class="tabs">${TABS.map(([k, n]) => `<button data-action="tab" data-v="${k}" class="${this.tab === k ? "on" : ""}">${n}</button>`).join("")}</nav>
    <main>${this[this.tab + "Tab"](u, bal)}</main>
    <footer>Прототип: данные хранятся в вашем браузере. Партнёры и QR-коды демонстрационные.</footer>${this.modal ? this.modalView(u) : ""}`;
  }
  placesTab(u) {
    return `<h2>Места</h2><button class="btn wide" data-action="open" data-v="any">Сканировать QR-код камерой</button><p class="muted sm">Чем меньше людей на маршруте, тем больше баллов. Баллы за повторный визит в течение 30 дней вдвое меньше.</p>
    <div class="grid">${PLACES.all().map((p) => {
      const pts = this.d.visitSvc.preview(u, p);
      return `<div class="card">
      <h3>${esc(p.name)}</h3><span class="badge b-${p.load}">${LOAD_LABEL[p.load]}</span>
      <p class="muted sm" style="margin:0">${esc(p.desc)}</p>
      <div><b>${pts > 0 ? "+" + pts + " баллов" : "Сегодня уже засчитано"}</b></div>
      <button class="btn" data-action="open" data-v="${p.id}" ${pts > 0 ? "" : "disabled"}>Отметиться по QR</button></div>`;
    }).join("")}</div>`;
  }
  modalView() {
    const place = this.modal === "any" ? null : PLACES.get(this.modal);
    const codes = place ? place.code : PLACES.all().map((p) => p.code).join(", ");
    return `<div class="overlay" data-action="close"><div class="modal" role="dialog" aria-modal="true">
    <h3>${place ? esc(place.name) : "Сканирование QR-кода"}</h3>
    <p class="muted sm">Наведите камеру на QR-табличку на точке или введите код вручную.</p>
    <video id="cam" class="cam" playsinline muted hidden></video>
    <button class="btn wide" type="button" data-action="camera">Включить камеру</button>
    <form data-form="checkin" novalidate><label for="code">Код точки</label>
    <input id="code" name="code" autocomplete="off" placeholder="например, ${place ? place.code : "MEDEU-2026"}">
    <p class="muted sm">Демо-коды: <code>${codes}</code></p>
    <button class="btn" type="submit">Подтвердить посещение</button></form>
    <button class="ghost wide" data-action="close">Отмена</button></div></div>`;
  }
  async startCamera() {
    await this.scanner.start($("#cam"), (code) => this.onScanned(code));
  }
  onScanned(code) {
    const form = $('form[data-form="checkin"]');
    if (!form) return;
    form.elements.code.value = code;
    form.requestSubmit();
  }
  async openSos() {
    this.sos = { status: "loading" };
    this.renderSos();
    let result;
    try {
      result = { status: "ok", ...await this.getPosition() };
    } catch (err) {
      result = { status: "error", message: err instanceof AppError ? err.message : "Не удалось определить местоположение" };
    }
    if (!this.sos) return; // окно закрыли, пока шёл поиск
    this.sos = result;
    this.renderSos();
  }
  getPosition() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) return reject(new AppError("Геолокация недоступна в этом браузере"));
      navigator.geolocation.getCurrentPosition(
        (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude, acc: Math.round(p.coords.accuracy) }),
        () => reject(new AppError("Не удалось определить местоположение. Разрешите доступ к геолокации")),
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
      );
    });
  }
  sosMessage() {
    const { lat, lon, acc } = this.sos;
    const user = this.d.auth.current();
    const who = user ? `. Меня зовут ${user.name}` : "";
    return `Нужна помощь спасателей${who}. Координаты: ${lat.toFixed(5)}, ${lon.toFixed(5)} (точность около ${acc} м). Карта: https://maps.google.com/?q=${lat},${lon}`;
  }
  async copySos() {
    try {
      await navigator.clipboard.writeText(this.sosMessage());
      this.toast("Сообщение скопировано");
    } catch (e) {
      this.toast("Не удалось скопировать. Выделите текст вручную", true);
    }
  }
  renderSos() {
    $("#sos-root").innerHTML = this.sos ? this.sosView() : "";
  }
  sosView() {
    const s = this.sos;
    let info;
    if (s.status === "loading") info = "<p><b>Определяем ваше местоположение...</b></p>";
    else if (s.status === "error") info = `<p class="sos-error"><b>${esc(s.message)}</b></p><p class="muted sm">Вы всё равно можете позвонить на 112 и назвать ориентиры вслух.</p>`;
    else info = `<p class="muted sm">Ваши координаты:</p><p><b>${s.lat.toFixed(5)}, ${s.lon.toFixed(5)}</b> <span class="muted sm">(точность около ${s.acc} м)</span></p><p class="msg">${esc(this.sosMessage())}</p>`;
    return `<div class="overlay sos-overlay" data-action="sos-close"><div class="modal" role="alertdialog" aria-modal="true">
    <h3>Вызов МЧС</h3>${info}
    <a class="btn sos-call wide" href="tel:112">Позвонить 112</a>
    ${s.status === "ok" ? '<button class="ghost wide" data-action="sos-copy">Скопировать сообщение</button>' : ""}
    <button class="ghost wide" data-action="sos-close">Закрыть</button>
    <p class="muted sm">Прототип не отправляет данные автоматически: нажмите «Позвонить 112» и продиктуйте координаты диспетчеру.</p></div></div>`;
  }
  ecoTab() {
    return `<h2>Эко-действия</h2><div class="card"><h3>Участие в уборке</h3>
    <p class="muted sm">Награда: 15 баллов + 5 за каждый килограмм (максимум 60). Один раз в сутки. В полной версии вес подтверждает организатор или оператор пункта приёма.</p>
    <form data-form="cleanup" novalidate><label for="pl">Место уборки</label>
    <select id="pl" name="place">${PLACES.all().map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("")}</select>
    <label for="kg">Вес собранного мусора, кг</label><input id="kg" name="kg" type="number" min="0.5" max="30" step="0.5" value="2">
    <button class="btn" type="submit">Отправить отчёт</button></form></div>`;
  }
  rewardsTab(u, bal) {
    return `<h2>Награды</h2><p class="muted sm">Ваш баланс: <b>${bal}</b> баллов</p><div class="grid">
    ${REWARDS.all().map((r) => `<div class="card"><h3>${esc(r.title)}</h3>
      <span class="muted sm">${esc(r.partner)}</span><div><b>${r.cost} баллов</b></div>
      <button class="btn" data-action="redeem" data-v="${r.id}" ${bal >= r.cost ? "" : "disabled"}>${bal >= r.cost ? "Обменять" : "Не хватает " + (r.cost - bal)}</button></div>`).join("")}</div>`;
  }
  cabinetTab(u, bal) {
    const d = this.d, visits = d.visits.forUser(u.id), lv = d.levels.progress(d.ledger.earned(u.id));
    const vis = visits.filter((v) => v.kind === "visit");
    const kg = visits.filter((v) => v.kind === "cleanup").reduce((s, v) => s + v.kg, 0);
    const hist = d.ledger.forUser(u.id), coupons = d.coupons.forUser(u.id);
    return `<h2>Личный кабинет</h2><div class="card"><div class="profile"><div class="avatar">${esc(u.name.trim()[0].toUpperCase())}</div>
      <div><h3 style="margin:0">${esc(u.name)}</h3><div class="muted sm">@${esc(u.login)} · с нами с ${fmtDate(u.created)}</div></div>
      <div style="margin-left:auto;text-align:right"><div class="muted sm">Баланс</div><b style="font-size:26px;color:var(--accent)">${bal}</b></div></div>
      <div style="margin-top:14px"><b>${lv.cur.name}</b>${lv.next ? ` <span class="muted sm">до «${lv.next.name}» — ${lv.pct}%</span>` : ""}<div class="bar"><i style="width:${lv.pct}%"></i></div></div></div>
    <div class="stats"><div class="stat"><b>${vis.length}</b>посещений</div><div class="stat"><b>${new Set(vis.map((v) => v.placeId)).size}</b>мест из ${PLACES.all().length}</div><div class="stat"><b>${kg}</b>кг мусора</div><div class="stat"><b>${coupons.length}</b>купонов</div></div>
    <h2 style="margin-top:20px">История</h2><div class="card"><ul class="hist">${hist.length ? hist.map((e) => `<li><span>${esc(e.title)}<br><span class="muted sm">${fmtDate(e.date)}</span></span><span class="${e.amount > 0 ? "plus" : "minus"}">${e.amount > 0 ? "+" : ""}${e.amount}</span></li>`).join("") : '<li class="muted">Пока пусто. Отметьтесь в первом месте!</li>'}</ul></div>
    <h2>Мои купоны</h2>${coupons.length ? '<div class="grid">' + coupons.map((c) => {
      const r = REWARDS.get(c.rewardId);
      return `<div class="card coupon">${qrSvg(c.code)}<div><b>${esc(r.title)}</b><div class="muted sm">${esc(r.partner)}</div><code>${c.code}</code><div class="muted sm">от ${fmtDate(c.date)}</div></div></div>`;
    }).join("") + "</div>" : '<div class="card muted">Купонов пока нет. Обменяйте баллы во вкладке «Награды».</div>'}`;
  }
}

// ===== Сборка зависимостей (composition root) =====
(async function main() {
  const store = new StorageAdapter("safetrip:");
  const hasher = new Sha256Hasher();
  const users = new UserRepository(store), visits = new VisitRepository(store), ledger = new LedgerRepository(store), coupons = new CouponRepository(store);
  const calc = new PointsCalculator([new LoadRule(), new RepeatRule(), new DailyLimitRule(DAILY_LIMIT)]);
  const d = {
    store,
    hasher,
    users,
    visits,
    ledger,
    coupons,
    auth: new AuthService(users, hasher, store),
    visitSvc: new VisitService(visits, ledger, PLACES, calc),
    rewardSvc: new RewardService(ledger, coupons, REWARDS),
    levels: new LevelService()
  };
  await seedDemo(d);
  new App(d);
})();