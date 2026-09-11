# Архитектура и владение ресурсами

Ключевое решение: динамична доступность **поколений сервисов**, а не уже выданные JavaScript-ссылки. Описание `DynamicLayer` не является подтипом `Layer` и не владеет живыми ресурсами.

## Границы модулей

- `Requirement` — неизменяемая алгебра Empty/Service/All и реальные service keys; TypeScript union сам по себе не превращается в runtime-граф.
- `DynamicLayer` — типизированный рецепт с проверкой оставшихся внешних входов и совместимости export key. `fromEffect` сводится к обычному scoped Layer.
- `internal/erased` — локальная граница гетерогенного реестра: описания разных сервисов становятся единым runtime-представлением. Публичные generic-контракты не стираются; публикация проверяет наличие заявленного ключа в фактическом output Context.
- `internal/graph` — чистая валидация candidate DAG, топологический порядок и affected closure; не выполняет пользовательский Effect и не владеет Scope.
- `DynamicRuntime` — scoped точка входа в сериализованное управление регистрациями, поколениями, watchers, calls и shutdown.
- `Snapshot` / `Errors` — публичная диагностика состояний и ошибок без выдачи service objects.

## Контур управления

```text
команды ─────────────┐
gate updates ────────┼─→ lossless mailbox → единственный controller
lifecycle completion┘                         │
                          ┌───────────────────┼─────────────────────┐
                          │ desired graph     │ publications        │ generation tracking
                          └───────────────────┼─────────────────────┘
                                              ↓
                                  managed acquire/stop workers
                                              │
                                              └→ completion
```

Controller принимает короткие согласованные решения, а не исполняет acquire/release/callback под глобальным lock. Поэтому disable можно применить во время незавершённого Starting. Публичная команда несёт `Context` service key; controller сам разрешает его по authoritative map всех регистраций, включая Pending, Disabled и retiring, а не по Active publications и не по диагностическому node `id`. Так выбор provider и применение команды остаются одним сериализованным решением. Потеря lifecycle completion недопустима; mailbox первого выпуска не вводит сложный backpressure и может расти, если производитель обгоняет controller. Snapshots — отдельный канал состояния, не аудиторский event log.

## Граф владения

```text
owning Scope
  └─ ordered runtime shutdown
      ├─ controller/control lifetime (жив до последних cleanup completion)
      ├─ registration → gate watcher
      ├─ generation → build fiber + Scope + fresh MemoMap
      │    └─ tracked scoped worker fibers реализации
      └─ managed call → caller-inherited fiber + call Scope + scoped children
```

Required generations удерживаются потребителем с момента фиксации входов, до начала acquisition. Удержание продолжается через failed/stale acquisition rollback и consumer finalizers. Нельзя закрыть provider сразу после revocation: старый consumer может ещё пользоваться его объектом для cleanup.

Для shutdown порядок derives from graph, не из случайного LIFO создания scopes. После replacements порядок создания ресурсов может отличаться от provider → consumer. Controller нельзя автоматически убить owning Scope раньше, чем он получит результаты освобождения ресурсов.

## Публикация и отзыв

Перед build фиксируются стабильная запись регистрации, recipe/activation/gate epoch и provider generation ids. Успешный output ещё не разрешает публикацию: controller повторно проверяет актуальность и наличие заявленного export key. Устаревший результат отправляется в cleanup, не в publications.

Invalidation сначала атомарно удаляет публикации всей affected closure и закрывает admission. Затем прерываются/join-ятся managed calls и builders, закрываются consumers и лишь затем providers. Diamond-provider освобождается один раз после обоих consumers. Следующее поколение узла не запускается до конца cleanup предыдущего. Replacement меняет рецепт той же стабильной записи; unregister завершает её identity, поэтому ожидающий caller не может автоматически переключиться на более позднюю регистрацию того же service key.

## Почему не только ScopedRef / LayerMap

Они уже решают полезные части resourceful references и keyed leases, но не перепривязывают сервисы, захватившие старый provider при acquisition, и не дают автоматически graph-wide revoke + reverse teardown. В выбранной RC `Reloadable` отсутствует. Прямые исполняемые проверки и тонкость zero-TTL `LayerMap` описаны в [compatibility.md](compatibility.md), решение — в [ADR 0003](adr/0003-why-not-only-reloadable.md).

## Подтверждение корректности

Тесты используют публичные операции и управляемые Deferred barriers: удерживают build, callback или finalizer и проверяют admission, порядок cleanup и identity. Scope/MemoMap проверены отдельно до runtime. Type-tests реально исполняются компилятором, включая отрицательные зависимости и output shape. Внешний fixture проверяет собранный tarball, не исходники.

Список инвариантов I1–I12 и обязательных T01–T40 находится в handoff; текущая доказательная матрица — в [status.md](status.md).
