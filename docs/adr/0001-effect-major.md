# ADR 0001: Effect 4 release candidate как единственный baseline

- Статус: принят
- Дата: 2026-09-11

## Контекст

Исходный handoff предлагал Effect 3.x и запрещал неявно устанавливать prerelease. Пользователь явно заменил это ограничение: первая версия библиотеки должна разрабатываться только против опубликованного `effect@4.0.0-rc.115`. Одновременная поддержка API двух major-веток увеличила бы поверхность типов и сделала compatibility spike неоднозначным.

Установленный пакет проверен локально. Он сообщает версию `4.0.0-rc.115`, закрывает `effect/internal/*` через package exports и содержит публичные исходники. Ключевые отличия от предположений handoff: service key создаётся через `Context.Service`, `Reloadable` отсутствует, а `ScopedRef` и `LayerMap` доступны как публичные root exports.

## Решение

1. Поддерживать только точную версию `effect@4.0.0-rc.115` на этапе 0.1.
2. Использовать только exports пакета `effect`; не импортировать `effect/internal/*` и не читать приватный Layer AST в коде библиотеки.
3. Считать локальные публичные исходники установленной версии источником точных сигнатур, а наблюдаемую семантику подтверждать executable compatibility tests на Bun.
4. Не добавлять compatibility aliases для Effect 3 и не заявлять диапазон версий шире реально проверенного.
5. При смене rc или переходе на stable сначала повторять весь compatibility spike, затем менять dependency range и документацию отдельным решением.

## Последствия

Положительные:

- реализация получает одну понятную систему типов и один набор concurrency/resource APIs;
- ошибки миграции обнаруживаются до кода runtime;
- bundle оставляет Effect внешней зависимостью и не включает вторую копию runtime.

Отрицательные:

- rc API может измениться до stable-релиза;
- потребителю нужна та же точная prerelease-версия;
- отсутствие `Reloadable` требует собственной реализации семантики графа, а не адаптера к старому модулю.

## Проверяемые опорные API

- `Context.Service`, `Context.Reference`;
- `Layer.makeMemoMap`, `Layer.buildWithMemoMap`;
- `Scope.make`, `Scope.close`;
- `Effect.forkChild`, `Effect.forkIn`, `Effect.forkScoped`;
- `Fiber.await`, `Fiber.join`, `Fiber.interrupt`;
- `SubscriptionRef.changes`;
- `ScopedRef`, `LayerMap`.

Точные рецепты и статус исполняемых проверок находятся в `docs/compatibility.md`.
