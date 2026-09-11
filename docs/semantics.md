# Семантика DynamicRuntime 0.1

Это договор публичного API. Фактические результаты выполнения сценариев указаны в [status.md](status.md); исходные критерии T01–T40 — в handoff.

## Идентификаторы и адресация

1. **Описание регистрации:** обязательный диагностический node `id`, export key, requirements, gate, recipe revision.
2. **Поколение/попытка:** уникальный монотонный id, Scope, MemoMap, выбранные поколения dependencies, activation/gate epoch.
3. **Публикация:** service key → актуальное полностью построенное Active-поколение.

Публичные `enable`, `disable`, `retry`, `unregister`, `replace` и `awaitState` принимают реальный `Context` service, как и `use`; строковый node `id` не адресует runtime. Controller разрешает service key по полному реестру, а не только по Active publications: Pending, Disabled и retiring-регистрации не становятся ложно «неизвестными». Одновременно зарегистрировать двух providers одного service key нельзя.

Совпадение service object по ссылке не означает тождество поколений. Счётчики не сбрасываются при unregister/register. Опоздавшие build/gate/stop completion сверяются со стабильной записью регистрации и поколением, а не только со строковым `id` или изменяемой revision.

## Состояния узла

| Состояние | Значение |
|---|---|
| Pending | Enabled, но запуск запрещён gate или недоступны required services |
| Starting | Принадлежащая узлу попытка выполняет acquisition |
| Active | Build завершён, поколение актуально и опубликовано |
| Stopping | Публикация отозвана; interruption/join/release ещё не завершились |
| Disabled | Desired enablement выключен и живого поколения больше нет |
| Failed | Диагностируемая ошибка acquisition, gate или release |

Pending различает отсутствующий provider (`MissingService`), неактивный provider (`DependencyNotActive`), ещё не наблюдавшийся gate (`GateInitializing`) и закрытый gate (`GateClosed`). Ошибка зависимости доступна в диагностике самого provider; consumers не получают частичный сервис.

Failed хранит Cause, phase и попытку. Typed failure, defect и interruption не сводятся к строке. Отмена устаревшего build — обычная остановка, не повод для retry loop. Release failure блокирует автоматический restart: состояние внешнего ресурса неизвестно.

## Мутации

| Операция | Применение |
|---|---|
| `register(description)` | Candidate graph проверяется до изменения authoritative state; default enabled |
| `enable(Service)` / `disable(Service)` | Повтор той же команды — no-op |
| `replace(Service, description)` | Тип описания совпадает с service; обязательные metadata `id` и export key сохраняют identity цели; candidate graph проверяется до revocation; новый recipe revision |
| `unregister(Service)` | Немедленно отзывает публикации, оставляет retiring-запись до cleanup |
| `retry(Service)` | Разрешает одну новую failed-acquisition попытку; Active/Pending/Disabled — no-op |

Отсутствующий service key возвращает `ServiceNotRegistered { serviceKey }`. Управляющая команда для уже retiring-записи возвращает `NodeRetiring`; она не маскируется под отсутствие регистрации. Отсутствующие providers в requirements разрешены. Disabled-провайдер всё ещё резервирует export key. Позднее появление provider, замыкающего цикл, отклоняет новую команду, не меняя работающий граф. При retiring повторная регистрация node `id` или export key получает `NodeRetiring`; после cleanup и `awaitIdle()` их можно использовать снова.

Успешный возврат invalidating-команды означает, что вся affected closure уже отозвана. Это включает Starting consumers и admission новых calls. Cleanup ещё может идти. Новый `use` не получает старое поколение после подтверждённого disable/replace/unregister.

## Планирование

```text
validate candidate → apply desired state → revoke affected publications
→ stop consumers/builders/calls → stop provider
→ start eligible provider → publish after revalidation → start consumers
```

Независимые поколения сохраняются. Fresh MemoMap принадлежит поколению, а не всему runtime. Входной Context содержит borrowed реализации выбранных провайдеров; их Layer не приобретает provider повторно.

Failed acquisition на том же fingerprint не повторяется из-за чтения snapshots, duplicate gate event или независимой ветки. Явный retry, replace, смена требуемого provider generation либо реальный activation cycle открывают новую попытку.

## Gate

`SubscriptionRef.changes` обеспечивает начальное значение и последовательность обновлений. Отдельный read перед subscribe не нужен. Gate watchers принадлежат регистрации и живут при Disabled/Pending; смена описания отменяет старую подписку. Устаревшее событие не применяется к новому рецепту.

Доступность — состояние, известное контроллеру после обработки событий. `SubscriptionRef.set` не синхронен с reconcile runtime. После записи следует ждать соответствующего node state, а не считать произвольный `awaitIdle()` подтверждением ещё не принятого внешнего обновления.

## Managed use

Выбор публикации и регистрация call — атомарное admission. Callback вызывается только после него, в наследуемой среде caller. Scope call ограничивает lifetime children. Успех, failure, interruption и отмена до начала callback освобождают tracking.

При revocation callback получает interruption, а не успешное значение. Provider ждёт завершения call и его cleanup. Runtime не повторяет callback на новом поколении. Запрет service escape распространяется на возврат объекта, запись во внешнюю переменную и неучтённые Promise/fibers.

## Барьеры и shutdown

`awaitState(Service, state)` использует константу из замороженного объекта `LifecycleState`; его значения совпадают со строковыми snapshot discriminants. При приёме ожидание закрепляется за выбранной стабильной записью регистрации. `replace` изменяет рецепт той же записи и не обрывает ожидание, а unregister с последующей регистрацией того же service key не может незаметно перенаправить старое ожидание на новый компонент.

`awaitState` сначала проверяет искомый state; ожидание самого `LifecycleState.Failed` допустимо. Failed вместо другого state возвращает диагностируемую ошибку. Никогда не зарегистрированный service key возвращает `ServiceNotRegistered`; удалённая или retiring-запись, для которой состояние уже недостижимо, — `AwaitStateUnavailable { id, expected }`. RuntimeClosing/RuntimeClosed не превращаются в вечное ожидание. `awaitIdle` не требует Active всех узлов и не ждёт обычных долгоживущих worker fibers.

Runtime состояния: Running → Closing → Closed либо CloseFailed. Closing запрещает новые graph commands и admissions, отзывает публикации, но controller продолжает получать lifecycle completion. Providers освобождаются после consumers даже при replacements, изменивших хронологический порядок создания Scope.

Idempotent shutdown ждёт ordered cleanup, завершает control watchers/workers и сохраняет release failure. Owning Scope вызывает тот же путь. Ошибка отдельного finalizer не отменяет попытки очистки независимых узлов; CloseFailed не выдаётся за Closed.

Сам `shutdown` — непрерываемый drain, как освобождение Scope: запрос отмены его caller не уничтожает controller посреди cleanup и наблюдается только после завершения drain. Это также означает, что timeout вокруг shutdown не гарантирует немедленный возврат. `awaitState`/`awaitIdle` остаются отменяемыми. Уже принятые конкурентные shutdown-запросы подтверждаются все; execution Scope закрывается только после выхода controller. Snapshot доступен и во время Closing для диагностики удерживаемых ресурсов.

Публичный Cause не помечает происхождение каждого defect внутри Layer. Комбинация failure/interruption с defect либо нескольких defects при build консервативно трактуется как возможная ошибка rollback: узел помещается в release-quarantine. Это может запретить retry для составной acquisition-only ошибки, но не разрешает restart после потенциально неудачного освобождения. Исходный Cause сохраняется; подробности — в ADR 0002.

Некооперативный JS или uninterruptible Effect могут удерживать Stopping. Timeout не предоставляет права освободить provider под живым consumer. Reentrant lifecycle graph mutation и ожидания собственных Active/Idle не поддерживаются.
