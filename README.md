# effect-dynamic-layer

Экспериментальная TypeScript-библиотека динамического управления графом Effect-сервисов. Обычные `Layer` и `Effect` остаются рецептами реализации; `DynamicRuntime` управляет их поколениями, доступностью и ресурсами.

**Цель выпуска — experimental 0.1.0, не production-ready. Пакет не публикуется.** Текущие доказательства и покрытие требований — в [docs/status.md](docs/status.md). Исходное задание — [HANDOFF-dynamic-layer.md](HANDOFF-dynamic-layer.md); явные уточнения владельца заменяют его baseline: **Effect RC и Bun**, не Effect v3/pnpm/Vitest.

## Разработка

Точные версии: Bun **1.4.2**, Effect **4.0.0-rc.115**, TypeScript **7.0.2**, Biome **2.5.13**, Lefthook **2.1.12**. Bun используется для установки зависимостей, выполнения тестов и bundling. TypeScript проверяет типы и выпускает declarations. Effect — peer dependency, не встроенная копия runtime.

```sh
bun install --frozen-lockfile
bun run typecheck
bun test
bun run test:types
bun run lint
bun run build
bun run test:package
bun run examples
```

`bun run example:basic` запускает основную цепочку. Другие примеры: `example:effect-factory` и `example:failure-and-retry`.

Lefthook проверяет staged-файлы Biome перед коммитом; перед push выполняет lint, typecheck, runtime- и type-tests. Проверки не исправляют файлы молча. Для осознанного форматирования: `bun x --no-install biome check --write .`. Коммиты делаются атомарно: инфраструктура, compatibility, модель, runtime и поставка — самостоятельные связанные изменения.

## Минимальный пример

```ts
import { Context, Effect } from "effect";
import { DynamicLayer, DynamicRuntime, Requirement } from "effect-dynamic-layer";

class Database extends Context.Service<Database, { readonly label: string }>()("app/Database") {}
class Analytics extends Context.Service<Analytics, { readonly read: Effect.Effect<string> }>()(
  "app/Analytics",
) {}

const program = Effect.scoped(Effect.gen(function* () {
  const runtime = yield* DynamicRuntime.make();
  yield* runtime.register(DynamicLayer.fromEffect(Analytics)({
    id: "analytics",
    requires: Requirement.service(Database),
    acquire: Effect.gen(function* () {
      const database = yield* Database;
      return { read: Effect.succeed(`using ${database.label}`) };
    }),
  }));
  // Отсутствующая зависимость — Pending, не ошибка регистрации.
  yield* runtime.register(DynamicLayer.fromEffect(Database)({
    id: "database",
    requires: Requirement.empty,
    acquire: Effect.succeed({ label: "database #1" }),
  }));
  yield* runtime.awaitState("analytics", "Active");
  yield* runtime.use(Analytics, (analytics) => analytics.read);
  yield* runtime.disable("database");
  yield* runtime.awaitState("database", "Disabled");
}));

await Effect.runPromise(program);
```

`DynamicLayer.fromLayer(Service)({ id, requires, layer, when? })` принимает обычный Layer. `fromEffect` использует тот же lifecycle через `Layer.effect`: в Effect RC он уже обеспечивает Scope для acquisition. Обычный API не требует пользовательских casts.

`Requirement.empty`, `Requirement.service(Service)` и вложенный `Requirement.all(...)` описывают обязательные зависимости. Дополнительные зависимости ради lifecycle допустимы; пропуск внешнего требования реализации — ошибка компиляции. Зависимости, обеспеченные внутренним `Layer.provide`, повторно не объявляются. Несколько поставщиков одного runtime service key не допускаются, включая Disabled-провайдеров; используйте namespaced ключи.

## Основные гарантии договора

- Controller сериализует изменения графа и публикаций, но не ждёт пользовательского I/O.
- Публикуется только полностью построенное, ещё актуальное поколение.
- При disable/replace/unregister или закрытии gate сначала отзывается вся затронутая ветка. Старые ссылки не допускаются в новые `use`.
- Физическая остановка идёт от consumers к providers. Consumer finalizer может использовать старый provider до окончания своей cleanup-попытки.
- Replacement — **stop-before-start** с промежутком недоступности; старый уже закрытый экземпляр не восстанавливается автоматически.
- Независимые ветви не перезапускаются. Каждое поколение имеет свой Scope и свежий MemoMap; обычное sharing sublayers сохраняется внутри одного build.
- Failed acquisition не запускает бесконечный retry. `retry(id)` явно разрешает новую попытку; для Active/Pending/Disabled это no-op. Новое поколение нужной зависимости, новый activation cycle или replace также разрешают попытку.
- Shutdown идемпотентен и упорядочен; closing owning Scope вызывает его автоматически.

Подробный договор и значения состояний — в [semantics.md](docs/semantics.md), ownership — в [architecture.md](docs/architecture.md). Уровень фактической проверки перечислен отдельно в [status.md](docs/status.md).

## Команды и ожидания

`register`, `enable`, `disable`, `replace`, `unregister`, `retry` подтверждают принятие desired-state изменения. При invalidation это включает атомарное отозвание публикаций, **но не завершение acquisition/finalizers**. Для завершения используйте `awaitState(id, state)` и `awaitIdle()`.

`awaitIdle()` — барьер отсутствия незавершённых lifecycle-операций, управляемых calls и уже принятых необработанных изменений. Pending/Disabled/Failed допустимы; долгоживущие scoped workers сервисов и gate watchers сами по себе не мешают idle. Это не блокировка будущих изменений.

`awaitState` сначала проверяет искомое состояние. Failed вместо другого ожидаемого состояния завершает ожидание ошибкой; можно ждать сам Failed. Неизвестный/удалённый id и Closing/Closed — явные ошибки. Ожидания отменяются стандартными средствами Effect; timeout ограничивает ожидание, а не освобождает чужие ресурсы принудительно.

`shutdown` намеренно выполняет непрерываемый ordered drain, как `Scope.close`: отмена caller или timeout не обрывают освобождение ресурсов посередине и не гарантируют немедленного возврата. Наблюдать удерживаемую ветку можно через snapshot, доступный и во время Closing. Это отличается от отменяемых `awaitState`/`awaitIdle`.

## Реактивный gate

Поле `when` принимает `SubscriptionRef<boolean>`. Начальное значение и изменения наблюдаются через `SubscriptionRef.changes`, без раздельных get/subscribe. False отзывает поколение; true разрешает сборку при готовых dependencies. Duplicate true не перезапускает сервис. Цикл true → false → true инвалидирует старую попытку, даже если она завершилась после последнего true.

Подписка принадлежит регистрации: живёт после остановки поколения и disable, освобождается при replace/unregister/shutdown. После `SubscriptionRef.set` дождитесь нужного состояния runtime — изменение ref не является подтверждением controller.

Обычный `Effect<boolean>` не является реактивным условием. Потерю сетевого соединения библиотека не обнаруживает: внешний адаптер должен изменить gate/enablement либо сам сервис реализует reconnect. Polling, health supervision и transport в ядро не входят.

## Безопасное использование и ограничения Effect interop

Главный путь доступа — `runtime.use(Service, callback)`. Admission закрепляет одно Active-поколение; при отсутствии публикации возвращается `ServiceUnavailable`, callback не запускается. Отозвание прерывает уже допущенные calls и ждёт их cleanup до release provider. Дополнительные требования callback остаются в его типе, Context и fiber-local references наследуются от вызывающего кода. Scope вызова и scoped children завершаются вместе с call.

**Не сохраняйте и не возвращайте service object для использования вне callback.** Не запускайте неучтённые Promise/fibers с захваченным сервисом. TypeScript не имеет линейных типов и не может запретить все escape-ы. Нет публичного `get`, обещающего вечную валидность ссылки.

Interruption не доказывает, что внешняя операция не произошла. Бизнес-команды **никогда не повторяются автоматически** на новом поколении. Некооперативные acquisition/callback/finalizer могут удерживать ветку в Stopping и задерживать shutdown; закрывать provider под продолжающим работать consumer небезопасно.

Поддержаны service Context dependencies, scoped ресурсы и обычная внутренняя композиция Layer. Среда построения runtime фиксируется при `make`; произвольное распространение Layer-патчей logger/tracer/config-provider/fiber-local state downstream не обещается. Метод сервиса с собственными Effect requirements сохраняет эти requirements.

Release failure остаётся диагностируемой, не выдаётся за успешный Closed и не приводит к автоматическому restart. Для восстановления после такой ошибки нужно исправить внешние ресурсы и создать новый runtime. Ошибка отдельной рабочей fiber сама по себе не равна health invalidation.

В Effect RC составной build Cause не размечает происхождение каждого defect. Комбинации Die с Fail/Interrupt либо нескольких Die консервативно рассматриваются как возможная ошибка rollback и тоже блокируют restart. Сохраняется исходный Cause; цена осторожности — составная acquisition-only ошибка иногда требует нового runtime вместо retry. Решение объяснено в [ADR 0002](docs/adr/0002-generations-and-stop-before-start.md).

Reentrant graph mutation из acquire/release и ожидание собственного Active/Idle из lifecycle callback не поддерживаются. Не используйте их для циклической синхронизации.

## Диагностика и упаковка

`snapshot` и `changes` предоставляют состояния и identities поколений без service objects. `changes` — поток актуального состояния, не аудиторский журнал; версии монотонны. Raw Cause может содержать чувствительные данные: не сериализуйте snapshot целиком в публичные логи; используйте безопасное summary из модуля Snapshot.

Bun собирает ESM bundle с `--target browser --format esm --external effect`, без обязательных platform API в core; TypeScript выпускает declarations. `test:package` упаковывает реальный tarball, устанавливает его во временный независимый TS consumer, проверяет типы и выполняет lifecycle через публичный импорт. Выбор bundle target и проверка на Bun не являются заявлением о проверенной browser-совместимости или всех поддерживаемых Node runtime.

Не входят: multi-provider/failover, optional/OR requirements, zero-downtime replacement, HMR/plugin loader, сеть, БД, UI, распределённые leases и sandbox недоверенного кода.
