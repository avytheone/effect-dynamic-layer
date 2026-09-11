# Статус experimental 0.1.0

Библиотека реализована и проверена локально, включая одобренный clean cutover управления на `Context` services и `LifecycleState`. Публикация npm, deployment и production-интеграции не выполнялись. Исходный договор — `HANDOFF-dynamic-layer.md`; явные уточнения владельца: **Effect RC и Bun** вместо baseline v3/pnpm/Vitest.

## Точные версии

| Компонент | Версия |
|---|---|
| Effect: peer и dev | `4.0.0-rc.115` |
| Bun: package manager, runtime тестов, bundler | `1.4.2` |
| TypeScript | `7.0.2` |
| Biome | `2.5.13` |
| Lefthook, проектная зависимость | `2.1.12` |
| @types/bun | `1.4.2` |
| Доступный Node, не основной проверенный runtime | `24.15.0` |

Effect не встроен в bundle. Peer-диапазон точно ограничен проверенной RC. Проверены npm dist-tags и опубликованный список версий; результаты compatibility spike — в [compatibility.md](compatibility.md).

## Итоговые команды и фактические результаты

После чистого перехода со строковых node ids на service Tags все проверки выполнены повторно. Предыдущая baseline: 63 теста / 208 assertions; текущий результат включает пять дополнительных поведенческих регрессий управления по Tag.

| Команда | Результат |
|---|---|
| `bun install --frozen-lockfile` | Успешно; 12 установок / 47 пакетов, lockfile без изменений, hooks установлены |
| `bun test` | **68 passed, 0 failed, 231 assertions, 11 файлов**, 299 ms |
| `bun run typecheck` | Успешно: core, runtime-тесты, examples и package-check script |
| `bun run test:types` | Успешно: положительные и отрицательные generic-контракты действительно проверены TypeScript |
| `bun run lint` | Успешно: Biome проверил 29 файлов, без исправлений |
| `bun run build` | Успешно: Bun ESM bundle, 8 собственных модулей, 52.42 KB; declarations выпущены TypeScript |
| `bun run test:package` | Успешно: внешний consumer реального tarball импортирует `LifecycleState`, выполняет Tag-based Active → disable → Disabled → enable → Active; strict typecheck и отрицательные внутренние импорты проходят |
| `bun run examples` | Все три примера завершились: basic, effect-factory, failure-and-retry |

Сборка: `--target browser --format esm --external effect`. Это проверенный способ получения ESM без platform API в core, **не заявление о browser runtime compatibility**.

Дополнительные регрессии в `test/tag-control.test.ts` проверяют несовпадающие node id и service key, управление Pending/Disabled, различие отсутствующей и retiring-регистрации, атомарное отклонение несовместимой замены и lifetime ожидания при replace/unregister/re-register. `test-d/api.test-d.ts` отвергает строковые targets для всех шести операций, неизвестное состояние и несовместимый replacement. Строковые перегрузки, `UnknownNode` и `StateTag` удалены; `id` остаётся в описаниях и диагностике.

## Этапы реализации

| Этап | Итог |
|---|---|
| Tooling / Git | Отдельный репозиторий, Bun lockfile, strict TypeScript, Biome, Lefthook, Bun CI |
| 0 — compatibility | 10 исполняемых проверок Scope/MemoMap, cleanup, fibers, SubscriptionRef, Context.Reference, ScopedRef и LayerMap |
| 1 — модель / planner | Immutable Requirement AST, opaque описания, проверка типов и атомарная валидация DAG |
| 2 — acquisition / teardown | Один controller, защищённый completion protocol, generation scopes, borrowed providers, ordered cleanup |
| 3 — граф / гонки | replace/unregister/retry, stale publication guards, retiring reservation, release quarantine |
| 4 — gate / use | Регистрационные watchers, atomic call admission, caller context, scoped children, отмена и диагностика |
| 5 — поставка | Exports, declarations, внешний tarball consumer, три examples, документация и release checklist |

## Матрица обязательных T01–T40

Файлы указаны относительно корня репозитория. Сценарии могут иметь несколько доказательств; номера в названиях тестов позволяют найти конкретный случай. Type-tests не входят в число 68 runtime-тестов.

| ID | Проверенное поведение | Доказательство |
|---|---|---|
| T01 | Простой register → Active, release ровно один раз | `test/lifecycle.test.ts` |
| T02 | Consumer без provider остаётся Pending, acquisition не выполняется | `test/lifecycle.test.ts` |
| T03 | Provider запускает зависимых consumers в нужном порядке | `test/lifecycle.test.ts`, `examples/basic.ts` |
| T04 | После disable ACK вся цепочка недоступна для use до окончания удержанного consumer finalizer; release от view к provider | `test/interop.test.ts`, `test/lifecycle.test.ts` |
| T05 | Повторный enable создаёт новые ids и новые зависимости | `test/lifecycle.test.ts` |
| T06 | Replacement пересобирает consumers, независимая ветка сохраняется | `test/replacement.test.ts` |
| T07 | Настоящий diamond с joining consumer: общий provider один, освобождается последним | `test/lifecycle.test.ts` |
| T08 | Частичный acquisition rollback освобождает ресурсы, публикации нет | `test/lifecycle.test.ts` |
| T09 | Typed failure и defect различимы в Cause и safe summary | `test/errors.test.ts` |
| T10 | Snapshot/duplicate gate/независимые команды не вызывают retry loop | `test/errors.test.ts` |
| T11 | Явный retry и новое поколение нужного provider разрешают новую попытку; посторонняя ветка — нет | `test/errors.test.ts`, `test/interop.test.ts` |
| T12 | False gate запрещает acquisition, true открывает запуск | `test/gates.test.ts` |
| T13 | Duplicate true не перезапускает; false → true создаёт новое поколение | `test/gates.test.ts` |
| T14 | Gate watcher переживает disable, очищается при unregister/shutdown | `test/gates.test.ts`, `test/shutdown.test.ts` |
| T15 | Изменение при подключении gate observer не теряется | `test/gates.test.ts`, `test/compatibility.test.ts` |
| T16 | Удержанный build после disable не публикует старый сервис | `test/replacement.test.ts` |
| T17 | Замена provider во время consumer build оставляет недоступной старую публикацию и запускает новую с новым входом | `test/replacement.test.ts` |
| T18 | Gate cycle инвалидирует build, даже если последнее значение снова true | `test/gates.test.ts` |
| T19 | Быстрые replace/disable/enable сходятся к последнему рецепту | `test/replacement.test.ts` |
| T20 | Controller принимает команды и snapshot при незавершённом acquisition | `test/lifecycle.test.ts` |
| T21 | Provider физически жив во время consumer finalizer | `test/lifecycle.test.ts`, `test/interop.test.ts` |
| T22 | Коллизии и циклы отклоняются атомарно; текущий граф не портится | `test/graph.test.ts`, `test/errors.test.ts` |
| T23 | Retiring id/key зарезервированы до cleanup, затем допускают reuse | `test/replacement.test.ts` |
| T24 | enable/disable/shutdown идемпотентны | `test/shutdown.test.ts` |
| T25 | Один Layer object получает новый dependency Context и fresh MemoMap | `test/replacement.test.ts`, `test/compatibility.test.ts` |
| T26 | Повторный sublayer внутри одного runtime build приобретается/освобождается один раз | `test/interop.test.ts` |
| T27 | Недоступный use не вызывает callback | `test/use.test.ts` |
| T28 | Use при replacement привязан к одному поколению, не переживает его release | `test/use.test.ts` |
| T29 | Публичный snapshot подтверждает живой admission до отмены; tracking и scoped children очищаются. Дополнительно 32 low-quantum cancellation-попытки | `test/ownership-regression.test.ts`, `test/use.test.ts` |
| T30 | Revocation прерывает call, ждёт cleanup и не повторяет бизнес-callback | `test/use.test.ts` |
| T31 | Сохранены caller Service/Context.Reference и дополнительный type requirement | `test/use.test.ts`, `test-d/api.test-d.ts`, `test/compatibility.test.ts` |
| T32 | Scoped worker сервиса жив после acquisition и останавливается до provider finalizer; children callback тоже не утекают | `test/ownership-regression.test.ts`, `test/use.test.ts` |
| T33 | Shutdown при Starting, с gate, конкурентными requests и отменой caller; controller не теряет completion | `test/shutdown.test.ts`, `test/ownership-regression.test.ts` |
| T34 | Release defect и stale rollback defect видны, quarantine не исчезает при командах, ложного Closed нет | `test/errors.test.ts`, `test/ownership-regression.test.ts` |
| T35 | Некооперативный cleanup удерживает Stopping до ручного release барьера | `test/errors.test.ts` |
| T36 | Два runtime с одинаковыми ids/tags независимы | `test/replacement.test.ts` |
| T37 | Missing requirement, неверные acquire/output и unknown widening отвергаются компилятором | `test-d/api.test-d.ts` |
| T38 | Внутренний Layer.provide и runtime-owned Scope не требуют лишних dependencies/casts | `test-d/api.test-d.ts`, examples |
| T39 | 100 полных циклов register/replace/disable/enable/unregister: 300 acquisitions = 300 releases; после shutdown tracked counters равны нулю | `test/shutdown.test.ts` |
| T40 | Waits отменяемы, конкурентно переиспользуемы, завершаются ошибкой после удаления/закрытия | `test/shutdown.test.ts` |

Дополнительные регрессии: синхронный throw callback не оставляет admission; defect finalizer call не теряет tracking; отсутствующий Context.Reference export не подменяется default; concurrent public request admission проверен с малым scheduler quantum.

## Найденные и устранённые проблемы

- Прерывание между завершением user I/O и отправкой build/gate completion оставляло вечный tracked worker. Исправлен ownership protocol: только I/O interruptible, Exit capture и enqueue completion защищены.
- Закрытие execution Scope до выхода controller могло прервать подтверждение второго shutdown caller. Теперь сначала заканчиваются все подтверждения и controller, затем execution Scope.
- Проверка состояния перед асинхронной подготовкой request оставляла pre-enqueue race с shutdown. Финальная проверка состояния и `Queue.offerUnsafe` выполняются одним синхронным шагом после создания reply.
- Scope финализатора call, synchronous callback throw, reused wait effects и release-quarantine получили отдельные регрессии и корректные cleanup paths.
- `LayerMap` с default zero idle TTL не кеширует между неперекрывающимися закрытыми leases; compatibility test исправлен на проверку настоящего lease lifetime.
- Scheduler quantum 1 в выбранной RC не обеспечивал прогресс даже простому Effect без библиотеки. Adversarial-тесты используют проверенный quantum 16; временный baseline probe удалён.

Финальное source-only lifecycle review не оставило существенных замечаний. Это дополняет, но не заменяет исполняемые тесты.

## Уточнения API и честные ограничения

- Effect RC: `Context.Service`, scoped `Layer.effect`, `Layer.unwrap`, fiber-local `Context.Reference`; v3 `Context.Tag` / `Layer.scoped` / `Layer.unwrapEffect` не смешиваются с RC API.
- Одобрен clean cutover: `enable`/`disable`/`retry`/`unregister`/`replace`/`awaitState` принимают `Context` service, без строковых overloads и aliases. `LifecycleState` экспортируется для ожиданий; node `id` остаётся диагностическим metadata snapshots.
- `shutdown` — непрерываемый ordered drain. Timeout/cancellation не отрывают cleanup и не обещают немедленного возврата. `awaitState`/`awaitIdle` отменяемы, snapshot доступен в Closing и terminal state.
- Составной Cause с Die+Fail/Interrupt или несколькими Die консервативно считается потенциальной ошибкой rollback и блокирует restart. Это безопасно, но составная acquisition-only ошибка тоже иногда требует нового runtime. См. ADR 0002.
- `retry` вне non-quarantined Failed — no-op. `awaitIdle` также ждёт managed calls, но не фоновые scoped workers сервиса или gate watchers.
- Статический Context фиксируется при make; произвольные Layer FiberRef/runtime-патчи downstream не обещаются.
- TypeScript не запрещает все service escapes и неучтённые Promise. Некооперативный user code может удерживать Stopping/shutdown.
- Mailbox lossless и без сложного backpressure; snapshots — состояние, не audit log. Raw Cause может содержать чувствительные данные, для логов есть `safeSummary`.
- Не проверены browser runtime, другие Effect RC/major, отдельный Node execution path и удалённый GitHub Actions run. CI workflow настроен, локально его команды выполнены.
- Нет сети, БД, UI, HMR, plugin loader, multi-provider, distributed leases и zero-downtime replacement.

## Release checklist

- [x] Одна реально проверенная линия Effect, без смешения major API.
- [x] Оба конструктора используют единый lifecycle.
- [x] Все graph commands, gates, managed use и ordered shutdown реализованы.
- [x] T01–T40 имеют исполняемые runtime/type доказательства; skipped/todo тестов нет.
- [x] Scope, поколения, caller cancellation, stale publication и release failures проверены.
- [x] Независимые ветви и fresh MemoMap сохраняют нужную семантику.
- [x] TypeScript declarations, examples и внешний consumer реализованы.
- [x] README, semantics, architecture, compatibility, ADR и changelog актуализированы.
- [x] Временные probes и старый `Hello via Bun` entrypoint удалены.
- [x] Пакет остаётся private, experimental 0.1.0; публикация не выполнялась.
