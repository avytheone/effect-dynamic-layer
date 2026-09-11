# Совместимость с Effect

## Зафиксированный baseline

| Компонент | Точная версия | Статус |
| --- | --- | --- |
| Effect | `4.0.0-rc.115` | Установлен через Bun; публичные TypeScript-исходники и `package.json` прочитаны из `node_modules/effect` |
| Bun | `1.4.2` | Зафиксирован проектом как package manager, runtime и test runner |
| Compatibility spike | `test/compatibility.test.ts` | Подтверждён координатором: 10/10 tests, 17 expectations, 79 ms |

Выбор release candidate — явное решение проекта, заменяющее исходную рекомендацию handoff использовать Effect 3.x. Пакет не обещает совместимость с Effect 3 и не импортирует `effect/internal/*`.

## Как читать статусы

- **Подтверждено исходниками** — сигнатура или реализация найдена в публичном файле установленного пакета.
- **Подтверждено тестом** — координатор запустил указанный executable spike и сообщил успешный результат.
- **Ожидает исполняемой проверки** — написан или исправлен тест наблюдаемого поведения, но его текущая редакция ещё не запускалась.
- Итоговый прогон: `bun test test/compatibility.test.ts` на Bun `1.4.2` — **10 passed, 0 failed, 17 expect() calls, 79 ms**.
- Первый прогон (9 passed, 1 failed) обнаружил важную семантику: три последовательных отдельных `Effect.scoped` закрывали lease после каждого чтения, а default `idleTimeToLive` у `RcMap` равен zero, поэтому `LayerMap` дал `[1, 2, 3]`. Исправленный тест удерживает два перекрывающихся leases и подтвердил `[1, 1, 2]`; после `invalidate` следующий lease получает новое поколение.

## Матрица spike

| Контракт | Исполняемый сценарий | Текущий статус |
| --- | --- | --- |
| Явные Scope и MemoMap поколения | Один объект `Layer` строится дважды с разными входными `Context`, свежими `Layer.makeMemoMap` и `Scope.make`; получаются разные поколения, оба scope освобождаются отдельно | Подтверждено тестом |
| Успешное acquisition | Ресурс остаётся жив после `Layer.buildWithMemoMap` и освобождается при `Scope.close` | Подтверждено тестом |
| Failed acquisition | Ресурс, приобретённый до типизированной ошибки, освобождается | Подтверждено тестом |
| Interrupted acquisition | Подвешенная сборка прерывается через `Fiber.interrupt`; ранее приобретённый ресурс освобождается, `Exit.hasInterrupts` истинен | Подтверждено тестом |
| Lifetime `forkScoped` | Дочерняя задача переживает завершение acquisition и прерывается при закрытии scope поколения | Подтверждено тестом |
| `SubscriptionRef.changes` | Поток выдаёт начальное значение, затем два обновления; подписчик сигнализирует готовность до записей | Подтверждено тестом |
| Caller Context/Reference | `Effect.forkIn` из caller fiber наследует предоставленные `Context.Service` и override `Context.Reference` | Подтверждено тестом |
| `ScopedRef` | Замена освобождает старый ресурс, но ранее захваченный объект остаётся старым | Подтверждено тестом |
| `LayerMap` | Два перекрывающихся lease делят значение ключа; `invalidate` удаляет его из map, и последующий lease создаёт новое значение | Подтверждено тестом |
| Наличие модулей | Root export содержит `ScopedRef` и `LayerMap`, но не содержит `Reloadable` | Подтверждено исходниками и тестом |

## Публичные API rc.115

Ниже приведены только сигнатуры, найденные в публичных исходниках установленного пакета.

### Context и reference

```ts
const Database = Context.Service<DatabaseShape>("app/Database")

class Config extends Context.Service<Config, ConfigShape>()("app/Config") {}

const CorrelationId = Context.Reference("app/CorrelationId", {
  defaultValue: () => "none"
})

const context = Context.make(Database, database).pipe(
  Context.add(Config, config)
)

const databaseFromContext = Context.get(context, Database)
const databaseFromFiber = yield* Database
```

Строковый `key` задаёт runtime identity. `Context.Reference` имеет ленивое кешируемое default-значение и может быть переопределён через `Effect.provideService`. Значения текущего context наследуются при fork; spike отдельно проверяет это для `forkIn`.

### Явная сборка Layer

```ts
const memoMap = yield* Layer.makeMemoMap
const scope = yield* Scope.make("sequential")
const context = yield* Layer.buildWithMemoMap(layer, memoMap, scope)
yield* Scope.close(scope, Exit.void)
```

Точная uncurried-сигнатура:

```ts
Layer.buildWithMemoMap<ROut, E, RIn>(
  self: Layer.Layer<ROut, E, RIn>,
  memoMap: Layer.MemoMap,
  scope: Scope.Scope
): Effect.Effect<Context.Context<ROut>, E, RIn>
```

Есть и data-last overload: `Layer.buildWithMemoMap(memoMap, scope)(layer)`. `Layer.makeMemoMap` — значение `Effect<MemoMap>`, а не функция. Для каждого нового поколения библиотека должна создавать независимые root MemoMap и closeable Scope. `Layer.forkMemoMap(parent)` предназначен для наследования уже закешированных слоёв и потому не является заменой свежей карте поколения.

Входной context передаётся публично, например:

```ts
const built = Layer.buildWithMemoMap(layer, memoMap, scope).pipe(
  Effect.provide(inputContext)
)
```

### Scope и finalizers

```ts
const scope = yield* Scope.make() // либо "sequential" / "parallel"
yield* Scope.addFinalizer(scope, cleanup)
yield* Scope.close(scope, exit)
```

`Effect.acquireRelease(acquire, release, { interruptible?: boolean })` регистрирует release в текущем scope. `release` имеет тип `(resource, exit) => Effect<unknown, never, R>`: типизированная ошибка release не допускается, но defect остаётся наблюдаемым как Cause.

### Fibers

```ts
const child = yield* Effect.forkChild(work)
const owned = yield* Effect.forkIn(work, ownerScope)
const currentScopeChild = yield* Effect.forkScoped(work)

const exit = yield* Fiber.await(owned) // Exit<A, E>, failure не распространяется
const value = yield* Fiber.join(owned) // A, failure распространяется

yield* Fiber.interrupt(owned)          // прервать и дождаться завершения
```

У `forkChild`, `forkIn` и `forkScoped` есть options `{ startImmediately?: boolean; uninterruptible?: boolean | "inherit" }`. В публичных exports rc.115 функции `interruptFork` нет. Для fire-and-forget interruption нельзя придумывать её сигнатуру; владелец должен либо выполнить `Fiber.interrupt`, либо явно fork-нуть сам effect прерывания с подходящим lifetime.

`forkChild` автоматически supervised родителем. `forkIn` привязывает остановку к переданному scope и подходит для worker, lifetime которого должен быть независим от короткого acquisition fiber. `forkScoped` использует текущий scope, поэтому внутри Layer acquisition привязывается к scope, который Layer предоставляет acquisition.

### Queue и Deferred

```ts
const queue = yield* Queue.unbounded<Message>()
const bounded = yield* Queue.bounded<Message>(capacity)
const accepted = yield* Queue.offer(queue, message) // boolean
const message = yield* Queue.take(queue)
const wasAlreadyDone = yield* Queue.shutdown(queue) // boolean

const deferred = yield* Deferred.make<Value, Error>()
const value = yield* Deferred.await(deferred)
const won = yield* Deferred.succeed(deferred, value) // boolean
const failed = yield* Deferred.fail(deferred, error) // boolean
```

`Queue` в rc имеет два параметра `Queue<A, E>` и умеет завершаться/падать; для обычной controller queue достаточно `E = never`. Boolean от `offer`, `shutdown` и завершения `Deferred` нельзя молча трактовать как подтверждение обработки сообщения: он сообщает состояние самой операции/гонки завершения.

### SubscriptionRef

```ts
const ref = yield* SubscriptionRef.make(initial)
const current = yield* SubscriptionRef.get(ref)
yield* SubscriptionRef.set(ref, next)
const stream = SubscriptionRef.changes(ref)
```

Публичная реализация создаёт `PubSub.unbounded({ replay: 1 })`, публикует initial во время `make`, а изменения сериализует semaphore. Поэтому `changes` предназначен именно для атомарного перехода «текущее значение + будущие изменения» без отдельного `get`, создающего окно подписки. Наблюдаемое поведение всё равно закреплено executable spike.

### Exit, Cause и errors

```ts
const exit = yield* Effect.exit(effect)
if (Exit.isFailure(exit)) {
  const cause = exit.cause
  Exit.hasFails(exit)
  Exit.hasDies(exit)
  Exit.hasInterrupts(exit)
  Cause.findErrorOption(cause)
  Cause.squash(cause)
}
```

`Fiber.await` возвращает `Exit`, `Fiber.join` распространяет Cause. В rc.115 проверки классификации названы `hasFails`, `hasDies`, `hasInterrupts`; переносить по памяти старые singular-имена нельзя.

## Reloadable, ScopedRef и LayerMap

### Reloadable

`src/Reloadable.ts` отсутствует, root `src/index.ts` не экспортирует `Reloadable`. Импорт `effect/Reloadable` для rc.115 не является доступным API. Миграции «просто заменить старый Reloadable новой сигнатурой» нет: модуль удалён из выбранной версии.

### ScopedRef

Доступны:

```ts
ScopedRef.fromAcquire(acquire)
ScopedRef.make(() => value)
ScopedRef.get(ref)
ScopedRef.set(ref, acquireReplacement)
```

`set` приобретает replacement в новом scope, затем закрывает scope старого значения и меняет ссылку под semaphore. Это полезный примитив атомарной замены одного resource-backed значения. Его недостаточно для DynamicLayer: уже работающий consumer, захвативший старый объект, не пересобирается; нет DAG зависимостей, affected closure, stop-before-start поколений, admission/revocation управляемых вызовов и агрегированного состояния графа.

### LayerMap

`LayerMap.make(lookup, options?)` создаёт scoped keyed cache. Публичный объект предоставляет:

```ts
layerMap.get(key): Layer.Layer<I, E>
layerMap.contextEffect(key): Effect.Effect<Context.Context<I>, E, Scope.Scope>
layerMap.contextEffectOption(key)
layerMap.invalidate(key): Effect.Effect<void>
```

Это можно переиспользовать как ориентир для keyed acquisition, ref-counted leases и invalidation. Но ключ LayerMap выбирает один рецепт; API не описывает отдельный изменяемый dependency DAG, каскадную перестройку потребителей, generation identity, stop-before-start по топологии, gates или caller-scoped managed use. `invalidate(key)` само по себе не выражает наши контракты публикации и revocation.

## Точное отображение прежних названий на rc

| Прежнее предположение/название | Effect `4.0.0-rc.115` |
| --- | --- |
| `Context.Tag` / `GenericTag` для нового service key | `Context.Service<Shape>(key)` либо class-style `Context.Service<Self, Shape>()(key)` |
| FiberRef-подобный default context key | `Context.Reference(key, { defaultValue })` |
| `Layer.buildWithMemoMap(layer, memo, scope)` | Сохранено, публичный overload подтверждён |
| `Effect.forkScoped` | Сохранено; возвращает `Fiber` и требует текущий `Scope` |
| Явно owned fork | `Effect.forkIn(effect, scope)` |
| Обычный supervised fork | `Effect.forkChild(effect)` |
| `Fiber.interruptFork` | Отсутствует в публичном API |
| `Reloadable` | Отсутствует в пакете/root exports |
| `ScopedRef` | Присутствует как отдельный публичный модуль |
| `LayerMap` | Присутствует как публичный модуль; в rc не расположен под `unstable/*` |
| `SubscriptionRef.changes` | Функция `SubscriptionRef.changes(ref)`, Stream с replay initial |

## Ограничения результатов

Compatibility spike проверяет примитивы, а не доказывает корректность будущего DynamicRuntime. В частности, наследование caller Context в одном `forkIn` не доказывает, что controller-based admission сохранит context: callback должен запускаться в caller-derived worker, а controller должен только сериализовать решение о допуске. Полная гонка admission/revocation проверяется тестами runtime после реализации.
