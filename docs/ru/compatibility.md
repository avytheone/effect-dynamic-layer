# Совместимость с Effect

[English](../compatibility.md) | **Русский**

## Проверенная основа

| Компонент | Точная версия | Что подтверждено |
| --- | --- | --- |
| Effect | `4.0.0-rc.115` | Установлен через Bun; публичные исходники TypeScript и `package.json` прочитаны из `node_modules/effect` |
| Bun | `1.4.2` | Проект использует эту версию как диспетчер пакетов, среду выполнения и средство запуска тестов |
| Отдельная проверка совместимости | `test/compatibility.test.ts` | Проверено запуском: 10 из 10 тестов, 17 проверок утверждений, 79 мс |

Проект осознанно выбрал предварительную версию `4.0.0-rc.115` вместо первоначальной рекомендации из документа передачи работ использовать Effect 3.x. Исследование Effect 3 остаётся историческим исходным материалом, но пакет не обещает совместимость с Effect 3 и не импортирует `effect/internal/*`.

## Что означают статусы

- **Подтверждено исходниками** — сигнатура или реализация найдена в публичном файле установленного пакета.
- **Подтверждено тестом** — указанный исполняемый проверочный сценарий успешно запущен.
- **Ожидает исполняемой проверки** — тест наблюдаемого поведения написан или исправлен, но его текущая редакция ещё не запускалась.
- Итоговый запуск `bun test test/compatibility.test.ts` на Bun `1.4.2`: **10 тестов прошли, 0 ошибок, 17 проверок утверждений, 79 мс**.
- Первый запуск дал 9 успешно пройденных тестов и 1 ошибку и выявил важную особенность поведения. Три последовательных отдельных `Effect.scoped` закрывали владение после каждого чтения, а значение `idleTimeToLive` по умолчанию у `RcMap` равно нулю, поэтому `LayerMap` вернул `[1, 2, 3]`. В исправленном тесте одновременно удерживаются два перекрывающихся владения: он подтвердил `[1, 1, 2]`. После `invalidate` следующее владение получает новое поколение.

## Матрица отдельной проверки

| Контракт | Исполняемый сценарий | Текущий статус |
| --- | --- | --- |
| Отдельные Scope и MemoMap для каждого поколения | Один объект `Layer` собирается дважды с разными входными `Context`, свежими `Layer.makeMemoMap` и `Scope.make`; получаются разные поколения, и оба Scope освобождаются независимо | Подтверждено тестом |
| Успешное создание | Ресурс остаётся жив после `Layer.buildWithMemoMap` и освобождается при `Scope.close` | Подтверждено тестом |
| Ошибка при создании | Ресурс, полученный до типизированной ошибки, освобождается | Подтверждено тестом |
| Прерывание создания | Зависшая сборка прерывается через `Fiber.interrupt`; ранее полученный ресурс освобождается, а `Exit.hasInterrupts` возвращает истину | Подтверждено тестом |
| Срок жизни `forkScoped` | Дочерняя задача продолжает работать после завершения создания и прерывается при закрытии Scope поколения | Подтверждено тестом |
| `SubscriptionRef.changes` | Поток сначала выдаёт начальное значение, затем два обновления; подписчик сообщает о готовности до записей | Подтверждено тестом |
| Context/Reference вызывающей стороны | `Effect.forkIn`, запущенный из дочерней задачи вызывающей стороны, наследует предоставленные `Context.Service` и переопределение `Context.Reference` | Подтверждено тестом |
| `ScopedRef` | Замена освобождает старый ресурс, но ранее полученный объект по-прежнему указывает на старое значение | Подтверждено тестом |
| `LayerMap` | Два перекрывающихся владения используют одно значение ключа; `invalidate` удаляет его из карты, и последующее владение создаёт новое значение | Подтверждено тестом |
| Наличие модулей | Корневой экспорт содержит `ScopedRef` и `LayerMap`, но не содержит `Reloadable` | Подтверждено исходниками и тестом |

## Публичные API версии rc.115

Ниже перечислены только сигнатуры, найденные в публичных исходниках установленного пакета.

### Context и Reference

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

Строковый `key` задаёт идентичность во время выполнения. `Context.Reference` получает значение по умолчанию лениво и кеширует его; значение можно переопределить через `Effect.provideService`. Текущий контекст наследуется при создании дочерней задачи. Отдельный проверочный сценарий подтверждает это для `forkIn`.

### Явная сборка Layer

```ts
const memoMap = yield* Layer.makeMemoMap
const scope = yield* Scope.make("sequential")
const context = yield* Layer.buildWithMemoMap(layer, memoMap, scope)
yield* Scope.close(scope, Exit.void)
```

Точная сигнатура без каррирования:

```ts
Layer.buildWithMemoMap<ROut, E, RIn>(
  self: Layer.Layer<ROut, E, RIn>,
  memoMap: Layer.MemoMap,
  scope: Scope.Scope
): Effect.Effect<Context.Context<ROut>, E, RIn>
```

Есть и перегрузка с данными в последнем аргументе: `Layer.buildWithMemoMap(memoMap, scope)(layer)`. `Layer.makeMemoMap` — значение `Effect<MemoMap>`, а не функция. Для каждого нового поколения библиотека должна создавать отдельные корневые MemoMap и закрываемый Scope. `Layer.forkMemoMap(parent)` наследует уже кешированные слои, поэтому не заменяет свежую карту поколения.

Входной контекст можно передать через публичный API, например:

```ts
const built = Layer.buildWithMemoMap(layer, memoMap, scope).pipe(
  Effect.provide(inputContext)
)
```

### Scope и финализаторы

```ts
const scope = yield* Scope.make() // либо "sequential" / "parallel"
yield* Scope.addFinalizer(scope, cleanup)
yield* Scope.close(scope, exit)
```

`Effect.acquireRelease(acquire, release, { interruptible?: boolean })` регистрирует освобождение ресурса в текущем Scope. Функция `release` имеет тип `(resource, exit) => Effect<unknown, never, R>`: типизированная ошибка освобождения невозможна, но дефект остаётся наблюдаемым как Cause.

### Дочерние задачи Fiber

```ts
const child = yield* Effect.forkChild(work)
const owned = yield* Effect.forkIn(work, ownerScope)
const currentScopeChild = yield* Effect.forkScoped(work)

const exit = yield* Fiber.await(owned) // Exit<A, E>, failure не распространяется
const value = yield* Fiber.join(owned) // A, failure распространяется

yield* Fiber.interrupt(owned)          // прервать и дождаться завершения
```

У `forkChild`, `forkIn` и `forkScoped` есть параметры `{ startImmediately?: boolean; uninterruptible?: boolean | "inherit" }`. В публичных экспортируемых значениях rc.115 функции `interruptFork` нет. Для прерывания без ожидания нельзя придумывать её сигнатуру: владелец должен либо выполнить `Fiber.interrupt`, либо явно запустить сам эффект прерывания как дочернюю задачу с подходящим сроком жизни.

`forkChild` автоматически находится под надзором родителя. `forkIn` привязывает остановку к переданному Scope и подходит для рабочей задачи, которая должна жить дольше короткой задачи создания. `forkScoped` использует текущий Scope, поэтому внутри создания Layer задача привязана к Scope, который Layer предоставляет этому созданию.

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

У `Queue` в этой предварительной версии два параметра: `Queue<A, E>`. Очередь умеет завершаться и падать; для обычной очереди управляющего цикла достаточно `E = never`. Логический результат `offer`, `shutdown` или завершения `Deferred` нельзя считать подтверждением обработки сообщения: он описывает только состояние самой операции или гонки завершения.

### SubscriptionRef

```ts
const ref = yield* SubscriptionRef.make(initial)
const current = yield* SubscriptionRef.get(ref)
yield* SubscriptionRef.set(ref, next)
const stream = SubscriptionRef.changes(ref)
```

Публичная реализация создаёт `PubSub.unbounded({ replay: 1 })`, публикует начальное значение во время `make` и сериализует изменения семафором. Поэтому `changes` обеспечивает атомарный переход от текущего значения к будущим изменениям без отдельного `get`, который создал бы окно между чтением и подпиской. Наблюдаемое поведение дополнительно закреплено исполняемым проверочным сценарием.

### Exit, Cause и ошибки

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

`Fiber.await` возвращает `Exit`, а `Fiber.join` распространяет Cause. В rc.115 функции классификации называются `hasFails`, `hasDies` и `hasInterrupts`. Нельзя по памяти переносить сюда старые названия в единственном числе.

## Reloadable, ScopedRef и LayerMap

### Reloadable

Файла `src/Reloadable.ts` нет, а корневой `src/index.ts` не экспортирует `Reloadable`. В rc.115 импорт `effect/Reloadable` недоступен как публичный API. Нельзя перенести старое решение простой заменой сигнатуры Reloadable: модуль удалён из выбранной версии.

### ScopedRef

Доступны следующие операции:

```ts
ScopedRef.fromAcquire(acquire)
ScopedRef.make(() => value)
ScopedRef.get(ref)
ScopedRef.set(ref, acquireReplacement)
```

`set` получает заменяющее значение в новом Scope, затем под защитой семафора закрывает Scope старого значения и меняет ссылку. Этот примитив полезен для атомарной замены одного значения, которое владеет ресурсом. Для DynamicLayer его недостаточно: уже работающий зависимый сервис, сохранивший старый объект, не пересобирается. Здесь нет ориентированного ациклического графа зависимостей, вычисления затронутой части графа, поколений с остановкой перед запуском, допуска и отзыва управляемых вызовов или общего состояния графа.

### LayerMap

`LayerMap.make(lookup, options?)` создаёт кеш по ключу, ресурсы которого живут в Scope. Публичный объект предоставляет:

```ts
layerMap.get(key): Layer.Layer<I, E>
layerMap.contextEffect(key): Effect.Effect<Context.Context<I>, E, Scope.Scope>
layerMap.contextEffectOption(key)
layerMap.invalidate(key): Effect.Effect<void>
```

Этот API можно использовать как ориентир для создания ресурсов по ключу, владений со счётчиком ссылок и сброса значения. Но ключ LayerMap выбирает один способ создания; API не описывает отдельный изменяемый граф зависимостей, каскадную пересборку зависимых сервисов, идентичность поколения, топологический порядок остановки перед запуском, условия запуска или управляемое использование с временем жизни, ограниченным вызывающей стороной. Один вызов `invalidate(key)` не выражает контракты библиотеки на публикацию и отзыв доступа.

## Как прежние названия соотносятся с rc.115

| Прежнее предположение или название | Effect `4.0.0-rc.115` |
| --- | --- |
| `Context.Tag` / `GenericTag` для нового ключа сервиса | `Context.Service<Shape>(key)` либо форма класса `Context.Service<Self, Shape>()(key)` |
| Ключ контекста со значением по умолчанию, похожий на FiberRef | `Context.Reference(key, { defaultValue })` |
| `Layer.buildWithMemoMap(layer, memo, scope)` | Сохранён; публичная перегрузка подтверждена |
| `Effect.forkScoped` | Сохранён; возвращает `Fiber` и требует текущий `Scope` |
| Явно принадлежащая владельцу дочерняя задача | `Effect.forkIn(effect, scope)` |
| Обычная дочерняя задача под надзором | `Effect.forkChild(effect)` |
| `Fiber.interruptFork` | Отсутствует в публичном API |
| `Reloadable` | Отсутствует в пакете и корневых экспортируемых значениях |
| `ScopedRef` | Доступен как отдельный публичный модуль |
| `LayerMap` | Доступен как публичный модуль; в rc он не находится в `unstable/*` |
| `SubscriptionRef.changes` | Функция `SubscriptionRef.changes(ref)`, поток с повтором начального значения |

## Границы сделанных выводов

Отдельная проверка совместимости подтверждает поведение примитивов, но не доказывает корректность всего DynamicRuntime. В частности, наследование контекста вызывающей стороны в одном `forkIn` ещё не доказывает, что допуск через управляющий цикл сохранит этот контекст. Переданная функция должна запускаться в рабочей задаче, созданной из контекста вызывающей стороны, а управляющий цикл должен только последовательно принимать решение о допуске. Полная гонка между допуском и отзывом проверяется тестами DynamicRuntime после реализации.
