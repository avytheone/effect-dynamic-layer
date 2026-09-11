# ADR 0003: Почему DynamicLayer не сводится к reloadable reference или LayerMap

- Статус: принят
- Дата: 2026-09-11

## Контекст

DynamicLayer управляет изменяемым графом доступных сервисов. При изменении provider нужно вычислить затронутое замыкание consumers, прекратить допуск новых вызовов, остановить старые поколения в обратном топологическом порядке и только затем запускать новые поколения в прямом порядке. Публикация поколения должна быть атомарна относительно controller state, а уже допущенные вызовы должны иметь собственный отслеживаемый lifetime.

Effect предоставляет близкие resource primitives, но их семантика уже этой задачи.

### Reloadable

В установленном `effect@4.0.0-rc.115` нет `src/Reloadable.ts`, и root module не экспортирует `Reloadable`. Следовательно, старый v3 API нельзя использовать или описывать как доступный в этой версии. Compatibility shim не вводится.

### ScopedRef

`ScopedRef.fromAcquire` владеет текущим ресурсом, а `ScopedRef.set` приобретает replacement в новом scope, закрывает scope предыдущего значения и меняет ссылку под semaphore. Это решает корректную замену одного resource-backed значения.

Однако consumer, уже получивший старый объект через `ScopedRef.get`, продолжает держать этот объект. Смена ссылки сама по себе:

- не находит зависящие компоненты;
- не запрещает новые управляемые вызовы на время перестройки;
- не ждёт завершения уже допущенных вызовов;
- не реализует обратный stop и прямой start по DAG;
- не публикует состояние `Pending / Starting / Running / Stopping / Failed / Closed`;
- не отличает identity рецепта от identity поколения.

### LayerMap

`LayerMap.make(lookup, options?)` строит keyed cache поверх `RcMap`. `contextEffect(key)` выдаёт scoped lease, `get(key)` — Layer для такого lease, а `invalidate(key)` удаляет entry из map и позволяет последующему обращению создать новое значение.

Существенная деталь rc.115: если `idleTimeToLive` не задан, `RcMap` использует `Duration.zero`. Когда scope последнего lease закрывается, entry немедленно освобождается и удаляется. Поэтому последовательные отдельные `Effect.scoped(layerMap.contextEffect(key))` не обязаны вернуть один и тот же объект. Кеширование наблюдается, пока leases перекрываются, либо при явно ненулевом idle TTL. Invalidation занятого entry удаляет его из map, но ресурс прежнего entry живёт до освобождения его leases.

LayerMap полезен как референс для keyed, ref-counted владения, но не задаёт:

- dependency edges и affected closure;
- каскадную invalidation consumers;
- stop-before-start поколений по топологии;
- независимые boolean gates;
- optimistic generation token перед publish;
- caller-context managed use и его admission/revocation protocol;
- единую сериализованную модель состояния графа.

## Решение

Реализовать DynamicRuntime как отдельный controller изменяемого DAG и явных generation scopes.

- Каждый generation получает свежие `Layer.MemoMap` и `Scope.Closeable`.
- Workers принадлежат явным scopes и запускаются через публичный `Effect.forkIn`/`forkScoped` по нужному lifetime.
- Controller сериализует только state transitions и admission decisions; пользовательский callback не выполняется на controller fiber.
- Caller-derived worker сохраняет caller Context/`Context.Reference`; generation lease и admission отслеживаются отдельно.
- Ordered shutdown закрывает поколения в определённом порядке и наблюдает release defects.

`ScopedRef` и `LayerMap` не используются как скрытая замена этой модели. Их отдельные идеи можно переиспользовать только там, где контракт совпадает буквально: scoped ownership одного значения либо keyed lease cache.

## Последствия

Собственный controller сложнее одного вызова `ScopedRef.set` или `LayerMap.invalidate`, но делает явными главные инварианты библиотеки и позволяет тестировать гонки. Мы не зависим от отсутствующего `Reloadable` и не приписываем LayerMap гарантии графовой перестройки, которых в его API нет.

Граница решения проверяется в `test/compatibility.test.ts`; точные версии, сигнатуры и статус прогонов записаны в `docs/compatibility.md`.
