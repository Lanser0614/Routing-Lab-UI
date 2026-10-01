# Routing-Lab-UI

Актуальный выбор находится в шапке **Время планирования**: дата, «С часа»,
«До часа» и **Сбросить**. Заказы фильтруются по времени создания в диапазоне
`[с, до)`, расчёт выполняется в середине диапазона и запускается автоматически.
Например, 13:00–14:00 использует срез 13:30. Сброс снимает фильтр и сразу
пересчитывает сценарий на текущее время. Час 24:00 означает конец выбранной даты.

Тестовые заказы импортированы в основной SQLite-сценарий и доступны в обычном
списке заказов. Отдельный тестовый раздел убран из UI. Источник дороги по умолчанию
— **Локальный расчёт**; Яндекс включается вручную в настройках.
Для повторного импорта: `rtk proxy node scripts/import-test-orders.js`. Скрипт
сначала создаёт SQLite backup в `data/backups/`, затем импортирует 79 заказов
по исходным UUID, сохраняя остальные заказы. Исходные времена не сдвигаются.

**Документация текущей реализации:** [полное описание алгоритмов, формул, метрик и тестового режима](docs/algorithms.md).
Подключение реальной дороги: [клиент Яндекс Matrix, bulk и кеш](docs/yandex-matrix.md).

В текущем прототипе доступны два режима в **Настройки → Режим дорожного расчёта**:
**Сравнение · полная матрица** (по умолчанию) и **Экономный · ближайшие соседи**.
Экономный режим начинает с 5 соседей, расширяет поиск для неназначенных заказов
и проверяет маршруты по данным не старше 10 секунд. Его результат может отличаться
от полной матрицы. Сохраните параметры и запустите расчёт; в историческом режиме
сохранение параметров пересчитывает тест сразу.

Пробки включены по умолчанию. `SCOOTER` означает мотороллер: используется
автомобильная дорога Яндекса с нижней границей времени по скорости 40 км/ч.
Кеш исходной дороги общий с `DRIVING`, TTL с пробками — 1 минута, хранение в памяти.
В исторических срезах используются пробки на момент запроса. Реальная отправка
курьеров в прототипе не моделируется.
Ниже находится исходный технический дизайн; актуальное поведение описано в указанном документе.

# Технический дизайн: лаборатория алгоритмов доставки

**Статус:** проект решения  
**Тип:** отдельный прототип, не входящий в IO Planner  
**Цель:** сравнить пять алгоритмов группировки и маршрутизации на одинаковых заказах,
курьерах, зонах доставки, дорожной матрице и моменте планирования.

---

## 1. Основное решение

Создать самостоятельное веб-приложение **Delivery Routing Algorithm Lab**. Оператор сможет:

- рисовать и изменять зоны доставки на карте Яндекса;
- создавать заказы по адресу или клику на карте;
- менять статус, сумму, время готовности и дедлайн заказа;
- создавать курьеров и менять их статус, транспорт, вместимость, позицию и зоны;
- запускать один сценарий через пять алгоритмов;
- сравнивать buckets, порядок остановок, курьера, ETA, SLA и время дороги;
- видеть результаты на карте без скрытого изменения порядка точек.

Пять алгоритмов первой версии:

1. **Urgency-seeded append greedy** — базовый алгоритм текущего IO Planner.
2. **Nearest Neighbor** — ближайший допустимый заказ.
3. **Cheapest Feasible Insertion** — самая дешёвая допустимая вставка.
4. **Regret-2 Insertion** — сначала заказы с минимальным количеством хороших альтернатив.
5. **Exact Exhaustive Search** — полный перебор небольших сценариев как эталон качества.

OR-Tools можно позже добавить шестым benchmark, но он не входит в эти пять алгоритмов и не
должен импортироваться production IO Planner.

---

## 2. Цели и ограничения

### Цели

- Сравнивать алгоритмы на одном неизменяемом snapshot.
- Использовать одну Matrix для всех алгоритмов одного запуска.
- Проверять зоны, SLA, количество заказов и capacity.
- Имитировать процесс без Kafka, Temporal и production-сервисов.
- Хранить сценарии и результаты запусков.
- Объяснять каждое добавление, отклонение, перемещение и назначение.
- Не передавать серверные Yandex API keys во frontend.

### Не входит в первую версию

- Production dispatch и запись в Bellissimo-сервисы.
- Замена IO Planner или изменение его ADR.
- Настоящее GPS-слежение и навигация.
- Kafka/Temporal и at-least-once обработка.
- ML-прогнозы, смены, зарплата и клиентские уведомления.

---

## 3. Правила продукта

1. Planning run получает immutable snapshot. Изменение заказа после запуска не меняет старый
   результат.
2. Все алгоритмы получают одинаковые входные данные и Matrix.
3. Один заказ не может находиться в двух buckets одного результата.
4. Один курьер не может получить два buckets одного результата.
5. Каждый feasible bucket соблюдает zone, capacity, stop-count и SLA.
6. Просроченный одиночный заказ разрешается только при `allow_late_solo=true` и явно
   маркируется как late.
7. Yandex Route Details не принимает решение о порядке. Он визуализирует уже найденный route.
8. Exact имеет жёсткие лимиты и возвращает `SKIPPED_LIMIT`, а не зависает.
9. По умолчанию customer point обязан быть внутри зоны, но дорога между точками может временно
   выходить за polygon.

---

## 4. Архитектура

```text
Браузер оператора
  ├─ обычные HTML/CSS/JavaScript
  ├─ Yandex JavaScript Map
  └─ сравнение алгоритмов
          │ HTTP/JSON
          ▼
Node.js + Express
  ├─ REST API и статические файлы
  ├─ пять алгоритмов
  ├─ общий feasibility/timing engine
  ├─ Yandex API client
  ├─ проверка зон через Turf.js
  └─ SQLite repository
          │
          ├─ SQLite-файл
          └─ Yandex Geocoder / Matrix / Route Details
```

Прототип — один простой Node.js-процесс. Express одновременно раздаёт UI и обслуживает API.
Отдельные frontend/backend deployments, очереди и workers не нужны.

### Backend

- Node.js 22 LTS;
- Express 5;
- обычный JavaScript с ES modules;
- встроенный `fetch` для Yandex HTTP API;
- `better-sqlite3` для локального хранения;
- Turf.js для проверки polygons и point-in-polygon;
- `node:test` и `node:assert` для тестов.

### Frontend

- `public/index.html` и `public/styles.css`;
- обычные ES-модули в `public/js/*.js`;
- browser `fetch` для REST API;
- Yandex Maps JavaScript API v3.
- Без React, TypeScript, Vite и frontend framework.

### Запуск

```bash
npm install
cp .env.example .env
npm run dev
# http://localhost:3000
```

Docker не требуется. Пять алгоритмов выполняются внутри одного HTTP request; для основного
сценария `5 заказов × 2 курьера` этого достаточно.

### Структура проекта

```text
delivery-routing-lab/
  package.json
  .env.example
  server.js
  src/
    db.js
    schema.sql
    routes/
      scenarios.js
      zones.js
      orders.js
      couriers.js
      planning.js
      geocoding.js
    planning/
      evaluator.js
      timing.js
      metrics.js
      urgency-append.js
      nearest-neighbor.js
      cheapest-insertion.js
      regret-insertion.js
      exact.js
    yandex/
      geocoder.js
      matrix.js
      routes.js
      cache.js
    geo/
      zones.js
  public/
    index.html
    styles.css
    js/
      app.js
      api.js
      map.js
      scenario-editor.js
      results.js
  test/
    evaluator.test.js
    algorithms.test.js
    zones.test.js
    api.test.js
  data/
    routing-lab.sqlite
```

Минимальные dependencies:

```text
express
better-sqlite3
@turf/boolean-point-in-polygon
@turf/kinks
dotenv
```

Для API tests можно добавить `supertest`. Production-style DI framework, ORM и bundler не
нужны.

---

## 5. Yandex API

### 5.1 JavaScript Maps API

Используется в браузере для карты, markers, polygons, route polylines и управления viewport.
Ключ ограничивается разрешёнными browser origins.

### 5.2 Geocoder API

Backend преобразует адрес в координаты и обратно. Требования:

- ограничивать поиск регионом/bounding box сценария;
- возвращать до пяти кандидатов;
- пользователь явно выбирает результат;
- сохраняются выбранные formatted address и coordinates;
- при недоступности API остаётся ввод кликом на карте.

Документация: <https://yandex.ru/maps-api/docs/geocoder-api/request.html>

### 5.3 Distance Matrix API

Одна логическая Matrix на planning run содержит:

- филиал;
- все eligible order points;
- courier locations только при `courier_start_policy=current_location`.

Все пять алгоритмов используют один `MatrixSnapshot`. Синхронный API ограничен 100 элементами,
поэтому gateway разбивает большую Matrix на блоки и собирает её обратно.

Для филиала и пяти заказов:

```text
6 точек × 6 точек = 36 тарифицируемых элементов
```

Документация: <https://yandex.ru/maps-api/docs/distancematrix-api/index.html>

### 5.4 Route Details API

Вызывается после выполнения алгоритма, лениво для выбранного bucket. Waypoints передаются в
порядке алгоритма с `optimize=false`.

Используется для:

- polyline;
- детальных legs;
- distance/duration;
- traffic type и provider warnings.

Route Details не меняет membership или sequence. `optimize=true` допускается только как
отдельный эксперимент `YANDEX_OPTIMIZED` с повторной SLA-проверкой.

Документация: <https://yandex.ru/maps-api/docs/router-api/request.html>

### 5.5 Лицензия

Перед постоянным хранением Matrix/Route data нужно подтвердить лицензию Яндекса. До этого raw
payload persistence отключается, а in-memory cache имеет короткий TTL и очищается при restart.

Условия: <https://yandex.ru/dev/commercial/doc/ru/concepts/distance_matrix>

### 5.6 API key и ротация

Серверный ключ Yandex Routing API передаётся приложению только через environment variable:

```env
YANDEX_ROUTING_API_KEY=
```

Значение ключа не записывается в этот документ, SQLite, frontend bundle, логи или Git. Для
локального запуска оно хранится в `.env`, который обязательно включён в `.gitignore`; в общем
окружении — в Vault/secret storage.

Текущий временный ключ должен стать недействительным не позднее **6 октября 2026 года**. После
ротации меняется только secret value, код и документация не изменяются.

---

## 6. Модель данных

### Scenario и Branch

```text
Scenario
  id: UUID
  name: string
  timezone: IANA, default Asia/Tashkent
  planning_at: datetime
  settings: JSON
  version: integer
  created_at / updated_at

Branch
  id: UUID
  scenario_id: UUID
  name: string
  address: string
  location: Point(WGS84)
```

Изменение данных увеличивает `scenario.version`. Run сохраняет версию и полный snapshot.

### DeliveryZone

```text
DeliveryZone
  id: UUID
  scenario_id: UUID
  name: string
  geometry: Polygon | MultiPolygon, WGS84
  active: boolean
  color: string
  allowed_vehicle_modes: set
  priority: integer
```

Правила:

- self-intersecting geometry запрещена;
- boundary считается частью зоны через Turf `booleanPointInPolygon`;
- eligible order должен покрываться минимум одной active zone;
- overlapping zones разрешены;
- при нескольких зонах доступны курьеры из их объединения;
- изменение зоны влияет только на новые runs.

### Order

```text
Order
  id: UUID
  external_ref: optional string
  scenario_id: UUID
  address: string
  location: Point(WGS84)
  status: OrderStatus
  full_sum: integer, UZS
  created_at: datetime
  ready_at: datetime
  delivery_deadline: datetime
  service_time_sec: integer
  required_vehicle_modes: optional set
  zone_ids: derived set
  notes: optional string
```

Статусы:

```text
DRAFT
COOKING_STARTED
COOKING_COMPLETED
WAITING
ASSIGNED
ON_WAY
DELIVERED
CANCELLED
```

По умолчанию eligible: `COOKING_STARTED`, `COOKING_COMPLETED`, `WAITING`.

`ready_at` — аналог ECT. `delivery_deadline` обязателен. UI может предложить
`created_at + 35 min`, но показывает значение до сохранения.

### Courier

```text
Courier
  id: UUID
  scenario_id: UUID
  name: string
  status: CourierStatus
  vehicle_mode: DRIVING | SCOOTER | BICYCLING | WALKING
  current_location: optional Point(WGS84)
  available_at: datetime
  free_since: optional datetime
  max_orders: integer
  max_full_sum: integer
  zone_ids: set
  active: boolean
```

Статусы: `OFFLINE`, `FREE`, `RESERVED`, `DELIVERING`, `RETURNING`.

По умолчанию назначаются только `FREE`. Использование `RETURNING` включается отдельным
experiment flag.

### PlanningRun и AlgorithmResult

```text
PlanningRun
  id: UUID
  scenario_id: UUID
  scenario_version: integer
  input_snapshot: JSON string
  matrix_snapshot_id: UUID
  requested_algorithms: array
  status: RUNNING | COMPLETED | FAILED
  created_at / completed_at

AlgorithmResult
  id: UUID
  run_id: UUID
  algorithm: enum
  status: COMPLETED | SKIPPED | FAILED
  result: JSON string
  metrics: JSON string
  trace: JSON string
  compute_ms: decimal
  error_code / error_detail
```

### BucketResult

```text
BucketResult
  synthetic_bucket_id: string
  courier_id: UUID | null
  vehicle_mode: enum
  order_ids: ordered list
  stops: ordered list[StopResult]
  total_full_sum: integer
  total_travel_sec: integer
  departure_at / finish_at
  feasible: boolean
  violations: list
  route_geometry_status: NOT_REQUESTED | LOADING | READY | FAILED

StopResult
  stop_index: integer
  order_id: UUID
  arrival_at
  service_start_at
  departure_at
  deadline
  slack_sec
  cumulative_travel_sec
  late_by_sec
```

---

## 7. Общий planning engine

Все алгоритмы используют один evaluator. Алгоритм предлагает membership и sequence, а evaluator
единолично рассчитывает feasibility, ETA и metrics.

### Courier eligibility

```text
courier.active
AND courier.status in configured_assignable_statuses
AND order.zone_ids intersects courier.zone_ids
AND courier.vehicle_mode разрешён зоной
AND (order.required_vehicle_modes пуст
     OR содержит courier.vehicle_mode)
```

Курьер bucket должен быть eligible для каждого заказа.

### Capacity

```text
len(bucket.orders) <= courier.max_orders
sum(order.full_sum) <= courier.max_full_sum
```

### Departure и ETA

MVP использует `BRANCH_PICKUP`:

```text
bucket_ready_at = max(order.ready_at)
departure_at = max(planning_at, bucket_ready_at, courier.available_at)
```

При `courier_start_policy=current_location`:

```text
arrival_at_branch = max(planning_at, courier.available_at)
                    + matrix[courier_location][branch]
departure_at = max(arrival_at_branch, bucket_ready_at)
```

Для каждой остановки:

```text
arrival_i = previous_departure + matrix[previous_point][order_i]
service_start_i = max(arrival_i, order_i.ready_at)
departure_i = service_start_i + order_i.service_time
on_time_i = service_start_i <= order_i.delivery_deadline
```

Формула одинакова для алгоритмов, Exact, UI и export.

### Hard constraints

- order point внутри active zone;
- courier поддерживает зоны и vehicle requirements;
- `max_orders`;
- `max_full_sum`;
- все route legs доступны;
- ETA каждого принятого заказа не позже deadline;
- исключение — явно разрешённый late solo.

### Единый `evaluateRoute`

Все пять алгоритмов вызывают именно эту функцию; собственный расчёт ETA внутри алгоритма
запрещён.

```js
function evaluateRoute(courier, orderedOrders, input, matrix) {
  const violations = [];

  if (hasDuplicateIds(orderedOrders)) {
    return invalid("DUPLICATE_ORDER");
  }
  if (orderedOrders.length > courier.maxOrders) {
    violations.push({ code: "MAX_ORDERS" });
  }

  const totalFullSum = sum(orderedOrders.map(order => order.fullSum));
  if (totalFullSum > courier.maxFullSum) {
    violations.push({ code: "MAX_FULL_SUM" });
  }

  for (const order of orderedOrders) {
    violations.push(...courierCompatibilityViolations(courier, order, input.zones));
  }
  if (violations.length > 0) return infeasible(violations);

  let clockMs = Math.max(input.planningAtMs, courier.availableAtMs);
  let travelSec = 0;
  let distanceM = 0;

  if (input.settings.courierStartPolicy === "CURRENT_LOCATION") {
    const toBranch = matrix.leg(courier.pointId, input.branch.pointId);
    if (!toBranch.ok) return infeasible([{ code: "UNREACHABLE_LEG" }]);
    clockMs += toBranch.durationSec * 1000;
    travelSec += toBranch.durationSec;
    distanceM += toBranch.distanceM;
  }

  const bucketReadyAtMs = orderedOrders.length === 0
    ? clockMs
    : Math.max(...orderedOrders.map(order => order.readyAtMs));
  const departureAtMs = Math.max(clockMs, bucketReadyAtMs);
  clockMs = departureAtMs;

  let previousPointId = input.branch.pointId;
  const stops = [];

  for (let index = 0; index < orderedOrders.length; index += 1) {
    const order = orderedOrders[index];
    const leg = matrix.leg(previousPointId, order.pointId);
    if (!leg.ok) {
      return infeasible([{ code: "UNREACHABLE_LEG", orderId: order.id, index }]);
    }

    clockMs += leg.durationSec * 1000;
    travelSec += leg.durationSec;
    distanceM += leg.distanceM;

    const arrivalAtMs = clockMs;
    const serviceStartAtMs = Math.max(arrivalAtMs, order.readyAtMs);
    const lateBySec = Math.max(0, (serviceStartAtMs - order.deadlineMs) / 1000);
    const stopDepartureAtMs = serviceStartAtMs + order.serviceSec * 1000;

    stops.push({
      index,
      orderId: order.id,
      arrivalAtMs,
      serviceStartAtMs,
      departureAtMs: stopDepartureAtMs,
      deadlineMs: order.deadlineMs,
      slackSec: (order.deadlineMs - serviceStartAtMs) / 1000,
      lateBySec,
      cumulativeTravelSec: travelSec
    });

    if (lateBySec > 0) {
      violations.push({ code: "SLA", orderId: order.id, index, lateBySec });
    }
    clockMs = stopDepartureAtMs;
    previousPointId = order.pointId;
  }

  return {
    feasible: violations.length === 0,
    violations,
    departureAtMs,
    finishAtMs: clockMs,
    totalTravelSec: travelSec,
    totalDistanceM: distanceM,
    totalFullSum,
    stops
  };
}
```

Return-to-branch leg не входит в SLA и objective MVP. Его можно считать отдельно для UI, но
нельзя незаметно прибавлять к `totalTravelSec` одних алгоритмов и не прибавлять другим.

### Детерминизм

Tie-break порядок:

```text
delivery_deadline
created_at
order_id
courier.free_since
courier_id
```

---

## 8. Пять алгоритмов

### 8.1 Общий JavaScript-контракт

Алгоритмы являются чистыми функциями и не обращаются к SQLite, clock или Yandex.

```js
/**
 * @param {PlanningInput} input
 * @param {Map<string, MatrixSnapshot>} matricesByMode
 * @returns {AlgorithmPlan}
 */
export function plan(input, matricesByMode) {
  return {
    algorithm: "URGENCY_APPEND",
    routes: [],
    unassigned: [],
    trace: [],
    stats: { expandedStates: 0 }
  };
}
```

Нормализованный input:

```js
const input = {
  planningAtMs: 1790672400000,
  branch: { id: "B1", pointId: "branch" },
  orders: [
    {
      id: "O1",
      pointId: "order:O1",
      createdAtMs: 0,
      readyAtMs: 0,
      deadlineMs: 0,
      serviceSec: 120,
      fullSum: 100000,
      zoneIds: ["Z1"],
      requiredModes: []
    }
  ],
  couriers: [
    {
      id: "C1",
      status: "FREE",
      vehicleMode: "DRIVING",
      availableAtMs: 0,
      freeSinceMs: 0,
      maxOrders: 3,
      maxFullSum: 500000,
      zoneIds: ["Z1"]
    }
  ],
  settings: {
    courierStartPolicy: "BRANCH_PICKUP",
    allowLateSolo: true,
    exactDeadlineMs: 3000,
    exactMaxStates: 2000000
  }
};
```

`AlgorithmPlan.routes` хранит только `courierId` и ordered `orderIds`. После завершения
алгоритма общий evaluator повторно строит все `StopResult`, violations и metrics. Результат,
который не проходит финальную проверку, получает `ALGORITHM_RESULT_INVALID` и не показывается
как feasible.

### 8.2 Общие helper-функции

Все реализации используют одни и те же helpers:

```js
compareOrderUrgency(a, b)
compareCourierFifo(a, b)
canCourierServeOrder(courier, order, activeZones)
evaluateRoute(courier, orderedOrders, input, matrix)
evaluatePlan(routes, unassigned, input, matricesByMode)
insertAt(array, index, value)
routeSignature(routes)
classifyUnassigned(order, routes, input, matricesByMode)
```

`evaluateRoute` всегда пересчитывает route целиком. Инкрементальные ETA-кэши не используются в
MVP: при пяти-восьми заказах простота и единая корректность важнее микросекунд.

Результат evaluator:

```js
{
  feasible: true,
  violations: [],
  departureAtMs: 0,
  finishAtMs: 0,
  totalTravelSec: 0,
  totalDistanceM: 0,
  stops: [],
  minSlackSec: 0
}
```

Порядок violations:

```text
ZONE
VEHICLE_MODE
MAX_ORDERS
MAX_FULL_SUM
UNREACHABLE_LEG
SLA
```

Это позволяет всем алгоритмам и trace одинаково объяснять отказ.

### 8.3 Общая подготовка

Перед любым алгоритмом orchestrator:

1. Фильтрует orders по configured eligible statuses.
2. Исключает inactive zones.
3. Вычисляет `order.zoneIds` через Turf.
4. Отбирает assignable couriers.
5. Сортирует orders через `compareOrderUrgency`.
6. Сортирует couriers через `compareCourierFifo`.
7. Замораживает массивы через `Object.freeze` в development mode.
8. Передаёт каждому алгоритму отдельные shallow copies массивов.

Если нет eligible orders, возвращается успешный пустой plan. Если нет couriers, все orders
получают `NO_COURIER`. Заказ вне active zones сразу получает `OUTSIDE_ZONE` и не участвует в
переборе.

### 8.4 A1 — Urgency-seeded append greedy

#### Точное поведение

Courier-aware вариант baseline:

1. Взять couriers в FIFO-порядке.
2. Для текущего courier найти самый срочный unassigned order, который:
   - доступен курьеру по zone/mode;
   - помещается solo по capacity;
   - feasible solo либо разрешён `allowLateSolo`.
3. Создать route с этим seed.
4. Взять последнюю точку route.
5. Отсортировать остальные orders по directed duration `last → candidate`.
6. При одинаковой duration применить urgency tie-break.
7. По очереди append каждого candidate в конец.
8. Первый feasible candidate фиксируется; поиск начинается заново от новой последней точки.
9. Если ни один candidate не подходит, route закрывается и алгоритм переходит к следующему
   courier.
10. После исчерпания couriers остаток получает unassigned reason.

Seed является первой остановкой и никогда не переставляется.

#### Псевдокод

```js
function urgencyAppend(input, matrices) {
  const remaining = sortByUrgency(input.orders);
  const routes = [];
  const trace = [];

  for (const courier of sortCourierFifo(input.couriers)) {
    const seed = remaining.find(order => canSeed(courier, order));
    if (!seed) continue;

    const route = { courierId: courier.id, orderIds: [seed.id] };
    removeById(remaining, seed.id);
    trace.push(event("seed", courier, seed));

    while (remaining.length > 0) {
      const lastId = route.orderIds.at(-1);
      const candidates = remaining
        .filter(order => canCourierServeOrder(courier, order))
        .sort(byLegThenUrgency(lastId, courier.vehicleMode, matrices));

      let accepted = false;
      for (const order of candidates) {
        const tentativeIds = [...route.orderIds, order.id];
        const verdict = evaluateRouteIds(courier, tentativeIds);
        trace.push(candidateEvent("append", order, verdict));
        if (!verdict.feasible) continue;

        route.orderIds = tentativeIds;
        removeById(remaining, order.id);
        accepted = true;
        break;
      }
      if (!accepted) break;
    }
    routes.push(route);
  }
  return finish(routes, remaining, trace);
}
```

#### Complexity

Наивная верхняя граница — `O(C × N³)`: на каждом append сортируются candidates и целиком
пересчитываются tentative routes. Для `N <= 20` в прототипе этого достаточно.

#### Характерная слабость

Срочный seed всегда остаётся первой точкой, даже если короткий заказ сначала дал бы меньший
route и не нарушил deadline seed.

### 8.5 A2 — Nearest Neighbor

#### Отличие от A1

A1 выбирает seed по срочности. A2 выбирает первую и каждую следующую точку по дороге от текущей
позиции. Для пустого route текущей точкой является branch.

#### Алгоритм

Для каждого courier в FIFO-порядке:

1. `currentPoint = branch`.
2. Отсортировать доступные remaining orders по `matrix[currentPoint][order]`.
3. При равенстве использовать urgency.
4. Проверить append candidates по порядку.
5. Принять первый feasible.
6. `currentPoint = accepted order` и повторить.
7. Если route пуст и ни один order не feasible solo, перейти к следующему courier.
8. Если route непуст и ничего больше не подходит, закрыть route.

```js
while (true) {
  const candidates = nearestFeasibleOrderCandidates(currentPoint, remaining, courier);
  const accepted = candidates.find(order =>
    evaluateRouteIds(courier, [...route.orderIds, order.id]).feasible
  );
  if (!accepted) break;
  route.orderIds.push(accepted.id);
  remaining.delete(accepted.id);
  currentPoint = accepted.pointId;
}
```

Если `allowLateSolo=true`, late solo рассматривается только после того, как проверены все
feasible solo orders. Иначе просроченный ближайший заказ заблокировал бы нормальный route.

Complexity — `O(C × N³)` в простой реализации.

### 8.6 A3 — Cheapest Feasible Insertion

#### Candidate

```js
{
  orderId,
  courierId,
  position,
  tentativeOrderIds,
  deltaTravelSec,
  deltaFinishSec,
  verdict
}
```

Для каждого unassigned order проверяются:

- каждый courier route;
- позиции от `0` до `route.orderIds.length` включительно;
- пустой route имеет одну позицию `0`.

Candidate допустим, только если полный tentative route feasible.

Сравнение candidates:

```text
deltaTravelSec ASC
order.deliveryDeadline ASC
order.createdAt ASC
courier.freeSince ASC
courier.id ASC
position ASC
order.id ASC
```

#### Псевдокод

```js
function cheapestInsertion(input, matrices) {
  const routes = input.couriers.map(c => ({ courierId: c.id, orderIds: [] }));
  const remaining = new Map(input.orders.map(o => [o.id, o]));
  const trace = [];

  while (remaining.size > 0) {
    let best = null;

    for (const order of remaining.values()) {
      for (const route of routes) {
        const courier = courierById(route.courierId);
        if (!canCourierServeOrder(courier, order)) continue;

        const before = evaluateRouteIds(courier, route.orderIds);
        for (let position = 0; position <= route.orderIds.length; position += 1) {
          const ids = insertAt(route.orderIds, position, order.id);
          const verdict = evaluateRouteIds(courier, ids);
          trace.push(insertionChecked(order, courier, position, verdict));
          if (!verdict.feasible) continue;

          const candidate = {
            orderId: order.id,
            courierId: courier.id,
            position,
            tentativeOrderIds: ids,
            deltaTravelSec: verdict.totalTravelSec - before.totalTravelSec,
            deltaFinishSec: verdict.finishAtMs - before.finishAtMs
          };
          if (!best || compareInsertion(candidate, best) < 0) best = candidate;
        }
      }
    }

    if (!best) break;
    routeByCourier(best.courierId).orderIds = best.tentativeOrderIds;
    remaining.delete(best.orderId);
    trace.push(insertionAccepted(best));
  }
  return finish(nonEmpty(routes), remaining, trace);
}
```

Пустой route имеет `before.totalTravelSec = 0`. Алгоритм не создаёт предварительные seeds:
первая вставка выбирается тем же правилом, что остальные. Это отличает его от A1.

Наивная complexity — `O(C × N⁴)`, потому что на каждой итерации проверяются orders, routes,
positions и полный route. Для прототипа лимит `N <= 30` достаточен.

### 8.7 A4 — Regret-2 Feasible Insertion

A4 генерирует те же insertion candidates, что A3, но выбирает не глобально самый дешёвый.

Для каждого order:

1. Собрать все feasible candidates.
2. Отсортировать их через `compareInsertion`.
3. `best = candidates[0]`.
4. `second = candidates[1]`.
5. Рассчитать:

   ```text
   regret = second.deltaTravelSec - best.deltaTravelSec
   ```

6. Если candidate один, `regret = Infinity`.
7. Если candidates нет, order пока не вставляется.

Выбор order:

```text
regret DESC
delivery_deadline ASC
best.deltaTravelSec ASC
created_at ASC
order_id ASC
```

После выбора фиксируется его `best` insertion, затем все regrets пересчитываются заново.

```js
while (remaining.size > 0) {
  const choices = [];
  for (const order of remaining.values()) {
    const candidates = allFeasibleInsertions(order, routes);
    if (candidates.length === 0) continue;
    candidates.sort(compareInsertion);
    choices.push({
      order,
      best: candidates[0],
      regret: candidates[1]
        ? candidates[1].deltaTravelSec - candidates[0].deltaTravelSec
        : Infinity
    });
  }
  if (choices.length === 0) break;
  choices.sort(compareRegretChoice);
  applyInsertion(choices[0].best);
  remaining.delete(choices[0].order.id);
}
```

`Infinity` сохраняется в памяти, но в JSON trace записывается строка `"INF"`.

Complexity совпадает с A3: `O(C × N⁴)` в простой реализации.

### 8.8 A5 — Exact Exhaustive Search

#### State

```js
{
  nextOrderIndex,
  routes: [
    { courierId: "C1", orderIds: ["O2", "O1"] },
    { courierId: "C2", orderIds: [] }
  ],
  skippedOrderIds: [],
  assignedCount,
  totalTravelSec,
  expandedStates
}
```

Orders обрабатываются в urgency order. Для текущего order recursion создаёт branches:

1. Вставить order в каждую позицию каждого compatible courier route.
2. Оставить order unassigned.

Перебор позиции вставки, а не только append, обеспечивает рассмотрение всех permutations.

#### Псевдокод

```js
function search(index, routes, skipped) {
  guardLimits();
  expandedStates += 1;

  if (index === orders.length) {
    considerCompleteSolution(routes, skipped);
    return;
  }

  const remainingCount = orders.length - index;
  const assignedNow = countAssigned(routes);
  if (assignedNow + remainingCount < best.assignedCount) return;

  const order = orders[index];
  const seenEquivalentEmptyCourier = new Set();

  for (const route of routes) {
    const courier = courierById(route.courierId);
    if (!canCourierServeOrder(courier, order)) continue;

    const symmetryKey = emptyCourierSymmetryKey(courier, route);
    if (route.orderIds.length === 0 && seenEquivalentEmptyCourier.has(symmetryKey)) continue;
    seenEquivalentEmptyCourier.add(symmetryKey);

    for (let position = 0; position <= route.orderIds.length; position += 1) {
      const ids = insertAt(route.orderIds, position, order.id);
      const verdict = evaluateRouteIds(courier, ids);
      if (!verdict.feasible) continue;
      search(index + 1, replaceRoute(routes, courier.id, ids), skipped);
    }
  }

  search(index + 1, routes, [...skipped, order.id]);
}
```

#### Безопасные pruning rules

- `assignedNow + remainingCount < bestAssigned`;
- zone/mode/capacity violation;
- unreachable leg;
- tentative route нарушает SLA;
- при равном максимально возможном assigned count нижняя граница уже используемых couriers
  хуже best;
- при равных первых двух objective минимальный возможный travel уже хуже best;
- equivalent empty couriers исследуются один раз.

Нельзя prune только потому, что текущий route длиннее best route: будущая другая assignment
может увеличить assigned count, а это более высокий objective.

#### Limits

```text
orders <= 8
couriers <= 3
performance.now() - startedAt <= 3000 ms
expandedStates <= 2,000,000
```

Limit проверяется каждые 256 states, чтобы не вызывать clock слишком часто. При превышении
алгоритм возвращает:

```js
{
  status: "SKIPPED_LIMIT",
  routes: [],
  unassigned: [],
  stats: { expandedStates, elapsedMs, limit }
}
```

Найденный partial best не публикуется как Exact. Его можно оставить только в debug trace.

#### Objective comparator

```js
function compareSolutions(a, b) {
  return compareDesc(a.assignedOnTime, b.assignedOnTime)
    || compareAsc(a.usedCouriers, b.usedCouriers)
    || compareAsc(a.totalTravelSec, b.totalTravelSec)
    || compareAsc(a.maxRouteSec, b.maxRouteSec)
    || compareAsc(a.routeSignature, b.routeSignature);
}
```

Worst-case complexity экспоненциальная, приблизительно `O((C + 1)^N × N!)`. Поэтому Exact
является oracle малых scenarios, а не production-кандидатом.

### 8.9 Late solo policy

Чтобы A1/A2 и Exact одинаково обрабатывали уже невозможный заказ:

1. Сначала строится plan только из on-time routes.
2. После этого каждый оставшийся order проверяется solo у eligible couriers без SLA filter.
3. Если `allowLateSolo=true`, есть свободный courier и capacity соблюдается, создаётся bucket с
   `feasible=false`, violation `SLA`, `lateSolo=true`.
4. Late solo никогда не вытесняет on-time order и не объединяется с другим order.
5. В Exact objective late solo не считается `assignedOnTime`, но отображается отдельно.

### 8.10 Unassigned reason

После работы алгоритма общий classifier присваивает одну главную причину в строгом порядке:

```text
OUTSIDE_ZONE
NO_COURIER
NO_ZONE_COMPATIBLE_COURIER
NO_VEHICLE_COMPATIBLE_COURIER
MAX_ORDERS
MAX_FULL_SUM
UNREACHABLE
SLA
ALGORITHM_CHOICE
```

`ALGORITHM_CHOICE` означает: существовал feasible вариант, но heuristic исчерпал couriers или
принял более ранние решения, закрывшие этот вариант. Это важная метрика gap относительно Exact.

### 8.11 Decision trace

Каждое событие имеет общий envelope:

```js
{
  seq: 17,
  type: "candidate.rejected",
  algorithm: "CHEAPEST_INSERTION",
  orderId: "O4",
  courierId: "C2",
  routeBefore: ["O1", "O3"],
  position: 1,
  reason: "SLA",
  evidence: {
    bindingOrderId: "O1",
    etaMs: 0,
    deadlineMs: 0,
    lateBySec: 204
  }
}
```

Типы событий:

```text
algorithm.started
seed.accepted
candidate.checked
candidate.rejected
append.accepted
insertion.accepted
regret.calculated
exact.pruned
exact.best_updated
route.closed
order.unassigned
algorithm.completed
algorithm.limit_exceeded
```

Trace ограничивается 10 000 events. После лимита добавляется один `trace.truncated`. Exact по
умолчанию пишет только prune counters и `best_updated`, а не каждую recursion branch.

### 8.12 Пример `5 заказов × 2 курьера`

Planning time `18:00`, service time каждого заказа — одна минута. Оба courier свободны в
филиале, `maxOrders=3`, `maxFullSum=300 000`.

| Order | Deadline | Full sum | Zone | Branch → order |
|---|---:|---:|---|---:|
| O1 | 18:14 | 100 000 | Z1 | 10 min |
| O2 | 18:30 | 100 000 | Z1 | 5 min |
| O3 | 18:28 | 100 000 | Z1 | 6 min |
| O4 | 18:20 | 180 000 | Z2 | 7 min |
| O5 | 18:35 | 120 000 | Z2 | 8 min |

```text
C1 zones = [Z1]
C2 zones = [Z1, Z2]

O1 → O2 = 12 min
O2 → O1 = 4 min
O1 → O3 = 13 min
O2 → O3 = 3 min
O3 → O1 = 4 min
O4 → O5 = 3 min
O5 → O4 = 3 min
```

Ключевая проверка:

```text
A1 для C1:
Branch → O1 → O2
O1 ETA 18:10
O2 ETA 18:23

A3 может выбрать:
Branch → O2 → O1
O2 ETA 18:05
O1 ETA 18:10
```

Оба route соблюдают SLA, но insertion route короче. Capacity также не позволяет объединить
`O4 + O5 + любой заказ на 100 000`, поэтому алгоритмы должны объяснить split. Полный golden
fixture обязан содержать всю directed Matrix и точные expected results каждого алгоритма;
частичная таблица выше служит объяснением различия A1/A3, а не заменяет test fixture.

### 8.13 Обязательные unit tests алгоритмов

Для каждого A1–A5:

1. Пустой набор orders.
2. Нет couriers.
3. Один feasible order.
4. Один уже late order при обоих значениях `allowLateSolo`.
5. Order outside zone.
6. Vehicle incompatibility.
7. `maxOrders` binding.
8. `maxFullSum` binding.
9. Unreachable directed leg.
10. Asymmetric Matrix меняет порядок.
11. Одинаковые distances используют deterministic tie-break.
12. Ready time позднее остальных сдвигает departure.
13. Service time заставляет следующий stop опоздать.
14. Все assigned orders уникальны.
15. Все couriers уникальны.

Дополнительно:

- A1: seed остаётся первым.
- A2: первый stop ближайший к branch.
- A3: проверяются позиции `0..length`.
- A4: order с одним feasible insertion имеет `regret=INF`.
- A5: результат не хуже A1–A4; limits возвращают `SKIPPED_LIMIT`; equivalent couriers не
  меняют result signature.

### 8.14 Честность сравнения

A1–A4 сохраняют свои правила и не оптимизируются скрыто под Exact objective. Общий evaluator
оценивает готовые результаты одинаковыми metrics и повторно проверяет invariants. Одна Matrix,
один snapshot и один evaluator являются обязательным условием сравнения.

---

## 9. Assignment policy

Grouping, sequence и courier assignment — единое решение:

- A1/A2 строят routes в FIFO courier order;
- A3/A4 включают courier в insertion candidate;
- A5 одновременно перебирает assignment и sequence.

Если buckets больше, чем free couriers:

- bucket получает `UNASSIGNED_NO_COURIER`;
- остаётся видимым;
- hypothetical timing считается по default vehicle mode;
- его orders не считаются assigned в Exact objective.

---

## 10. MatrixSnapshot и ошибки provider

```text
MatrixSnapshot
  id
  provider
  mode
  traffic_mode
  departure_time_bucket
  points[]
  durations_sec[][]
  distances_m[][]
  element_status[][]
  provider_generated_at
  http_request_count
  billable_element_count
  degraded
```

При разных courier modes создаётся Matrix на каждый mode. Кэш key включает provider, mode,
traffic, rounded coordinates и departure-time bucket. Рекомендуемый TTL — пять минут.

Ошибка обрабатывается так:

- timeout/5xx: bounded exponential backoff;
- 429: учитывать `Retry-After`;
- non-OK element: только этот directed leg становится unreachable;
- ошибка одного block: вся Matrix invalid;
- partial Matrix не кэшируется;
- Haversine включается только явно и маркируется `degraded`.

---

## 11. Backend API

Prefix: `/api/v1`.

```text
# Scenarios
POST   /scenarios
GET    /scenarios
GET    /scenarios/{scenario_id}
PATCH  /scenarios/{scenario_id}
POST   /scenarios/{scenario_id}/clone
DELETE /scenarios/{scenario_id}

# Zones
POST   /scenarios/{scenario_id}/zones
PATCH  /zones/{zone_id}
DELETE /zones/{zone_id}
POST   /zones/validate

# Orders
POST   /scenarios/{scenario_id}/orders
GET    /scenarios/{scenario_id}/orders
PATCH  /orders/{order_id}
POST   /orders/{order_id}/status
DELETE /orders/{order_id}

# Couriers
POST   /scenarios/{scenario_id}/couriers
GET    /scenarios/{scenario_id}/couriers
PATCH  /couriers/{courier_id}
POST   /couriers/{courier_id}/status
DELETE /couriers/{courier_id}

# Geocoding
GET /geocode?scenario_id=...&query=...
GET /reverse-geocode?lat=...&lon=...

# Planning
POST /scenarios/{scenario_id}/runs
GET  /runs/{run_id}
GET  /runs/{run_id}/results
GET  /runs/{run_id}/results/{algorithm}
POST /runs/{run_id}/routes/hydrate

# Export
GET /runs/{run_id}/export.json
GET /runs/{run_id}/comparison.csv
```

`POST /runs` синхронно строит Matrix, выполняет пять алгоритмов и возвращает результаты.
Создание run поддерживает `Idempotency-Key`. Отдельный endpoint hydrate загружает route
geometry только для выбранного результата.

Пример запуска:

```json
{
  "algorithms": [
    "URGENCY_APPEND",
    "NEAREST_NEIGHBOR",
    "CHEAPEST_INSERTION",
    "REGRET_2",
    "EXACT"
  ],
  "traffic": "ENABLED",
  "departure_time_policy": "PLANNING_AT",
  "courier_start_policy": "BRANCH_PICKUP",
  "allow_late_solo": true,
  "hydrate_routes": "SELECTED_ONLY"
}
```

---

## 12. SQLite

```text
scenarios
branches
delivery_zones              geometry_geojson TEXT
orders                      lat REAL, lon REAL
order_status_events
couriers                    lat REAL, lon REAL
courier_status_events
courier_zones
planning_runs               immutable input_snapshot TEXT/JSON
matrix_snapshots
algorithm_results           result/metrics/trace TEXT/JSON
route_geometries
```

Ограничения:

- обычные indexes по `scenario_id`, status, run_id и foreign keys;
- positive full_sum/max_orders/capacity;
- `delivery_deadline >= created_at`;
- `ready_at >= created_at`, кроме imported history;
- unique courier-zone;
- unique `(run_id, algorithm)`;
- optimistic-lock scenario version;
- status CHECK constraints.

Геометрия хранится как GeoJSON. При сохранении и planning run Node.js проверяет её через
Turf.js:

```js
const intersections = kinks(zoneGeoJson);
const covered = booleanPointInPolygon(orderPoint, zoneGeoJson, {
  ignoreBoundary: false
});
```

Для размеров прототипа пространственный индекс не нужен. Zone membership пересчитывается в
памяти при изменении order/zone и повторно проверяется перед run.

---

## 13. Пользовательский интерфейс

```text
┌─────────────────────────────────────────────────────────────────────┐
│ Сценарий · время планирования · Запустить все                       │
├──────────────┬──────────────────────────────┬───────────────────────┤
│ Заказы       │                              │ Результаты алгоритмов │
│ Курьеры      │          Yandex Map          │ Сравнение метрик      │
│ Зоны         │                              │ Buckets / stops       │
│ Настройки    │                              │ Decision trace        │
└──────────────┴──────────────────────────────┴───────────────────────┘
```

### Zone editor

- рисование Polygon/MultiPolygon;
- перемещение vertices и удаление rings;
- name, color, active, allowed vehicle modes;
- немедленная ошибка self-intersection;
- количество orders/couriers в зоне;
- красная подсветка uncovered orders.

### Order editor

- Кнопка `Создать заказ` открывает modal/drawer.
- Обязательные поля: номер/название, адрес или точка на карте, status, `full_sum`,
  `created_at`, `ready_at`, `delivery_deadline`, `service_time_sec`.
- Address search показывает до пяти кандидатов; оператор обязан выбрать один из них или
  поставить точку вручную.
- После выбора точки UI показывает вычисленные zone memberships.
- Карточку существующего заказа можно открыть с карты или из списка и отредактировать.
- Быстрые status actions показываются непосредственно в строке заказа.
- Полная история status events доступна в раскрываемом блоке карточки.

### Courier editor

- Кнопка `Создать курьера` открывает modal/drawer.
- Обязательные поля: name, status, vehicle, `available_at`, `max_orders`, `max_full_sum` и
  минимум одна zone для active courier.
- Current location задаётся адресом или кликом на карте и может быть пустой при
  `courier_start_policy=BRANCH_PICKUP`.
- Карточку существующего courier можно открыть с карты или из списка и отредактировать.
- Кнопка `Освободить сейчас` устанавливает `FREE`, `available_at=now` и `free_since=now`.
- Полная история status events доступна в карточке.
- Цвет marker соответствует status.

### 13.5 Списки заказов и курьеров

Левая панель содержит две вкладки: `Заказы` и `Курьеры`.

Orders list показывает:

```text
order number
status badge
full_sum
ready_at
delivery_deadline
zones
последний результат assignment
```

Courier list показывает:

```text
name
status badge
vehicle mode
max_orders / max_full_sum
zones
free_since или available_at
последний назначенный bucket
```

Для обоих списков доступны:

- поиск по ID/name/address;
- фильтр status;
- фильтр zone;
- сортировка по deadline для orders и `free_since` для couriers;
- переключатель `Показать terminal/offline`;
- кнопки create/edit/delete;
- быстрые status actions.

Bulk status update в MVP не нужен: он затрудняет понимание того, какое действие изменило
scenario.

### 13.6 State machine заказа

Обычный режим разрешает переходы:

```text
DRAFT
  ├─→ COOKING_STARTED
  └─→ CANCELLED

COOKING_STARTED
  ├─→ COOKING_COMPLETED
  └─→ CANCELLED

COOKING_COMPLETED
  ├─→ WAITING
  └─→ CANCELLED

WAITING
  ├─→ ASSIGNED
  └─→ CANCELLED

ASSIGNED
  ├─→ WAITING       # ручное снятие назначения
  ├─→ ON_WAY
  └─→ CANCELLED

ON_WAY
  └─→ DELIVERED

DELIVERED           # terminal
CANCELLED           # terminal
```

Planning run сам не переводит заказ в `ASSIGNED`. Результат алгоритма является симуляцией;
оператор может применить status вручную. Это не позволяет эксперименту незаметно менять
исходные данные.

Для специальных тестов в Settings можно включить `Разрешить произвольные переходы`. Тогда UI
показывает warning, требует reason и отправляет `force=true`. Terminal order в обычном режиме
можно только клонировать как новый заказ, но не возвращать назад.

Payload status change:

```json
{
  "status": "COOKING_COMPLETED",
  "changed_at": "2026-09-29T14:20:00+05:00",
  "reason": "Имитация завершения приготовления",
  "force": false,
  "expected_version": 3
}
```

Каждое изменение атомарно:

1. Проверить текущую entity version.
2. Проверить допустимость перехода.
3. Обновить projection `orders.status`.
4. Добавить `order_status_events` с `from_status`, `to_status`, временем и reason.
5. Увеличить `scenario.version` и `order.version`.

### 13.7 State machine курьера

Обычный режим разрешает:

```text
OFFLINE
  └─→ FREE

FREE
  ├─→ RESERVED
  └─→ OFFLINE

RESERVED
  ├─→ FREE
  ├─→ DELIVERING
  └─→ OFFLINE

DELIVERING
  ├─→ RETURNING
  └─→ FREE          # завершил поездку у филиала

RETURNING
  ├─→ FREE
  └─→ OFFLINE
```

Правила полей:

- переход в `FREE` устанавливает `free_since=changed_at`;
- выход из `FREE` очищает `free_since`;
- `OFFLINE` courier не участвует в planning;
- `RESERVED` и `DELIVERING` не назначаются повторно;
- `RETURNING` участвует только при включённом experiment flag;
- `available_at` не может быть раньше `changed_at` для будущей доступности;
- изменение vehicle/zones/capacity влияет только на новые runs.

Как и для order, существует test-only `force=true` с обязательным reason. Каждое изменение
добавляет `courier_status_events` и увеличивает entity/scenario version.

### 13.8 Валидация форм

Order validation:

```text
address или coordinates обязательны
coordinates должны быть конечными и попадать в допустимый lat/lon range
full_sum > 0
created_at <= ready_at <= delivery_deadline
service_time_sec >= 0
eligible order должен находиться минимум в одной active zone
```

Courier validation:

```text
name не пустой
max_orders >= 1
max_full_sum > 0
vehicle_mode из поддерживаемого enum
active courier имеет минимум одну active zone
current_location обязательна только при current-location policy
```

Ошибки показываются рядом с полем и одновременно возвращаются API как RFC 9457 problem с
массивом `errors: [{field, code, message}]`. Кнопка Save недоступна при известной client-side
ошибке, но server повторяет все проверки.

### 13.9 Изменения после planning run

После create/edit/delete/status change:

- `scenario.version` увеличивается;
- последний результат помечается в UI как `Устарел: сценарий изменён`;
- старый run остаётся доступен и не пересчитывается;
- автоматический запуск алгоритмов не выполняется;
- оператор нажимает `Запустить все` для нового snapshot;
- route lines старого run остаются видимыми только пока выбран режим просмотра истории.

Это предотвращает неконтролируемые Yandex API calls при каждом изменении формы.

### 13.10 Удаление

Удаление order/courier/zone требует confirmation dialog с точным названием объекта.

- Из текущего scenario entity удаляется физически вместе со своей status history.
- Старые runs не меняются, потому что содержат immutable snapshots.
- Нельзя удалить последнюю active zone, пока существуют non-draft orders.
- Нельзя удалить zone, назначенную active courier, без предварительного переназначения либо
  явного подтверждения, что courier станет невалидным для planning.
- После удаления scenario помечается dirty, а предыдущий результат — stale.

### 13.11 API-ответы CRUD

Успешные create/edit/status endpoints возвращают целиком обновлённую entity, новую
`scenario_version` и флаг устаревания результата:

```json
{
  "data": {
    "id": "order-101",
    "status": "COOKING_COMPLETED",
    "version": 4
  },
  "scenario_version": 12,
  "latest_run_stale": true
}
```

При version conflict API возвращает `409 SCENARIO_VERSION_CONFLICT`; UI перезагружает entity и
предлагает пользователю повторить изменение.

### Comparison

| Метрика | A1 | A2 | A3 | A4 | Exact |
|---|---:|---:|---:|---:|---:|
| Assigned on-time | | | | | |
| Unassigned | | | | | |
| Buckets | | | | | |
| Total travel | | | | | |
| Max route | | | | | |
| Waiting | | | | | |
| Minimum SLA slack | | | | | |
| Matrix elements | одинаково | одинаково | одинаково | одинаково | одинаково |
| Compute time | | | | | |
| Gap к Exact | | | | | 0% |

Выбор алгоритма обновляет карту. Выбор двух включает diff: перемещённые orders, изменённые
stop positions, couriers и metric delta.

### Bucket card

```text
Bucket A · Курьер Aziz · SCOOTER
3 / 5 заказов · 420 000 / 1 000 000 UZS
Дорога 19 минут · минимальный запас 4 минуты

1. O-104  ETA 18:12  deadline 18:18  запас +6
2. O-101  ETA 18:19  deadline 18:23  запас +4
3. O-109  ETA 18:26  deadline 18:35  запас +9
```

Markers показывают stop numbers. Каждый bucket имеет свой цвет.

### Decision trace

```text
Seed O-101: самый ранний deadline 18:23
O-104 в позиции 0: допустимо, +5,2 минуты
O-107 отклонён: Courier 2 не обслуживает эту зону
O-108 в позиции 2 отклонён: O-101 опоздает на 3,4 минуты
Courier Aziz назначен первым допустимым по FIFO
```

Raw JSON доступен только в debug-панели.

---

## 14. Выполнение planning request

```text
POST /api/v1/scenarios/{id}/runs
  → SNAPSHOT_INPUT
  → VALIDATE_ZONES
  → FETCH_MATRIX
  → RUN_ALGORITHMS
  → EVALUATE_RESULTS
  → SAVE_RESULTS
  → HTTP 200
```

A1–A4 выполняются последовательно в одном Node.js process: для пяти заказов это проще, а время
каждого алгоритма всё равно измеряется отдельно. Exact использует deadline через
`performance.now()` и state counter. Ошибка одного алгоритма записывается в его result и не
удаляет остальные. Ошибка общей Matrix завершает request, если не включён единый degraded
Haversine snapshot. Route geometry загружается вторым запросом после выбора алгоритма в UI.

---

## 15. Метрики

Общий evaluator рассчитывает:

- eligible/assigned/on-time/late/unassigned counts;
- причины unassigned;
- количество buckets и couriers;
- total/max route duration;
- total distance;
- customer/courier waiting;
- minimum/average SLA slack;
- capacity utilization по count/full_sum;
- compute time и expanded states;
- Matrix calls и billable elements;
- Route Details calls;
- gap относительно Exact.

Не использовать один скрытый weighted score. Показывать lexicographic rank и отдельные metrics.

---

## 16. Ошибки и безопасность

RFC 9457 `application/problem+json`:

```text
ZONE_INVALID_GEOMETRY
ORDER_OUTSIDE_DELIVERY_ZONE
ORDER_ADDRESS_AMBIGUOUS
ORDER_DEADLINE_BEFORE_READY
ORDER_STATUS_TRANSITION_INVALID
COURIER_STATUS_TRANSITION_INVALID
NO_ELIGIBLE_COURIER
MATRIX_LIMIT_EXCEEDED
MATRIX_PROVIDER_UNAVAILABLE
MATRIX_RATE_LIMITED
ROUTE_PROVIDER_UNAVAILABLE
EXACT_LIMIT_EXCEEDED
SCENARIO_VERSION_CONFLICT
RUN_INPUT_INVALID
```

Безопасность:

- server keys — только environment/Vault;
- JS key ограничен browser origins;
- адреса, coordinates и raw payload не логируются;
- synthetic data используется для shared demos;
- перед internal deployment добавляется authentication;
- рекомендуемый retention: scenarios 30 дней, geometry 7 дней, metrics 90 дней;
- retention зависит от подтверждённой лицензии.

---

## 17. Наблюдаемость

Logs:

```text
run_id, scenario_id, algorithm, input_order_count, courier_count,
matrix_point_count, matrix_element_count, compute_ms, outcome
```

Metrics:

- runs по outcome;
- Matrix latency/errors/cache hits/HTTP calls/elements;
- Route и Geocoder latency;
- runtime алгоритмов;
- Exact states и skip rate;
- unassigned reasons;
- quality gap к Exact.

Endpoint `/health` проверяет, что Express работает и SQLite открывается. Он не тратит billable
Yandex request на probe.

---

## 18. Тестирование

### Unit и property tests

- zone boundary, holes и invalid polygons;
- timing/service time;
- asymmetric Matrix;
- capacity/courier eligibility;
- deterministic tie-breaks;
- каждый алгоритм на ручных cases;
- Exact limits/pruning;
- заказ и courier не дублируются;
- feasible routes соблюдают SLA;
- Exact не хуже heuristic по objective, если завершился.

### Provider contract tests

- fake Yandex Geocoder/Matrix/Route;
- split/stitch 100-element Matrix;
- partial block failure;
- 429/retry;
- non-OK legs;
- сохранение waypoint order.

### Integration и UI

- Turf point-in-polygon и сохранение GeoJSON в SQLite;
- zone → order → courier → run five algorithms;
- status change создаёт новый immutable run;
- ручная browser-проверка основных UI-сценариев;
- side-by-side diff;
- Exact skipped, heuristics остаются доступны.

### Golden scenario

Synthetic `5 orders × 2 couriers`, где:

- A1 выбирает дальний срочный заказ первым;
- A3 находит более короткий on-time sequence;
- один заказ недоступен Courier A по zone;
- срабатывает capacity;
- Exact доказывает лучший результат.

CI использует frozen fake Matrix. Реальный Yandex smoke test — только opt-in.

---

## 19. Этапы реализации

### Phase 0 — contract/licensing spike

- подтвердить Yandex products, license, storage rights, quotas, regions;
- проверить modes для Узбекистана;
- получить обезличенные Matrix/Route fixtures.

### Phase 1 — scenario editor

- SQLite schema и migration script;
- branch/zones/orders/couriers/status history;
- map, polygon editor, geocoding.

### Phase 2 — planning core

- immutable snapshots;
- Matrix gateway, splitting/cache;
- shared evaluator;
- A1/A2 и traces.

### Phase 3 — comparison

- A3/A4/A5;
- common metrics и Exact gap;
- один синхронный planning request и сохранение результатов.

### Phase 4 — visualization

- lazy Route Details с `optimize=false`;
- polylines, markers, bucket cards, diff.

### Phase 5 — hardening

- property/provider/UI tests;
- retention, auth, observability, export.

---

## 20. Критерии приёмки

1. Оператор создаёт и редактирует delivery polygon.
2. Невалидный polygon нельзя сохранить.
3. Заказ создаётся по адресу или кликом и показывает zones.
4. Можно менять status, amount, ready time, deadline и service time.
5. Можно менять status, vehicle, location, capacity и zones курьера.
6. Run фиксирует input snapshot и Matrix.
7. Пять алгоритмов используют одну Matrix.
8. Видны membership, stop order, ETA, SLA slack и courier.
9. Карта показывает zones, markers, stop numbers и routes.
10. Нет duplicate order/courier assignments.
11. Feasible result не нарушает zone/capacity/SLA.
12. Exact завершается или возвращает `SKIPPED_LIMIT`.
13. Видны common metrics и gap к Exact.
14. Route Details не меняет порядок алгоритма.
15. Matrix failure не создаёт результаты на разных fallback data.
16. Изменение scenario не меняет старый run.
17. Keys и customer coordinates не попадают в logs.
18. Order и courier создаются и редактируются через UI без ручного изменения SQLite.
19. Разрешённые status transitions доступны как быстрые действия; запрещённые возвращают 409.
20. Каждое изменение status создаёт history event с `from`, `to`, временем и reason.
21. После изменения entity предыдущий run помечается stale, но остаётся неизменным.
22. Изменение status не запускает Yandex API и алгоритмы автоматически.
23. Удаление требует confirmation и не изменяет snapshots старых runs.

---

## 21. Решения перед реализацией

1. Courier всегда начинает от branch или учитывается current location?
2. Outside-zone order запрещён или показывается unassigned?
3. Разрешать ли late solo bucket?
4. Какие exact limits утвердить?
5. Может ли один bucket объединять overlapping zones?
6. `full_sum` — реальная capacity или только экспериментальный параметр?
7. Какая Yandex license разрешает cache/storage?
8. Нужны ли сразу RU/UZ/EN?
9. Нужно ли хранить завершённые runs постоянно или достаточно кнопки очистки SQLite?

Рекомендуемые defaults:

```text
courier start = branch
outside-zone = visible unassigned
late solo = enabled and marked
overlapping zones = allowed
exact = 8 orders / 3 couriers / 3 seconds
UI = Russian first, strings externalized for localization
```


### Implemented timing model (2026-10-01)

All five backend algorithms use `src/timing.js`, ported from IO Planner's
`app/bucketing/timing.py` formulas (10)–(12). Settings are persisted with the scenario
and copied into each immutable run. The Settings tab edits exit and customer handover
minutes, branch value/count caps and return buffer percent. The 12-minute hypothetical
cook standard is fixed, as in production. Branch caps and courier caps both constrain
comparison routes. `ready` is the scenario ECT, and `deadline` is the scenario's effective
computed deadline; legacy per-order `service` is ignored in this model.

- Safe departure = min(deadline − cumulative travel − handover × zero-based stop index) − exit.
  Handover applies only to multi-order buckets.
- Closing = min(planning tick, safe departure) when the real branch value cap is reached;
  otherwise max(safe departure − 12 minutes, planning tick).
- Target departure = max(latest ready, closing).
- ETA = target departure + exit + cumulative travel + prior handovers.
- Return buffer pads the last-stop → branch leg for display only, never SLA timing.

This is a snapshot comparison, not a production dispatch simulator: a courier shown on
`pairing` is a comparison candidate. It does not reserve the real courier or simulate
scan locks, All checked, persisted dispatched buckets, future planning cycles, kitchen
outage detection or automatic SLA/ECT derivation. Outage-adjusted values can be supplied
as ready/deadline inputs. With `YANDEX_ROUTING_API_KEY`, routing uses the direct Yandex
Distance Matrix client; without it (or with `MATRIX_PROVIDER=local`), it uses
LOCAL_DETERMINISTIC geometry. See `docs/yandex-matrix.md` for bulk/cache details.
Old runs require an explicit new run to use the new provider.


### Historical test orders and unlimited courier mode (2026-10-01)

`test/fixtures/orders-2026-10-01.json` is the planning-only extraction from the supplied
Explore logs: 328 events, 84 unique order IDs, 79 retained delivery orders; 3 cancelled
orders and 2 pickups are excluded. 288 log strings have incomplete trailing JSON;
`python3 scripts/extract_test_orders.py INPUT OUTPUT` extracts only fully decoded fields.
The fixture records source row numbers, observations and explicit assumptions. It omits
customer/courier identity, telephone numbers and address details.

In Settings, **Тестовые заказы · 01.10.2026** opens an isolated in-memory comparison.
Select a historical time slice; the default is the largest cohort, 13:30 (20 orders).
Only orders already observed, not yet OnWay, with a deadline at or after the tick are
included. Expired last-known Waiting records are excluded explicitly: the export is
incomplete and cannot establish the full live backlog. `WaitCooking` is treated as
cooking for this test; initial ECT is cookingStartTime + 12 minutes, later actual cook
completion is used only after its event has been observed. Delivery deadline is creation
time + 35 minutes. IIKO `completeBefore` is a kitchen target and does not affect delivery
SLA; `sum` stands in for missing fullSum. Coordinates are
fixed to the extracted latest location. This is a cohort comparison, not a full replay.

The isolated view does not mutate SQLite orders, couriers, settings or saved runs.
Timing settings can be changed and recalculated; orders are read-only. Return with
**Вернуться к обычному сценарию**. The ordinary scenario also supports **Тест: курьеры
всегда свободны**: synthetic FREE couriers are generated independently of the real pool,
with the branch count/value caps. Exact supports identical synthetic couriers through
symmetry pruning, but still skips more than 8 orders or its time/state limits.

Run the fixture without the UI: `npm run test:orders`, or
`npm run test:orders -- 2026-10-01T12:30:00+05:00` for a specific slice.
The result is written to `test/fixtures/orders-2026-10-01-result.json`.
Routing uses Yandex road durations when configured, otherwise local geometry.
SCOOTER applies the 40 km/h time floor to Yandex driving durations; historical
unlimited couriers are currently generated as DRIVING. See `docs/yandex-matrix.md`.


Hourly cohorts: the historical test UI now first selects an hour by order creation
(e.g. 13:00–14:00), with an inclusive start and exclusive end. It then selects a planning
moment inside that hour. The hour count covers all retained fixture orders created then;
the calculation count covers only the eligible observed, unexpired orders at that moment.
Original creation, readiness and deadline timestamps are preserved, without rebasing.
The default UI cohort is 13:00–14:00. CLI example:
`npm run test:orders -- 2026-10-01T13:30:00+05:00 13:00-14:00`.
# Kafka observer

Docker: [сборка, запуск и изменение .env внутри контейнера](docs/docker.md).

Для сервера добавлены два consumer заказов и курьеров с фильтром филиала, отдельными группами и SQLite-базой. Инструкция запуска и ограничения точности SLA: [docs/kafka-observer.md](docs/kafka-observer.md). По умолчанию Kafka выключена; включение через `KAFKA_OBSERVER_ENABLED=true`. Начало заказа берётся из timestamp события WaitCooking; deadline — через 35 минут. Если начало не наблюдалось и отсутствует created_at, заказ сохраняется с диагностикой.
